import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { PDFParse, PasswordException, InvalidPDFException } from "pdf-parse";

import { BaseFileLoader } from "./BaseFileLoader.js";
import { LocalFileSourceResolver } from "../resolvers/LocalFileSourceResolver.js";
import { MimeType } from "../value-objects/MimeType.js";
import { DocumentType } from "../enums/DocumentType.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { DocumentId } from "../value-objects/DocumentId.js";
import { DocumentName } from "../value-objects/DocumentName.js";
import { DocumentFingerprint } from "../value-objects/DocumentFingerprint.js";
import { DocumentMetadata } from "../value-objects/DocumentMetadata.js";
import { Document } from "../entities/Document.js";
import { InvalidDocumentError } from "../errors/DatasetError.js";

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["pdf"]);

/**
 * Loads a local PDF file into a single Recon-OS {@link Document} entity.
 *
 * **Architecture note — one PDF → one Document:**
 * {@link FileLoader} is a document-level interface whose `load` method returns
 * `Promise<Document>`. Changing this to return multiple documents per source
 * would require a breaking interface change and is out of scope for this issue.
 * Consequently, a PDF with N pages becomes one `Document` whose `content`
 * is the concatenated extracted text from all pages.
 *
 * **Page-level metadata:**
 * Because the `Document` represents the entire PDF (not a single page),
 * storing `pageNumber` would be semantically misleading. Only `totalPages`
 * is recorded in `DocumentMetadata` so that consumers know how many pages
 * were present in the source artifact.
 *
 * ```ts
 * meta.get<number>("totalPages") // → number of pages in the PDF
 * meta.get<string>("title")      // → PDF title if present, else undefined
 * ```
 *
 * **Text extraction:**
 * Uses `pdf-parse` (backed by `pdfjs-dist`) for server-side PDF text
 * extraction. This performs no OCR, image understanding, or layout
 * reconstruction — only the textual content layer embedded in the PDF.
 * Scanned-image PDFs will yield empty or near-empty content.
 *
 * **Error behavior:**
 * - `UnsupportedSourceError` — source cannot be resolved, is a directory,
 *   has a wrong extension, or exceeds `maxFileSizeBytes`.
 * - `InvalidDocumentError` — file is encrypted/password-protected, is a
 *   corrupted or invalid PDF, or the parser encounters a runtime failure.
 *   The original parser error is attached as `cause` for diagnostics.
 *
 * **Memory model:**
 * Inherits `BaseFileLoader`'s configurable `maxFileSizeBytes` guard (default
 * 10 MiB). The size check happens via `stat()` before any buffer is
 * allocated, preventing unbounded memory growth for oversized PDFs.
 *
 * @example
 * ```ts
 * import { PdfFileLoader, DatasetSource, DatasetId } from "@recon-os/core";
 *
 * const loader = new PdfFileLoader();
 * const source = DatasetSource.from("file", "/path/to/report.pdf");
 * const datasetId = DatasetId.from("ds_reports_001");
 *
 * const doc = await loader.load(source, datasetId);
 * console.log(doc.getType());                             // "PDF"
 * console.log(doc.getMetadata().get<number>("totalPages")); // e.g. 12
 * console.log(doc.getContent());                          // extracted text
 * ```
 */
export class PdfFileLoader extends BaseFileLoader {
    /**
     * Creates a new `PdfFileLoader`.
     *
     * @param options.maxFileSizeBytes - Maximum PDF file size in bytes before
     *   the load is rejected with `UnsupportedSourceError`. Defaults to 10 MiB.
     *   The check is performed via `stat()` before any buffer is allocated.
     */
    constructor({ maxFileSizeBytes }: { maxFileSizeBytes?: number } = {}) {
        super(new LocalFileSourceResolver(), { maxFileSizeBytes });
    }

    protected getSupportedExtensions(): ReadonlySet<string> {
        return SUPPORTED_EXTENSIONS;
    }

    protected getMimeType(_ext: string): MimeType {
        return MimeType.from("application/pdf");
    }

    protected getDocumentType(_ext: string): DocumentType {
        return DocumentType.PDF;
    }

    /**
     * Loads a single PDF document from the given source.
     *
     * The pipeline order mirrors `BaseFileLoader`:
     * 1. Resolve source → validated absolute path.
     * 2. Assert supported extension (`.pdf`).
     * 3. Assert file size within `maxFileSizeBytes` (guards before allocation).
     * 4. Read raw bytes and compute SHA-256 fingerprint + `DocumentId`.
     * 5. Parse PDF via `pdf-parse` → extract text + document metadata.
     * 6. Build and return a `Document` entity.
     *
     * Super's `load()` is intentionally not called because it performs a
     * strict UTF-8 decode — PDF is a binary format and would throw
     * `InvalidDocumentError` on binary byte sequences.
     *
     * @throws {UnsupportedSourceError} if source type is not `"file"`, the
     *   path does not exist, is a directory, has a wrong extension, or exceeds
     *   the configured size limit.
     * @throws {InvalidDocumentError} if the PDF is encrypted, corrupted,
     *   or cannot be parsed for any other reason.
     */
    public override async load(source: DatasetSource, datasetId: DatasetId): Promise<Document> {
        // Step 1: resolve → extension is derived from the resolved absolute path,
        // never from the raw source URI (avoids query-string / fragment pollution).
        const resolved = await this.resolver.resolve(source);
        const ext = this.extractExtension(resolved.pathOrLocation);
        this.assertSupportedExtension(ext, resolved.pathOrLocation);

        // Step 2: guard against unbounded memory usage before any allocation.
        await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

        // Step 3: read raw bytes. Fingerprint is computed from the original
        // bytes — before any transformation — matching BaseFileLoader's convention.
        const rawBuffer = await readFile(resolved.pathOrLocation);
        const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
        const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

        // Step 4: parse PDF. Use the typed PDFParse API with LoadParameters.
        // Buffer is auto-converted to Uint8Array by the library constructor,
        // so we can pass it directly via the `data` field.
        let pdfText: string;
        let totalPages: number;
        let pdfTitle: string | undefined;

        const parser = new PDFParse({ data: rawBuffer });
        try {
            // getText() and getInfo() must be called sequentially — not via
            // Promise.all — because the underlying pdfjs-dist worker processes
            // messages serially and concurrent calls on the same PDFParse
            // instance race on shared internal state, causing a DataCloneError.
            const textResult = await parser.getText();
            const infoResult = await parser.getInfo();
            pdfText = textResult.text;
            totalPages = infoResult.total;
            // info.Title is typed as `any` by pdfjs-dist; guard explicitly.
            const rawTitle: unknown = infoResult.info?.Title;
            if (typeof rawTitle === "string") {
                const trimmed = rawTitle.trim();
                pdfTitle = trimmed.length > 0 ? trimmed : undefined;
            }
        } catch (error: unknown) {
            // Distinguish encrypted PDFs from genuinely corrupted/invalid ones
            // for a more informative error message, then surface both as
            // InvalidDocumentError so callers never see raw library exceptions.
            let message: string;
            if (error instanceof PasswordException) {
                message =
                    `PDF file "${resolved.pathOrLocation}" is password-protected and cannot be processed. ` +
                    `Remove the password protection and retry.`;
            } else if (error instanceof InvalidPDFException) {
                message =
                    `PDF file "${resolved.pathOrLocation}" is not a valid PDF document (corrupt or truncated).`;
            } else {
                const detail = error instanceof Error ? error.message : String(error);
                message = `PDF file "${resolved.pathOrLocation}" could not be parsed: ${detail}`;
            }
            throw new InvalidDocumentError(message, { cause: error });
        } finally {
            // Release pdfjs-dist document resources regardless of success/failure.
            await parser.destroy();
        }

        // Step 5: derive MIME type. Prefer resolver-supplied value (e.g. from
        // OS mime-db or Content-Type), fall back to the loader's static mapping.
        const mimeValue = resolved.mediaType ?? this.getMimeType(ext).getValue();
        const mime = MimeType.from(mimeValue);

        const filename = basename(resolved.pathOrLocation);
        const sizeBytes = rawBuffer.byteLength;

        // `pageNumber` is intentionally absent: this Document represents the
        // entire PDF artifact, not an individual page. Storing `pageNumber: 1`
        // would be semantically incorrect.  `totalPages` is meaningful because
        // it describes the source artifact rather than any page slice of it.
        const metadata = DocumentMetadata.from({
            filename,
            extension: ext,
            mimeType: mime.getValue(),
            sourceUri: resolved.uri.getValue(),
            sourcePath: resolved.pathOrLocation,
            sizeBytes,
            totalPages,
            ...(pdfTitle !== undefined ? { title: pdfTitle } : {}),
        });

        const id = DocumentId.from(sha256hex);
        const name = DocumentName.from(filename);

        return new Document({
            id,
            datasetId,
            name,
            type: this.getDocumentType(ext),
            // Empty string is a valid content value (e.g. a blank/scanned PDF).
            content: pdfText,
            fingerprint,
            metadata,
        });
    }
}
