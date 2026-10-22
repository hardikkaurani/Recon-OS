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
import { Document } from "../entities/Document.js";
import { InvalidDocumentError } from "../errors/DatasetError.js";

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm"]);

/**
 * Metadata extracted from HTML documents.
 */
export interface ExtractedHtmlMetadata {
    title?: string;
    description?: string;
    keywords?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogType?: string;
    ogUrl?: string;
}

/**
 * Text statistics extracted from sanitized document content.
 */
export interface HtmlTextStats {
    lines: number;
    words: number;
    characters: number;
}

/**
 * Ingests local HTML files (.html, .htm) into Recon-OS {@link Document} entities.
 *
 * Strips script, style, nav, and footer boilerplate elements, extracts rich metadata
 * (<title>, meta description, keywords, OpenGraph tags), converts DOM text into clean
 * prose, and calculates memory-efficient text metrics.
 */
export class HtmlFileLoader extends BaseFileLoader {
    constructor({ maxFileSizeBytes }: { maxFileSizeBytes?: number } = {}) {
        super(new LocalFileSourceResolver(), { maxFileSizeBytes });
    }

    protected getSupportedExtensions(): ReadonlySet<string> {
        return SUPPORTED_EXTENSIONS;
    }

    protected getMimeType(_ext: string): MimeType {
        return MimeType.from("text/html");
    }

    protected getDocumentType(_ext: string): DocumentType {
        return DocumentType.HTML;
    }

    /**
     * Loads a single HTML document from the given source.
     */
    public override async load(source: DatasetSource, datasetId: DatasetId): Promise<Document> {
        const resolved = await this.resolver.resolve(source);
        const ext = this.extractExtension(resolved.pathOrLocation);
        this.assertSupportedExtension(ext, resolved.pathOrLocation);

        await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

        const rawBuffer = await readFile(resolved.pathOrLocation);
        const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
        const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

        // Strict UTF-8 decoding with cause preservation
        let rawHtml: string;
        try {
            rawHtml = new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer);
        } catch (cause) {
            throw new InvalidDocumentError(
                `HTML file "${resolved.pathOrLocation}" contains invalid UTF-8 byte sequences`,
                { cause },
            );
        }

        // Extract metadata before stripping tags
        const meta = this.extractHtmlMetadata(rawHtml);

        // Sanitize HTML and extract clean text
        const cleanContent = this.extractCleanText(rawHtml);

        // Compute text metrics with O(1) auxiliary space scanner
        const stats = this.computeTextStats(cleanContent);

        const mimeValue =
            resolved.mediaType && resolved.mediaType !== "application/octet-stream"
                ? resolved.mediaType
                : this.getMimeType(ext).getValue();
        const mime = MimeType.from(mimeValue);

        const filename = basename(resolved.pathOrLocation);
        const sizeBytes = rawBuffer.byteLength;

        const metadataRecord: Record<string, unknown> = {
            filename,
            extension: ext,
            mimeType: mime.getValue(),
            sourceUri: resolved.uri.getValue(),
            sourcePath: resolved.pathOrLocation,
            sizeBytes,
            lines: stats.lines,
            words: stats.words,
            characters: stats.characters,
        };

        if (meta.title) metadataRecord.title = meta.title;
        if (meta.description) metadataRecord.description = meta.description;
        if (meta.keywords) metadataRecord.keywords = meta.keywords;
        if (meta.ogTitle) metadataRecord.ogTitle = meta.ogTitle;
        if (meta.ogDescription) metadataRecord.ogDescription = meta.ogDescription;
        if (meta.ogType) metadataRecord.ogType = meta.ogType;
        if (meta.ogUrl) metadataRecord.ogUrl = meta.ogUrl;

        const metadata = DocumentMetadata.from(metadataRecord);
        const id = DocumentId.from(sha256hex);
        const name = DocumentName.from(filename);

        return new Document({
            id,
            datasetId,
            name,
            type: DocumentType.HTML,
            content: cleanContent,
            fingerprint,
            metadata,
        });
    }

    /**
     * Extracts meta tags and title from HTML string.
     */
    protected extractHtmlMetadata(html: string): ExtractedHtmlMetadata {
        const result: ExtractedHtmlMetadata = {};

        // Extract <title>...</title>
        const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        if (titleMatch && titleMatch[1]) {
            const rawTitle = this.decodeHtmlEntities(titleMatch[1].trim());
            if (rawTitle) {
                result.title = rawTitle.replace(/\s+/g, " ");
            }
        }

        // Match all <meta ...> tags
        const metaTagRegex = /<meta\b([^>]*)>/gi;
        let match: RegExpExecArray | null;

        while ((match = metaTagRegex.exec(html)) !== null) {
            const attrs = match[1];
            const nameMatch = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs);
            const propMatch = /\bproperty\s*=\s*["']([^"']+)["']/i.exec(attrs);
            const contentMatch = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(attrs);

            const content = contentMatch ? this.decodeHtmlEntities(contentMatch[1].trim()) : "";
            if (!content) continue;

            const name = nameMatch ? nameMatch[1].toLowerCase() : "";
            const prop = propMatch ? propMatch[1].toLowerCase() : "";

            if (name === "description" && !result.description) {
                result.description = content;
            } else if (name === "keywords" && !result.keywords) {
                result.keywords = content;
            } else if (prop === "og:title" && !result.ogTitle) {
                result.ogTitle = content;
            } else if (prop === "og:description" && !result.ogDescription) {
                result.ogDescription = content;
            } else if (prop === "og:type" && !result.ogType) {
                result.ogType = content;
            } else if (prop === "og:url" && !result.ogUrl) {
                result.ogUrl = content;
            }
        }

        return result;
    }

    /**
     * Strips boilerplate tags (head, scripts, styles, nav, footer, noscript, svg, comments)
     * and extracts readable text from HTML markup.
     */
    protected extractCleanText(html: string): string {
        // 1. Remove comments
        let cleaned = html.replace(/<!--[\s\S]*?-->/g, " ");

        // 2. Remove boilerplate tags with their content
        const boilerplateTags = ["head", "script", "style", "nav", "footer", "noscript", "svg"];
        for (const tag of boilerplateTags) {
            const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
            cleaned = cleaned.replace(regex, " ");
        }

        // 3. Convert block-level elements and line breaks to newlines
        cleaned = cleaned.replace(
            /<\/?(?:p|div|h[1-6]|li|tr|section|article|blockquote|header|aside|pre|table|br|hr)\b[^>]*>/gi,
            "\n",
        );

        // 4. Strip remaining HTML tags (inline tags: b, i, a, span, code, etc.)
        cleaned = cleaned.replace(/<[^>]+>/g, "");

        // 5. Decode HTML entities
        cleaned = this.decodeHtmlEntities(cleaned);

        // 6. Fix whitespace before punctuation
        cleaned = cleaned.replace(/[ \t]+([.,;:!?])/g, "$1");

        // 7. Normalize whitespace per line and collapse excess blank lines
        const rawLines = cleaned.split(/\r\n|\r|\n/);
        const normalizedLines: string[] = [];
        let consecutiveEmpty = 0;

        for (const line of rawLines) {
            const trimmed = line.replace(/[ \t]+/g, " ").trim();
            if (trimmed.length > 0) {
                normalizedLines.push(trimmed);
                consecutiveEmpty = 0;
            } else if (consecutiveEmpty < 1 && normalizedLines.length > 0) {
                normalizedLines.push("");
                consecutiveEmpty++;
            }
        }

        return normalizedLines.join("\n").trim();
    }

    /**
     * Decodes common named, decimal, and hex HTML entities.
     */
    protected decodeHtmlEntities(str: string): string {
        if (!str.includes("&")) return str;

        return str
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&#(\d+);/g, (_, dec) => {
                const code = parseInt(dec, 10);
                return code ? String.fromCharCode(code) : "";
            })
            .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
                const code = parseInt(hex, 16);
                return code ? String.fromCharCode(code) : "";
            });
    }

    /**
     * Memory-efficient single-pass scanner computing lines, words, and characters with O(1) auxiliary space.
     */
    protected computeTextStats(content: string): HtmlTextStats {
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
                // handle standalone CR
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
