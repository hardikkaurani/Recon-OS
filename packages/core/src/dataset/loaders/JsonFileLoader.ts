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

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["json", "jsonl", "ndjson"]);

/**
 * Options for configuring `JsonFileLoader`.
 */
export interface JsonFileLoaderOptions {
  /**
   * Dot-notation path (e.g. "body.text") or RFC 6901 JSON pointer (e.g. "/body/text")
   * to target specific text fields as document content.
   */
  contentKey?: string;
  /**
   * Dot-notation path or RFC 6901 JSON pointer to target an object whose fields
   * should be merged into DocumentMetadata.
   */
  metadataKey?: string;
  /**
   * Maximum file size in bytes before load is rejected (default 10 MiB).
   */
  maxFileSizeBytes?: number;
}

/**
 * Navigates a nested JSON object using dot notation or RFC 6901 JSON Pointer.
 */
function extractPathValue(obj: unknown, keyPath: string): unknown {
  if (obj === null || typeof obj !== "object") {
    return undefined;
  }

  const segments = keyPath.startsWith("/")
    ? keyPath
        .slice(1)
        .split("/")
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    : keyPath.split(".");

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Ingests JSON and JSONL (line-delimited JSON) files into Recon-OS {@link Document} entities.
 *
 * Supports key-path extraction (dot notation & RFC 6901 JSON pointers), structured schema
 * detection, and granular record decomposition into individual Document entities.
 */
export class JsonFileLoader extends BaseFileLoader {
  private readonly contentKey?: string;
  private readonly metadataKey?: string;

  constructor({ contentKey, metadataKey, maxFileSizeBytes }: JsonFileLoaderOptions = {}) {
    super(new LocalFileSourceResolver(), { maxFileSizeBytes });
    this.contentKey = contentKey;
    this.metadataKey = metadataKey;
  }

  protected getSupportedExtensions(): ReadonlySet<string> {
    return SUPPORTED_EXTENSIONS;
  }

  protected getMimeType(ext: string): MimeType {
    if (ext === "jsonl" || ext === "ndjson") {
      return MimeType.from("application/x-ndjson");
    }
    return MimeType.from("application/json");
  }

  protected getDocumentType(_ext: string): DocumentType {
    return DocumentType.JSON;
  }

  /**
   * Decodes raw bytes to strict UTF-8 text, preserving the underlying error as cause.
   */
  protected override decodeUtf8(buffer: Buffer, sourcePath: string): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (err) {
      throw new InvalidDocumentError(
        `File "${sourcePath}" contains invalid UTF-8 byte sequences and cannot be decoded`,
        { cause: err },
      );
    }
  }

  /**
   * Loads a JSON or JSONL file into a single aggregate Document entity.
   */
  public override async load(source: DatasetSource, datasetId: DatasetId): Promise<Document> {
    const resolved = await this.resolver.resolve(source);
    const ext = this.extractExtension(resolved.pathOrLocation);
    this.assertSupportedExtension(ext, resolved.pathOrLocation);

    await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

    const rawBuffer = await readFile(resolved.pathOrLocation);
    const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
    const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

    let rawText = this.decodeUtf8(rawBuffer, resolved.pathOrLocation);
    // Strip UTF-8 BOM if present
    if (rawText.charCodeAt(0) === 0xfeff) {
      rawText = rawText.slice(1);
    }

    const filename = basename(resolved.pathOrLocation);
    const isJsonLines = ext === "jsonl" || ext === "ndjson";

    if (isJsonLines) {
      return this.loadJsonLinesDocument({
        rawText,
        sourceUri: resolved.uri.getValue(),
        sourcePath: resolved.pathOrLocation,
        filename,
        ext,
        sizeBytes: rawBuffer.byteLength,
        sha256hex,
        fingerprint,
        datasetId,
      });
    }

    return this.loadStandardJsonDocument({
      rawText,
      sourceUri: resolved.uri.getValue(),
      sourcePath: resolved.pathOrLocation,
      filename,
      ext,
      sizeBytes: rawBuffer.byteLength,
      sha256hex,
      fingerprint,
      datasetId,
    });
  }

  /**
   * Decomposes a JSON array or JSONL file into multiple distinct Document entities.
   * Single JSON objects produce a single-element array.
   */
  public async loadRecords(source: DatasetSource, datasetId: DatasetId): Promise<Document[]> {
    const resolved = await this.resolver.resolve(source);
    const ext = this.extractExtension(resolved.pathOrLocation);
    this.assertSupportedExtension(ext, resolved.pathOrLocation);

    await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

    const rawBuffer = await readFile(resolved.pathOrLocation);
    const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");

    let rawText = this.decodeUtf8(rawBuffer, resolved.pathOrLocation);
    if (rawText.charCodeAt(0) === 0xfeff) {
      rawText = rawText.slice(1);
    }

    const filename = basename(resolved.pathOrLocation);
    const isJsonLines = ext === "jsonl" || ext === "ndjson";

    if (isJsonLines) {
      const lines = rawText.split(/\r?\n/);
      const records: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line.length === 0) continue;
        try {
          records.push(JSON.parse(line));
        } catch (err) {
          throw new InvalidDocumentError(
            `Malformed JSONL line ${i + 1} in file "${resolved.pathOrLocation}"`,
            { cause: err },
          );
        }
      }

      return records.map((record, index) =>
        this.createRecordDocument({
          record,
          index,
          totalRecords: records.length,
          fileSha256: sha256hex,
          filename,
          sourceUri: resolved.uri.getValue(),
          sourcePath: resolved.pathOrLocation,
          datasetId,
        }),
      );
    }

    // Standard JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new InvalidDocumentError(
        `Malformed JSON in file "${resolved.pathOrLocation}"`,
        { cause: err },
      );
    }

    if (Array.isArray(parsed)) {
      return parsed.map((record, index) =>
        this.createRecordDocument({
          record,
          index,
          totalRecords: parsed.length,
          fileSha256: sha256hex,
          filename,
          sourceUri: resolved.uri.getValue(),
          sourcePath: resolved.pathOrLocation,
          datasetId,
        }),
      );
    }

    // Single JSON object
    const singleDoc = await this.load(source, datasetId);
    return [singleDoc];
  }

  private loadStandardJsonDocument(params: {
    rawText: string;
    sourceUri: string;
    sourcePath: string;
    filename: string;
    ext: string;
    sizeBytes: number;
    sha256hex: string;
    fingerprint: DocumentFingerprint;
    datasetId: DatasetId;
  }): Document {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.rawText);
    } catch (err) {
      throw new InvalidDocumentError(
        `Malformed JSON in file "${params.sourcePath}"`,
        { cause: err },
      );
    }

    let content: string;
    if (this.contentKey) {
      const extracted = extractPathValue(parsed, this.contentKey);
      content =
        typeof extracted === "string"
          ? extracted
          : extracted !== undefined
            ? JSON.stringify(extracted)
            : "";
    } else if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (typeof (parsed as Record<string, unknown>).text === "string" ||
        typeof (parsed as Record<string, unknown>).content === "string" ||
        typeof (parsed as Record<string, unknown>).body === "string")
    ) {
      const obj = parsed as Record<string, unknown>;
      content = (obj["text"] ?? obj["content"] ?? obj["body"]) as string;
    } else {
      content = params.rawText;
    }

    let customMeta: Record<string, unknown> = {};
    if (this.metadataKey) {
      const extractedMeta = extractPathValue(parsed, this.metadataKey);
      if (typeof extractedMeta === "object" && extractedMeta !== null) {
        customMeta = extractedMeta as Record<string, unknown>;
      }
    }

    const schemaType = Array.isArray(parsed)
      ? "array"
      : typeof parsed === "object" && parsed !== null
        ? "object"
        : typeof parsed;
    const recordCount = Array.isArray(parsed) ? parsed.length : 1;
    const topLevelKeys =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? Object.keys(parsed)
        : [];

    const metadata = DocumentMetadata.from({
      filename: params.filename,
      extension: params.ext,
      mimeType: this.getMimeType(params.ext).getValue(),
      sourceUri: params.sourceUri,
      sourcePath: params.sourcePath,
      sizeBytes: params.sizeBytes,
      format: "json",
      schemaType,
      recordCount,
      topLevelKeys,
      ...customMeta,
    });

    return new Document({
      id: DocumentId.from(params.sha256hex),
      datasetId: params.datasetId,
      name: DocumentName.from(params.filename),
      type: DocumentType.JSON,
      content,
      fingerprint: params.fingerprint,
      metadata,
    });
  }

  private loadJsonLinesDocument(params: {
    rawText: string;
    sourceUri: string;
    sourcePath: string;
    filename: string;
    ext: string;
    sizeBytes: number;
    sha256hex: string;
    fingerprint: DocumentFingerprint;
    datasetId: DatasetId;
  }): Document {
    const lines = params.rawText.split(/\r?\n/);
    const records: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        throw new InvalidDocumentError(
          `Malformed JSONL line ${i + 1} in file "${params.sourcePath}"`,
          { cause: err },
        );
      }
    }

    let content: string;
    if (this.contentKey) {
      const extractedTexts: string[] = [];
      for (const rec of records) {
        const val = extractPathValue(rec, this.contentKey);
        if (typeof val === "string") {
          extractedTexts.push(val);
        } else if (val !== undefined) {
          extractedTexts.push(JSON.stringify(val));
        }
      }
      content = extractedTexts.join("\n");
    } else {
      content = params.rawText;
    }

    const metadata = DocumentMetadata.from({
      filename: params.filename,
      extension: params.ext,
      mimeType: this.getMimeType(params.ext).getValue(),
      sourceUri: params.sourceUri,
      sourcePath: params.sourcePath,
      sizeBytes: params.sizeBytes,
      format: "jsonl",
      schemaType: "jsonl",
      recordCount: records.length,
    });

    return new Document({
      id: DocumentId.from(params.sha256hex),
      datasetId: params.datasetId,
      name: DocumentName.from(params.filename),
      type: DocumentType.JSON,
      content,
      fingerprint: params.fingerprint,
      metadata,
    });
  }

  private createRecordDocument(params: {
    record: unknown;
    index: number;
    totalRecords: number;
    fileSha256: string;
    filename: string;
    sourceUri: string;
    sourcePath: string;
    datasetId: DatasetId;
  }): Document {
    let content: string;
    if (this.contentKey) {
      const val = extractPathValue(params.record, this.contentKey);
      content = typeof val === "string" ? val : val !== undefined ? JSON.stringify(val) : "";
    } else if (
      typeof params.record === "object" &&
      params.record !== null &&
      (typeof (params.record as Record<string, unknown>).text === "string" ||
        typeof (params.record as Record<string, unknown>).content === "string")
    ) {
      const obj = params.record as Record<string, unknown>;
      content = (obj["text"] ?? obj["content"]) as string;
    } else {
      content = JSON.stringify(params.record);
    }

    let customMeta: Record<string, unknown> = {};
    if (this.metadataKey) {
      const val = extractPathValue(params.record, this.metadataKey);
      if (typeof val === "object" && val !== null) {
        customMeta = val as Record<string, unknown>;
      }
    }

    const recordPayload = JSON.stringify(params.record);
    const recordHash = createHash("sha256")
      .update(`${params.fileSha256}:${params.index}:${recordPayload}`)
      .digest("hex");
    const fingerprint = DocumentFingerprint.from(recordHash, "SHA-256");

    const metadata = DocumentMetadata.from({
      filename: params.filename,
      sourceUri: params.sourceUri,
      sourcePath: params.sourcePath,
      recordIndex: params.index,
      totalRecords: params.totalRecords,
      ...customMeta,
    });

    return new Document({
      id: DocumentId.from(recordHash),
      datasetId: params.datasetId,
      name: DocumentName.from(`${params.filename}#${params.index}`),
      type: DocumentType.JSON,
      content,
      fingerprint,
      metadata,
    });
  }
}
