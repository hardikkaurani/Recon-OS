import { MimeType } from "../value-objects/MimeType.js";
import { DocumentType } from "../enums/DocumentType.js";
import { UnsupportedSourceError } from "../errors/DatasetError.js";
import { BaseFileLoader } from "./BaseFileLoader.js";
import { LocalFileSourceResolver } from "../resolvers/LocalFileSourceResolver.js";

/**
 * MIME types for the extensions supported by this loader.
 * Uses the IANA-registered values per RFC 2046 / RFC 7763.
 */
const MIME_MAP: Readonly<Record<string, string>> = {
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    json: "application/json",
};

/**
 * `DocumentType` enum values for the extensions supported by this loader.
 */
const TYPE_MAP: Readonly<Record<string, DocumentType>> = {
    txt: DocumentType.TEXT,
    md: DocumentType.MARKDOWN,
    markdown: DocumentType.MARKDOWN,
    json: DocumentType.JSON,
};

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(MIME_MAP));

/**
 * Loads local plain-text, Markdown, and JSON files into Recon-OS
 * {@link Document} entities.
 *
 * Supported extensions: `.txt`, `.md`, `.markdown`, `.json`.
 *
 * At this level, all supported formats are read as raw UTF-8 text without
 * format-specific parsing. Specialized loaders (e.g., `MarkdownFileLoader`,
 * `JsonFileLoader`) will extend {@link BaseFileLoader} independently to add
 * format-aware behaviour in future issues.
 *
 * @example
 * ```ts
 * import { LocalFileLoader, DatasetSource, DatasetId } from "@recon-os/core";
 *
 * const loader = new LocalFileLoader();
 * const source = DatasetSource.from("file", "/path/to/notes.md");
 * const datasetId = DatasetId.from("ds_papers_001");
 *
 * try {
 *   const doc = await loader.load(source, datasetId);
 *   console.log(doc.getId().getValue());       // sha256 hex
 *   console.log(doc.getContent());             // raw UTF-8 string
 *   console.log(doc.getFingerprint());         // DocumentFingerprint
 * } catch (err) {
 *   if (err instanceof UnsupportedSourceError) { /* ... *\/ }
 *   if (err instanceof InvalidDocumentError)  { /* ... *\/ }
 * }
 * ```
 */
export class LocalFileLoader extends BaseFileLoader {
    /**
     * Creates a new `LocalFileLoader`.
     *
     * @param options.maxFileSizeBytes - Maximum file size in bytes before load is
     *   rejected. Defaults to 10 MiB. Pass a smaller value in tests.
     */
    constructor({ maxFileSizeBytes }: { maxFileSizeBytes?: number } = {}) {
        super(new LocalFileSourceResolver(), { maxFileSizeBytes });
    }

    protected getSupportedExtensions(): ReadonlySet<string> {
        return SUPPORTED_EXTENSIONS;
    }

    protected getMimeType(ext: string): MimeType {
        const mime = MIME_MAP[ext];
        if (mime === undefined) {
            throw new UnsupportedSourceError(
                `No MIME type mapping for extension "${ext}"`,
            );
        }
        return MimeType.from(mime);
    }

    protected getDocumentType(ext: string): DocumentType {
        const type = TYPE_MAP[ext];
        if (type === undefined) {
            throw new UnsupportedSourceError(
                `No DocumentType mapping for extension "${ext}"`,
            );
        }
        return type;
    }
}
