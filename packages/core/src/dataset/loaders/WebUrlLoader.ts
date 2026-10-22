import { createHash } from "node:crypto";
import { basename } from "node:path";

import { FileLoader } from "../interfaces/FileLoader.js";
import { SourceResolver } from "../interfaces/SourceResolver.js";
import { HttpSourceResolver } from "../resolvers/HttpSourceResolver.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { DocumentId } from "../value-objects/DocumentId.js";
import { DocumentName } from "../value-objects/DocumentName.js";
import { DocumentFingerprint } from "../value-objects/DocumentFingerprint.js";
import { DocumentMetadata } from "../value-objects/DocumentMetadata.js";
import { MimeType } from "../value-objects/MimeType.js";
import { DocumentType } from "../enums/DocumentType.js";
import { Document } from "../entities/Document.js";
import { InvalidDocumentError, UnsupportedSourceError } from "../errors/DatasetError.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_USER_AGENT = "Recon-OS/1.0 (WebUrlLoader)";

/**
 * Configuration options for {@link WebUrlLoader}.
 */
export interface WebUrlLoaderOptions {
    /** Custom source resolver. Defaults to {@link HttpSourceResolver}. */
    resolver?: SourceResolver;
    /** Network request timeout in milliseconds. Defaults to 10,000 ms. */
    timeoutMs?: number;
    /** Custom request headers to include with the HTTP request. */
    headers?: Record<string, string>;
    /** User-Agent header string. Defaults to 'Recon-OS/1.0 (WebUrlLoader)'. */
    userAgent?: string;
    /** Maximum allowed response size in bytes before rejecting. Defaults to 10 MiB. */
    maxFileSizeBytes?: number;
}

/**
 * Ingests documents directly from remote HTTP and HTTPS endpoints.
 *
 * Handles HTTP redirects, response content-type detection, configurable headers and timeouts,
 * captures response headers (ETag, Last-Modified, Content-Type, canonical URL) into {@link DocumentMetadata},
 * and maps HTTP status errors (404, 500, network timeouts) into structured domain errors.
 */
export class WebUrlLoader implements FileLoader {
    private readonly resolver: SourceResolver;
    private readonly timeoutMs: number;
    private readonly customHeaders: Record<string, string>;
    private readonly userAgent: string;
    private readonly maxFileSizeBytes: number;

    constructor(options: WebUrlLoaderOptions = {}) {
        this.resolver = options.resolver ?? new HttpSourceResolver();
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.customHeaders = options.headers ?? {};
        this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
        this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    }

    /**
     * Loads a remote web document from an HTTP/HTTPS URL or DatasetSource.
     */
    public async load(source: DatasetSource | string, datasetId?: DatasetId): Promise<Document> {
        const actualSource =
            typeof source === "string" ? DatasetSource.from("url", source) : source;
        const actualDatasetId = datasetId ?? DatasetId.from("default_web_dataset");

        const resolved = await this.resolver.resolve(actualSource);
        const urlStr = resolved.pathOrLocation;

        const requestHeaders: Record<string, string> = {
            "User-Agent": this.userAgent,
            Accept: "text/html,application/xhtml+xml,application/json,text/plain,text/markdown,*/*;q=0.8",
            ...this.customHeaders,
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
            response = await fetch(urlStr, {
                method: "GET",
                headers: requestHeaders,
                signal: controller.signal,
                redirect: "follow",
            });
        } catch (err: unknown) {
            clearTimeout(timer);
            if (controller.signal.aborted) {
                throw new InvalidDocumentError(
                    `Network timeout fetching URL "${urlStr}" after ${this.timeoutMs}ms`,
                    { cause: err },
                );
            }
            throw new InvalidDocumentError(
                `Network error fetching URL "${urlStr}": ${(err as Error).message}`,
                { cause: err },
            );
        } finally {
            clearTimeout(timer);
        }

        // Validate HTTP response status
        if (!response.ok) {
            if (response.status === 404) {
                throw new InvalidDocumentError(
                    `HTTP request failed with status 404: Not Found for URL "${urlStr}"`,
                );
            }
            if (response.status >= 500) {
                throw new InvalidDocumentError(
                    `HTTP server error with status ${response.status} for URL "${urlStr}"`,
                );
            }
            throw new InvalidDocumentError(
                `HTTP request failed with status ${response.status} for URL "${urlStr}"`,
            );
        }

        // Guard against oversized responses via Content-Length header
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
            const parsedLength = parseInt(contentLengthHeader, 10);
            if (!isNaN(parsedLength) && parsedLength > this.maxFileSizeBytes) {
                const limitMiB = (this.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
                const actualMiB = (parsedLength / (1024 * 1024)).toFixed(1);
                throw new UnsupportedSourceError(
                    `Remote resource at "${urlStr}" is too large to load (${actualMiB} MiB). ` +
                    `Maximum allowed size is ${limitMiB} MiB.`,
                );
            }
        }

        // Read response body as buffer
        const arrayBuffer = await response.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuffer);

        if (rawBuffer.byteLength > this.maxFileSizeBytes) {
            const limitMiB = (this.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
            const actualMiB = (rawBuffer.byteLength / (1024 * 1024)).toFixed(1);
            throw new UnsupportedSourceError(
                `Remote resource at "${urlStr}" is too large to load (${actualMiB} MiB). ` +
                `Maximum allowed size is ${limitMiB} MiB.`,
            );
        }

        const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
        const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

        // Strict UTF-8 decoding with cause preservation
        let content: string;
        try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer);
        } catch (cause) {
            throw new InvalidDocumentError(
                `Web resource from "${urlStr}" contains invalid UTF-8 byte sequences`,
                { cause },
            );
        }

        const rawContentType = response.headers.get("content-type") ?? "text/plain";
        const mediaType = this.extractMediaType(rawContentType);
        const mime = MimeType.from(mediaType);
        const docType = this.inferDocumentType(mediaType, response.url);

        const stats = this.computeTextStats(content);

        const canonicalUrl = response.url || urlStr;
        let filename: string;
        try {
            const parsedCanonical = new URL(canonicalUrl);
            filename = basename(parsedCanonical.pathname) || parsedCanonical.hostname;
        } catch {
            filename = "web_document";
        }

        const metadataRecord: Record<string, unknown> = {
            url: urlStr,
            sourceUri: resolved.uri.getValue(),
            canonicalUrl,
            filename,
            statusCode: response.status,
            contentType: rawContentType,
            mimeType: mime.getValue(),
            sizeBytes: rawBuffer.byteLength,
            lines: stats.lines,
            words: stats.words,
            characters: stats.characters,
        };

        const etag = response.headers.get("etag");
        if (etag) metadataRecord.etag = etag;

        const lastModified = response.headers.get("last-modified");
        if (lastModified) metadataRecord.lastModified = lastModified;

        const metadata = DocumentMetadata.from(metadataRecord);
        const id = DocumentId.from(sha256hex);
        const name = DocumentName.from(filename);

        return new Document({
            id,
            datasetId: actualDatasetId,
            name,
            type: docType,
            content,
            fingerprint,
            metadata,
        });
    }

    /**
     * Extracts pure MIME media type from a Content-Type header (e.g. 'text/html; charset=utf-8' -> 'text/html').
     */
    protected extractMediaType(contentTypeHeader: string): string {
        const parts = contentTypeHeader.split(";");
        const raw = parts[0]?.trim().toLowerCase();
        if (raw && raw.includes("/")) {
            return raw;
        }
        return "text/plain";
    }

    /**
     * Infers DocumentType from MIME type and URL path extension.
     */
    protected inferDocumentType(mediaType: string, urlStr: string): DocumentType {
        if (mediaType === "text/html") return DocumentType.HTML;
        if (mediaType === "application/json" || mediaType === "application/x-ndjson") return DocumentType.JSON;
        if (mediaType === "text/markdown") return DocumentType.MARKDOWN;
        if (mediaType === "text/csv" || mediaType === "text/tab-separated-values") return DocumentType.CSV;
        if (mediaType === "application/pdf") return DocumentType.PDF;

        // Fallback to URL path inspection
        try {
            const pathname = new URL(urlStr).pathname.toLowerCase();
            if (pathname.endsWith(".html") || pathname.endsWith(".htm")) return DocumentType.HTML;
            if (pathname.endsWith(".json")) return DocumentType.JSON;
            if (pathname.endsWith(".md") || pathname.endsWith(".markdown")) return DocumentType.MARKDOWN;
            if (pathname.endsWith(".csv") || pathname.endsWith(".tsv")) return DocumentType.CSV;
            if (pathname.endsWith(".pdf")) return DocumentType.PDF;
        } catch {
            // Ignore URL parsing errors
        }

        return DocumentType.TEXT;
    }

    /**
     * Single-pass memory-efficient scanner computing lines, words, and characters with O(1) space.
     */
    protected computeTextStats(content: string): { lines: number; words: number; characters: number } {
        if (!content || content.length === 0) {
            return { lines: 0, words: 0, characters: 0 };
        }

        let lineCount = 0;
        let wordCount = 0;
        let inWord = false;
        let hasContentOnLine = false;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            if (char === "\n") {
                if (hasContentOnLine || lineCount === 0) {
                    lineCount++;
                }
                hasContentOnLine = false;
                inWord = false;
            } else if (char === "\r") {
                if (content[i + 1] !== "\n") {
                    if (hasContentOnLine || lineCount === 0) {
                        lineCount++;
                    }
                    hasContentOnLine = false;
                    inWord = false;
                }
            } else if (char === " " || char === "\t") {
                inWord = false;
            } else {
                hasContentOnLine = true;
                if (!inWord) {
                    wordCount++;
                    inWord = true;
                }
            }
        }

        if (hasContentOnLine) {
            lineCount++;
        }

        return {
            lines: lineCount,
            words: wordCount,
            characters: content.length,
        };
    }
}
