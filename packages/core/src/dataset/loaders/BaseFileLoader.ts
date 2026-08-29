import { readFile, stat } from "node:fs/promises";
import { extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { DatasetId } from "../value-objects/DatasetId.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { DocumentId } from "../value-objects/DocumentId.js";
import { DocumentName } from "../value-objects/DocumentName.js";
import { DocumentFingerprint } from "../value-objects/DocumentFingerprint.js";
import { DocumentMetadata } from "../value-objects/DocumentMetadata.js";
import { MimeType } from "../value-objects/MimeType.js";
import { Document } from "../entities/Document.js";
import { DocumentType } from "../enums/DocumentType.js";
import { InvalidDocumentError, UnsupportedSourceError } from "../errors/DatasetError.js";
import { SourceResolver } from "../interfaces/SourceResolver.js";
import { FileLoader } from "../interfaces/FileLoader.js";

/** Default maximum file size: 10 MiB. */
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Abstract base class for file-based {@link FileLoader} implementations.
 *
 * Encapsulates the shared pipeline common to all local file loaders:
 * source resolution, optional file-size guard, reading raw bytes, computing a
 * content fingerprint, strict UTF-8 decoding, metadata extraction, and
 * constructing a validated {@link Document} entity.
 *
 * **Pipeline order:**
 * 1. Resolve the source to a {@link ResolvedSource} (absolute path + file URI).
 * 2. Derive the file extension from `resolved.pathOrLocation` — a clean,
 *    absolute filesystem path with no query strings or fragments.
 * 3. Validate that the extension is supported.
 * 4. Guard against oversized files by checking `stat().size` before `readFile()`.
 * 5. Read raw bytes and compute SHA-256 fingerprint.
 * 6. Determine MIME type: prefer `resolved.mediaType` when provided by the
 *    resolver; otherwise fall back to the subclass extension mapping.
 * 7. Strict UTF-8 decode and construct the `Document` entity.
 *
 * **Memory model:** `Document.content` is a `string`, so the full file content
 * must reside in memory before a `Document` can be constructed. This class
 * therefore enforces a configurable `maxFileSizeBytes` limit (default 10 MiB):
 * files exceeding the limit are rejected before any buffer allocation, preventing
 * unbounded memory usage while preserving the existing domain contract.
 *
 * **DocumentId:** Derived from the SHA-256 hex digest of the raw file bytes.
 * This makes identity a deterministic function of content — same bytes produce
 * the same `DocumentId`, consistent with the repository's immutable,
 * content-addressed document semantics.
 *
 * Dependency: receives a {@link SourceResolver} via constructor injection.
 */
export abstract class BaseFileLoader implements FileLoader {
    private readonly maxFileSizeBytes: number;

    constructor(
        protected readonly resolver: SourceResolver,
        { maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES }: { maxFileSizeBytes?: number } = {},
    ) {
        this.maxFileSizeBytes = maxFileSizeBytes;
    }

    /**
     * Loads a single document from the given source.
     *
     * Resolution happens first; the file extension is extracted from the resolved
     * absolute path (`resolved.pathOrLocation`), not from the raw source URI.
     *
     * @param source - A `DatasetSource` identifying the file to load.
     * @param datasetId - The dataset this document belongs to.
     * @returns A validated {@link Document} entity.
     * @throws {UnsupportedSourceError} if the extension is not supported, the
     *   source cannot be resolved, or the file exceeds `maxFileSizeBytes`.
     * @throws {InvalidDocumentError} if the file content is not valid UTF-8 or
     *   the document fails domain validation.
     */
    public async load(source: DatasetSource, datasetId: DatasetId): Promise<Document> {
        // Resolution first — extension is derived from the resolved path, so
        // query strings or fragments on the original source cannot corrupt it.
        const resolved = await this.resolver.resolve(source);
        if (resolved.exists === false) {
            throw new UnsupportedSourceError(
                `Local file source "${resolved.pathOrLocation}" does not exist`,
            );
        }
        if (resolved.isDirectory === true) {
            throw new UnsupportedSourceError(
                `Local file source "${resolved.pathOrLocation}" is a directory, not a file`,
            );
        }

        const ext = this.extractExtension(resolved.pathOrLocation);
        this.assertSupportedExtension(ext, resolved.pathOrLocation);

        // Guard against unbounded memory usage before any buffer allocation.
        await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

        const rawBuffer = await readFile(resolved.pathOrLocation);

        // Compute fingerprint from the original bytes — before any string conversion.
        const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
        const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

        // Strict UTF-8 decode — fatal: true throws TypeError on invalid sequences.
        const content = this.decodeUtf8(rawBuffer, resolved.pathOrLocation);

        // Prefer the MIME type provided by the resolver when specific;
        // fall back to subclass extension mapping when missing or generic octet-stream.
        const mimeValue =
            resolved.mediaType && resolved.mediaType !== "application/octet-stream"
                ? resolved.mediaType
                : this.getMimeType(ext).getValue();
        const mime = MimeType.from(mimeValue);

        const docType = this.getDocumentType(ext);
        const filename = basename(resolved.pathOrLocation);
        const sizeBytes = rawBuffer.byteLength;

        const metadata = DocumentMetadata.from({
            filename,
            extension: ext,
            mimeType: mime.getValue(),
            sourceUri: resolved.uri.getValue(),
            sourcePath: resolved.pathOrLocation,
            sizeBytes,
        });

        // DocumentId = SHA-256 hex of raw bytes: deterministic content-addressed identity.
        const id = DocumentId.from(sha256hex);
        const name = DocumentName.from(filename);

        return new Document({
            id,
            datasetId,
            name,
            type: docType,
            content,
            fingerprint,
            metadata,
        });
    }

    /**
     * Returns the set of lowercase file extensions (without leading dot) that
     * this loader handles. Unsupported extensions are rejected before I/O.
     */
    protected abstract getSupportedExtensions(): ReadonlySet<string>;

    /**
     * Maps a supported lowercase extension to its {@link MimeType}.
     *
     * Only called when `resolved.mediaType` is absent. The extension is
     * guaranteed to be in {@link getSupportedExtensions} at call time.
     *
     * @param ext - Lowercase extension without leading dot.
     */
    protected abstract getMimeType(ext: string): MimeType;

    /**
     * Maps a supported lowercase extension to its {@link DocumentType}.
     *
     * @param ext - Lowercase extension without leading dot, guaranteed to be in
     *   {@link getSupportedExtensions}.
     */
    protected abstract getDocumentType(ext: string): DocumentType;

    /**
     * Extracts the lowercase extension (without leading dot) from an absolute
     * filesystem path. Because `pathOrLocation` is always a clean absolute path
     * produced by the resolver, there are no query strings or fragments to strip.
     */
    protected extractExtension(absolutePath: string): string {
        return extname(basename(absolutePath)).replace(/^\./, "").toLowerCase();
    }

    /**
     * Asserts the extension is in the supported set.
     *
     * @throws {UnsupportedSourceError} if extension is empty or not supported.
     */
    protected assertSupportedExtension(ext: string, absolutePath: string): void {
        if (!ext || !this.getSupportedExtensions().has(ext)) {
            const supported = Array.from(this.getSupportedExtensions())
                .map((e) => `.${e}`)
                .join(", ");
            throw new UnsupportedSourceError(
                `Unsupported file extension "${ext ? `.${ext}` : "(none)"}" for source "${absolutePath}". ` +
                `Supported extensions: ${supported}`,
            );
        }
    }

    /**
     * Checks the file size against `maxFileSizeBytes` before allocation.
     *
     * This prevents unbounded memory growth when unexpectedly large files are
     * supplied. The guard uses a separate `stat()` call so that the rejection
     * happens before any buffer is allocated by `readFile()`.
     *
     * @throws {UnsupportedSourceError} if the file exceeds the configured limit.
     */
    protected async assertFileSizeWithinLimit(absolutePath: string): Promise<void> {
        const stats = await stat(absolutePath);
        if (stats.size > this.maxFileSizeBytes) {
            const limitMiB = (this.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
            const actualMiB = (stats.size / (1024 * 1024)).toFixed(1);
            throw new UnsupportedSourceError(
                `File "${absolutePath}" is too large to load (${actualMiB} MiB). ` +
                `Maximum allowed size is ${limitMiB} MiB.`,
            );
        }
    }

    /**
     * Decodes a `Buffer` to a UTF-8 string using strict mode.
     * Uses `TextDecoder` with `{ fatal: true }` so invalid byte sequences throw
     * a `TypeError` rather than being silently replaced with U+FFFD.
     *
     * @throws {InvalidDocumentError} if the buffer contains invalid UTF-8 bytes.
     */
    protected decodeUtf8(buffer: Buffer, sourcePath: string): string {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } catch {
            throw new InvalidDocumentError(
                `File "${sourcePath}" contains invalid UTF-8 byte sequences and cannot be decoded`,
            );
        }
    }
}
