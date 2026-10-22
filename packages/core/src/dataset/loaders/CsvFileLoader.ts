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

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["csv", "tsv"]);

/**
 * Options for configuring {@link CsvFileLoader}.
 */
export interface CsvFileLoaderOptions {
    /** Explicit delimiter (e.g. ',', '\t', ';'). If omitted, automatically detected or inferred from extension. */
    delimiter?: string;
    /** Maximum allowed file size in bytes before rejecting load. Defaults to 10 MiB. */
    maxFileSizeBytes?: number;
    /** Output text representation format: 'table' (Markdown table) or 'records' (structured row entries). Defaults to 'table'. */
    representation?: "table" | "records";
}

/**
 * Parsed tabular result from raw CSV/TSV text.
 */
export interface ParsedCsvTable {
    delimiter: string;
    headers: string[];
    rows: string[][];
    rowCount: number;
    columnCount: number;
}

/**
 * Ingests local CSV and TSV files (.csv, .tsv) into Recon-OS {@link Document} entities.
 *
 * Implements RFC 4180-compliant quote and delimiter parsing, automatic delimiter detection
 * (supporting comma, tab, semicolon, pipe), column header extraction, tabular text synthesis
 * (Markdown table or structured record representations), and comprehensive metadata population.
 */
export class CsvFileLoader extends BaseFileLoader {
    private readonly explicitDelimiter?: string;
    private readonly representation: "table" | "records";

    constructor(options: CsvFileLoaderOptions = {}) {
        super(new LocalFileSourceResolver(), { maxFileSizeBytes: options.maxFileSizeBytes });
        this.explicitDelimiter = options.delimiter;
        this.representation = options.representation ?? "table";
    }

    protected getSupportedExtensions(): ReadonlySet<string> {
        return SUPPORTED_EXTENSIONS;
    }

    protected getMimeType(ext: string): MimeType {
        if (ext === "tsv") {
            return MimeType.from("text/tab-separated-values");
        }
        return MimeType.from("text/csv");
    }

    protected getDocumentType(_ext: string): DocumentType {
        return DocumentType.CSV;
    }

    /**
     * Loads a single CSV or TSV file from the given source into a Document entity.
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
        let rawText: string;
        try {
            rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer);
        } catch (cause) {
            throw new InvalidDocumentError(
                `CSV file "${resolved.pathOrLocation}" contains invalid UTF-8 byte sequences`,
                { cause },
            );
        }

        // Determine delimiter
        const delimiter = this.resolveDelimiter(rawText, ext);

        // Parse CSV/TSV content
        const table = this.parseCsv(rawText, delimiter, resolved.pathOrLocation);

        // Synthesize structured document content
        const content = this.formatTableContent(table);

        // Compute text metrics
        const stats = this.computeTextStats(content);

        const mimeValue =
            resolved.mediaType && resolved.mediaType !== "application/octet-stream"
                ? resolved.mediaType
                : this.getMimeType(ext).getValue();
        const mime = MimeType.from(mimeValue);

        const filename = basename(resolved.pathOrLocation);
        const sizeBytes = rawBuffer.byteLength;

        const metadata = DocumentMetadata.from({
            filename,
            extension: ext,
            mimeType: mime.getValue(),
            sourceUri: resolved.uri.getValue(),
            sourcePath: resolved.pathOrLocation,
            sizeBytes,
            delimiter: table.delimiter,
            rowCount: table.rowCount,
            rows: table.rowCount,
            columnCount: table.columnCount,
            columns: table.headers,
            lines: stats.lines,
            words: stats.words,
            characters: stats.characters,
        });

        const id = DocumentId.from(sha256hex);
        const name = DocumentName.from(filename);

        return new Document({
            id,
            datasetId,
            name,
            type: DocumentType.CSV,
            content,
            fingerprint,
            metadata,
        });
    }

    /**
     * Resolves the appropriate delimiter using explicit option, file extension, or auto-detection.
     */
    protected resolveDelimiter(text: string, ext: string): string {
        if (this.explicitDelimiter) {
            return this.explicitDelimiter;
        }

        if (ext === "tsv") {
            return "\t";
        }

        // Auto-detect among common candidates: comma, tab, semicolon, pipe
        return this.detectDelimiter(text);
    }

    /**
     * Auto-detects delimiter by frequency and consistency scoring on header/first rows.
     */
    protected detectDelimiter(text: string): string {
        if (!text || text.trim().length === 0) {
            return ",";
        }

        const candidates = [",", "\t", ";", "|"];
        const sampleLines = text
            .split(/\r\n|\r|\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .slice(0, 5);

        if (sampleLines.length === 0) {
            return ",";
        }

        let bestDelimiter = ",";
        let bestScore = -1;

        for (const cand of candidates) {
            const counts = sampleLines.map((line) => {
                let inQuote = false;
                let count = 0;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (ch === '"') {
                        inQuote = !inQuote;
                    } else if (!inQuote && ch === cand) {
                        count++;
                    }
                }
                return count;
            });

            const firstCount = counts[0];
            if (firstCount === 0) continue;

            // Consistency across lines
            const isConsistent = counts.every((c) => c === firstCount);
            const totalCount = counts.reduce((sum, c) => sum + c, 0);

            // Score: consistency bonus + total count
            const score = totalCount * (isConsistent ? 2 : 1);
            if (score > bestScore) {
                bestScore = score;
                bestDelimiter = cand;
            }
        }

        return bestDelimiter;
    }

    /**
     * RFC 4180-compliant CSV parser.
     */
    protected parseCsv(text: string, delimiter: string, filePath: string): ParsedCsvTable {
        const rows: string[][] = [];
        let currentRow: string[] = [];
        let currentCell = "";
        let inQuotes = false;
        let i = 0;
        const len = text.length;

        while (i < len) {
            const ch = text[i];

            if (inQuotes) {
                if (ch === '"') {
                    // Check for escaped quote ("")
                    if (i + 1 < len && text[i + 1] === '"') {
                        currentCell += '"';
                        i += 2;
                        continue;
                    } else {
                        // End of quoted field
                        inQuotes = false;
                        i++;
                        continue;
                    }
                } else {
                    currentCell += ch;
                    i++;
                    continue;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                    i++;
                    continue;
                }

                // Check for delimiter match
                if (text.startsWith(delimiter, i)) {
                    currentRow.push(currentCell.trim());
                    currentCell = "";
                    i += delimiter.length;
                    continue;
                }

                // Check for newline (CRLF or LF)
                if (ch === "\r") {
                    currentRow.push(currentCell.trim());
                    currentCell = "";
                    rows.push(currentRow);
                    currentRow = [];
                    i++;
                    if (i < len && text[i] === "\n") {
                        i++;
                    }
                    continue;
                } else if (ch === "\n") {
                    currentRow.push(currentCell.trim());
                    currentCell = "";
                    rows.push(currentRow);
                    currentRow = [];
                    i++;
                    continue;
                }

                currentCell += ch;
                i++;
            }
        }

        if (inQuotes) {
            throw new InvalidDocumentError(
                `Malformed CSV file "${filePath}": unclosed quote encountered at end of file`,
            );
        }

        // Push remaining cell/row if present
        if (currentCell.length > 0 || currentRow.length > 0) {
            currentRow.push(currentCell.trim());
            rows.push(currentRow);
        }

        // Filter out trailing completely empty rows
        while (rows.length > 0 && rows[rows.length - 1].every((c) => c.length === 0)) {
            rows.pop();
        }

        if (rows.length === 0) {
            return {
                delimiter,
                headers: [],
                rows: [],
                rowCount: 0,
                columnCount: 0,
            };
        }

        const headers = rows[0];
        const dataRows = rows.slice(1);

        return {
            delimiter,
            headers,
            rows: dataRows,
            rowCount: dataRows.length,
            columnCount: headers.length,
        };
    }

    /**
     * Formats parsed table into structured text according to configured representation.
     */
    protected formatTableContent(table: ParsedCsvTable): string {
        if (table.headers.length === 0 && table.rows.length === 0) {
            return "";
        }

        if (this.representation === "records") {
            const lines: string[] = [];
            table.rows.forEach((row, rowIndex) => {
                lines.push(`Record ${rowIndex + 1}:`);
                table.headers.forEach((header, colIndex) => {
                    const value = row[colIndex] ?? "";
                    lines.push(`  ${header || `col_${colIndex + 1}`}: ${value}`);
                });
            });
            return lines.join("\n").trim();
        }

        // Default: Markdown table representation
        const sanitizeCell = (val: string): string =>
            val.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");

        const headerLine = `| ${table.headers.map(sanitizeCell).join(" | ")} |`;
        const separatorLine = `| ${table.headers.map(() => "---").join(" | ")} |`;
        const dataLines = table.rows.map((row) => {
            const cells = table.headers.map((_, i) => sanitizeCell(row[i] ?? ""));
            return `| ${cells.join(" | ")} |`;
        });

        return [headerLine, separatorLine, ...dataLines].join("\n").trim();
    }

    /**
     * Memory-efficient single-pass scanner computing lines, words, and characters with O(1) auxiliary space.
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
            } else if (char === " " || char === "\t" || char === "|") {
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
