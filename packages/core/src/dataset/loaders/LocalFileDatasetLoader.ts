import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DatasetLoader, DatasetLoadResult } from "../interfaces/DatasetLoader.js";
import { SourceResolver } from "../interfaces/SourceResolver.js";
import { LocalFileSourceResolver } from "../resolvers/LocalFileSourceResolver.js";
import { Dataset } from "../entities/Dataset.js";
import { Document } from "../entities/Document.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { DatasetName } from "../value-objects/DatasetName.js";
import { DocumentId } from "../value-objects/DocumentId.js";
import { DocumentName } from "../value-objects/DocumentName.js";
import { DocumentFingerprint } from "../value-objects/DocumentFingerprint.js";
import { DocumentType } from "../enums/DocumentType.js";
import { Version } from "../value-objects/Version.js";
import { URI } from "../value-objects/URI.js";
import { InvalidDatasetError } from "../errors/DatasetError.js";
import { ContentHasher } from "../versioning/ContentHasher.js";

export interface LocalFileDatasetLoaderOptions {
  resolver?: SourceResolver;
  maxFileSizeBytes?: number;
}

interface RawDocPayload {
  id: string;
  name?: string;
  type?: DocumentType;
  content?: string;
  fingerprint?: string | null;
}

export class LocalFileDatasetLoader implements DatasetLoader {
  private static readonly DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB default limit
  private readonly resolver: SourceResolver;
  private readonly maxFileSizeBytes: number;

  constructor(options?: LocalFileDatasetLoaderOptions) {
    this.resolver = options?.resolver ?? new LocalFileSourceResolver();
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? LocalFileDatasetLoader.DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  public async load(source: DatasetSource | URI | string): Promise<DatasetLoadResult> {
    const resolved = await this.resolver.resolve(source);
    if (!resolved.exists) {
      throw new InvalidDatasetError(`Dataset source file or path does not exist: "${resolved.pathOrLocation}"`);
    }

    if (resolved.isDirectory) {
      return this.loadFromDirectory(resolved.pathOrLocation, resolved.uri);
    }

    if (resolved.size !== undefined && resolved.size > this.maxFileSizeBytes) {
      throw new InvalidDatasetError(
        `File size (${resolved.size} bytes) exceeds maximum allowed limit (${this.maxFileSizeBytes} bytes)`
      );
    }

    const ext = path.extname(resolved.pathOrLocation).toLowerCase();
    if (ext === ".jsonl" || ext === ".ndjson") {
      return this.loadFromJsonlFile(resolved.pathOrLocation, resolved.uri);
    }

    if (ext === ".json") {
      return this.loadFromJsonManifest(resolved.pathOrLocation, resolved.uri);
    }

    // Default: load single plain file as 1-document dataset
    return this.loadSingleFile(resolved.pathOrLocation, resolved.uri);
  }

  private async loadFromJsonManifest(filePath: string, uri: URI): Promise<DatasetLoadResult> {
    const content = await this.readFileWithLimit(filePath);
    try {
      const parsed = JSON.parse(content);
      if (parsed && parsed.id && parsed.name && Array.isArray(parsed.documents)) {
        let dataset: Dataset;
        try {
          dataset = Dataset.fromJSON(parsed);
        } catch {
          const datasetId = DatasetId.from(parsed.id);
          const datasetName = DatasetName.from(parsed.name);
          const verStr = parsed.version ? String(parsed.version) : "1.0.0";
          const version = Version.from(verStr);
          const sourceUri = parsed.source?.uri ?? uri.getValue();
          const sourceType = parsed.source?.type ?? "file";
          const datasetSource = DatasetSource.from(sourceType, sourceUri);

          dataset = new Dataset({
            id: datasetId,
            name: datasetName,
            version,
            source: datasetSource,
            storagePath: uri,
          });
        }

        const docs = (parsed.documents as RawDocPayload[]).map((d) => this.mapRawDocToEntity(d, dataset.getId()));
        return { dataset, documents: Object.freeze(docs) };
      }
    } catch (err: unknown) {
      if (err instanceof InvalidDatasetError) throw err;
      // Fallback if plain JSON file is not a Recon-OS Dataset JSON
    }

    return this.loadSingleFile(filePath, uri);
  }

  private async loadFromJsonlFile(filePath: string, uri: URI): Promise<DatasetLoadResult> {
    const baseName = path.basename(filePath, path.extname(filePath));
    const datasetId = DatasetId.from(`ds_${baseName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
    const datasetName = DatasetName.from(baseName);
    const datasetSource = DatasetSource.from("file", uri.getValue());

    const documents: Document[] = [];
    const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let lineIndex = 0;
    let totalBytesAccumulated = 0;

    for await (const line of rl) {
      lineIndex++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      totalBytesAccumulated += Buffer.byteLength(trimmed, "utf8");
      if (totalBytesAccumulated > this.maxFileSizeBytes) {
        fileStream.destroy();
        throw new InvalidDatasetError(
          `JSONL file "${path.basename(filePath)}" total content size exceeded maximum allowed limit (${this.maxFileSizeBytes} bytes)`
        );
      }

      try {
        const record = JSON.parse(trimmed) as RawDocPayload;
        const docId = DocumentId.from(record.id ?? `doc_${lineIndex}`);
        const docName = DocumentName.from(record.name ?? `Record ${lineIndex}`);
        const textContent = typeof record.content === "string" ? record.content : JSON.stringify(record);
        const checksum = ContentHasher.hashString(textContent);
        const fingerprint = DocumentFingerprint.from(checksum.getValue());

        const doc = new Document({
          id: docId,
          datasetId,
          name: docName,
          type: record.type ?? DocumentType.TEXT,
          content: textContent,
          fingerprint,
        });

        documents.push(doc);
      } catch (err: unknown) {
        if (err instanceof InvalidDatasetError) throw err;
        // Skip unparseable line
      }
    }

    const dataset = new Dataset({
      id: datasetId,
      name: datasetName,
      version: Version.initial(),
      source: datasetSource,
      storagePath: uri,
    });

    return { dataset, documents: Object.freeze(documents) };
  }

  private async loadFromDirectory(dirPath: string, uri: URI): Promise<DatasetLoadResult> {
    const dirName = path.basename(dirPath);
    const datasetId = DatasetId.from(`ds_${dirName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
    const datasetName = DatasetName.from(dirName);
    const datasetSource = DatasetSource.from("file", uri.getValue());

    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    const documents: Document[] = [];
    let totalDirectoryBytes = 0;

    for (const entry of entries) {
      if (entry.isFile()) {
        const entryPath = path.join(dirPath, entry.name);
        const textContent = await this.readFileWithLimit(entryPath);
        totalDirectoryBytes += Buffer.byteLength(textContent, "utf8");

        if (totalDirectoryBytes > this.maxFileSizeBytes * 5) {
          // Guard against aggregate directory size explosion
          throw new InvalidDatasetError(
            `Directory "${dirName}" aggregate content size exceeded maximum safety limit`
          );
        }

        const checksum = ContentHasher.hashString(textContent);
        const docIdName = path.basename(entry.name, path.extname(entry.name));
        const docId = DocumentId.from(`doc_${docIdName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
        const docName = DocumentName.from(entry.name);
        const docType = this.inferDocumentType(entry.name);

        const doc = new Document({
          id: docId,
          datasetId,
          name: docName,
          type: docType,
          content: textContent,
          fingerprint: DocumentFingerprint.from(checksum.getValue()),
        });

        documents.push(doc);
      }
    }

    const dataset = new Dataset({
      id: datasetId,
      name: datasetName,
      version: Version.initial(),
      source: datasetSource,
      storagePath: uri,
    });

    return { dataset, documents: Object.freeze(documents) };
  }

  private async loadSingleFile(filePath: string, uri: URI): Promise<DatasetLoadResult> {
    const baseName = path.basename(filePath);
    const rawName = path.basename(filePath, path.extname(filePath));
    const datasetId = DatasetId.from(`ds_${rawName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
    const datasetName = DatasetName.from(rawName);
    const datasetSource = DatasetSource.from("file", uri.getValue());

    const textContent = await this.readFileWithLimit(filePath);

    const checksum = ContentHasher.hashString(textContent);
    const docId = DocumentId.from(`doc_${rawName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
    const docName = DocumentName.from(baseName);
    const docType = this.inferDocumentType(baseName);

    const doc = new Document({
      id: docId,
      datasetId,
      name: docName,
      type: docType,
      content: textContent,
      fingerprint: DocumentFingerprint.from(checksum.getValue()),
    });

    const dataset = new Dataset({
      id: datasetId,
      name: datasetName,
      version: Version.initial(),
      source: datasetSource,
      storagePath: uri,
    });

    return { dataset, documents: Object.freeze([doc]) };
  }

  private async readFileWithLimit(filePath: string): Promise<string> {
    const stats = await fsPromises.stat(filePath);
    if (stats.size > this.maxFileSizeBytes) {
      throw new InvalidDatasetError(
        `File "${path.basename(filePath)}" size (${stats.size} bytes) exceeds maximum allowed limit (${this.maxFileSizeBytes} bytes)`
      );
    }

    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let textContent = "";
    let currentBytes = 0;

    for await (const chunk of stream) {
      const chunkStr = String(chunk);
      currentBytes += Buffer.byteLength(chunkStr, "utf8");
      if (currentBytes > this.maxFileSizeBytes) {
        stream.destroy();
        throw new InvalidDatasetError(
          `File "${path.basename(filePath)}" content length exceeded maximum limit (${this.maxFileSizeBytes} bytes)`
        );
      }
      textContent += chunkStr;
    }

    return textContent;
  }

  private inferDocumentType(fileName: string): DocumentType {
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case ".json":
      case ".jsonl":
        return DocumentType.JSON;
      case ".csv":
      case ".tsv":
        return DocumentType.CSV;
      case ".md":
        return DocumentType.MARKDOWN;
      case ".html":
      case ".xml":
        return DocumentType.HTML;
      default:
        return DocumentType.TEXT;
    }
  }

  private mapRawDocToEntity(raw: RawDocPayload, datasetId: DatasetId): Document {
    const checksum = ContentHasher.hashString(raw.content ?? "");
    return new Document({
      id: DocumentId.from(raw.id),
      datasetId,
      name: DocumentName.from(raw.name ?? raw.id),
      type: raw.type ?? DocumentType.TEXT,
      content: raw.content ?? "",
      fingerprint: raw.fingerprint ? DocumentFingerprint.from(raw.fingerprint) : DocumentFingerprint.from(checksum.getValue()),
    });
  }
}
