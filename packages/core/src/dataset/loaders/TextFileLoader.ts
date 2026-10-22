import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";

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
import { Encoding } from "../value-objects/Encoding.js";
import { Document } from "../entities/Document.js";
import { InvalidDocumentError } from "../errors/DatasetError.js";

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["txt", "log"]);

/**
 * Loads local plain-text files (.txt, .log) into Recon-OS {@link Document} entities.
 *
 * Implements encoding resolution (UTF-8, UTF-16LE, UTF-16BE) with BOM handling
 * and populates text statistics (lines, words, characters, encoding) in {@link DocumentMetadata}.
 */
export class TextFileLoader extends BaseFileLoader {
    /**
     * Creates a new `TextFileLoader`.
     *
     * @param options.maxFileSizeBytes - Maximum file size in bytes before load is rejected.
     *   Defaults to 10 MiB.
     */
    constructor({ maxFileSizeBytes }: { maxFileSizeBytes?: number } = {}) {
        super(new LocalFileSourceResolver(), { maxFileSizeBytes });
    }

    protected getSupportedExtensions(): ReadonlySet<string> {
        return SUPPORTED_EXTENSIONS;
    }

    protected getMimeType(_ext: string): MimeType {
        return MimeType.from("text/plain");
    }

    protected getDocumentType(_ext: string): DocumentType {
        return DocumentType.TEXT;
    }

    /**
     * Loads a plain text file, resolving encoding and collecting structural text statistics.
     */
    public override async load(source: DatasetSource, datasetId: DatasetId): Promise<Document> {
        const resolved = await this.resolver.resolve(source);

        const ext = this.extractExtension(resolved.pathOrLocation);
        this.assertSupportedExtension(ext, resolved.pathOrLocation);

        await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

        const rawBuffer = await readFile(resolved.pathOrLocation);

        const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
        const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

        const { content, encoding } = this.resolveEncodingAndDecode(rawBuffer, resolved.pathOrLocation);
        const { lines, words, characters } = this.computeTextStats(content);

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
            lines,
            words,
            characters,
            encoding: Encoding.from(encoding).getValue(),
        });

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
     * Efficiently scans content to compute line count, word count, and character count
     * in O(N) time and O(1) auxiliary space without intermediate substring allocations.
     * Correctly handles CRLF, LF, CR line endings and trailing newlines.
     */
    private computeTextStats(content: string): { lines: number; words: number; characters: number } {
        const characters = content.length;
        if (characters === 0) {
            return { lines: 0, words: 0, characters: 0 };
        }

        let lineBreaks = 0;
        let words = 0;
        let inWord = false;
        let endsWithLineBreak = false;

        for (let i = 0; i < characters; i++) {
            const code = content.charCodeAt(i);

            if (code === 10) { // \n
                lineBreaks++;
                endsWithLineBreak = true;
            } else if (code === 13) { // \r
                lineBreaks++;
                endsWithLineBreak = true;
                if (i + 1 < characters && content.charCodeAt(i + 1) === 10) {
                    i++;
                }
            } else {
                endsWithLineBreak = false;
            }

            const isWs = code <= 32 || (code >= 0x7f && /\s/.test(content[i]!));
            if (isWs) {
                inWord = false;
            } else if (!inWord) {
                inWord = true;
                words++;
            }
        }

        const lines = endsWithLineBreak ? lineBreaks : lineBreaks + 1;
        return { lines, words, characters };
    }

    /**
     * Resolves file encoding by BOM detection or fallback to strict UTF-8 decoding.
     * Rejects unsupported encodings (UTF-32) and malformed payloads with domain errors.
     */
    private resolveEncodingAndDecode(buffer: Buffer, sourcePath: string): { content: string; encoding: string } {
        // UTF-32LE BOM: 0xFF, 0xFE, 0x00, 0x00 (must be checked before UTF-16LE BOM)
        if (buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xFE && buffer[2] === 0x00 && buffer[3] === 0x00) {
            throw new InvalidDocumentError(`File "${sourcePath}" uses unsupported UTF-32LE encoding`);
        }

        // UTF-32BE BOM: 0x00, 0x00, 0xFE, 0xFF
        if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xFE && buffer[3] === 0xFF) {
            throw new InvalidDocumentError(`File "${sourcePath}" uses unsupported UTF-32BE encoding`);
        }

        // UTF-8 BOM: 0xEF, 0xBB, 0xBF
        if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
            try {
                const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(3));
                return { content, encoding: "utf-8" };
            } catch (cause) {
                throw new InvalidDocumentError(`File "${sourcePath}" has UTF-8 BOM but invalid sequence`, { cause });
            }
        }

        // UTF-16LE BOM: 0xFF, 0xFE
        if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
            const payload = buffer.subarray(2);
            if (payload.length % 2 !== 0) {
                throw new InvalidDocumentError(`File "${sourcePath}" has an invalid UTF-16LE payload`);
            }
            try {
                const content = new TextDecoder("utf-16le", { fatal: true }).decode(payload);
                return { content, encoding: "utf-16le" };
            } catch (cause) {
                throw new InvalidDocumentError(`File "${sourcePath}" has UTF-16LE BOM but invalid sequence`, { cause });
            }
        }

        // UTF-16BE BOM: 0xFE, 0xFF
        if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
            const payload = buffer.subarray(2);
            if (payload.length % 2 !== 0) {
                throw new InvalidDocumentError(`File "${sourcePath}" has an invalid UTF-16BE payload`);
            }
            try {
                const swapped = Buffer.from(payload).swap16();
                const content = new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
                return { content, encoding: "utf-16be" };
            } catch (cause) {
                throw new InvalidDocumentError(`File "${sourcePath}" has UTF-16BE BOM but invalid sequence`, { cause });
            }
        }

        // Default: Strict UTF-8 decode
        try {
            const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            return { content, encoding: "utf-8" };
        } catch (cause) {
            throw new InvalidDocumentError(
                `File "${sourcePath}" contains invalid byte sequences and cannot be decoded as text`,
                { cause },
            );
        }
    }
}
