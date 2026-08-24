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

export class LocalFileDatasetLoader implements DatasetLoader {
  private readonly resolver: SourceResolver;

  constructor(resolver: SourceResolver = new LocalFileSourceResolver()) {
    this.resolver = resolver;
  }

  public async load(source: DatasetSource | URI | string): Promise<DatasetLoadResult> {
    const resolved = await this.resolver.resolve(source);
    if (!resolved.exists) {
      throw new InvalidDatasetError(`Dataset source file or path does not exist: "${resolved.pathOrLocation}"`);
    }

    if (resolved.isDirectory) {
      return this.loadFromDirectory(resolved.pathOrLocation, resolved.uri);
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
    const content = await fsPromises.readFile(filePath, "utf8");
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

        const docs = (parsed.documents as any[]).map((d) => this.mapRawDocToEntity(d, dataset.getId()));
        return { dataset, documents: Object.freeze(docs) };
      }
    } catch {
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
    for await (const line of rl) {
      lineIndex++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const record = JSON.parse(trimmed);
        const docId = DocumentId.from(record.id ?? `doc_${lineIndex}`);
        const docName = DocumentName.from(record.name ?? `Record ${lineIndex}`);
        const textContent = typeof record.content === "string" ? record.content : JSON.stringify(record);
        const checksum = ContentHasher.hashString(textContent);
        const fingerprint = DocumentFingerprint.from(checksum.getValue());

        const doc = new Document({
          id: docId,
          datasetId,
          name: docName,
          type: (record.type as DocumentType) ?? DocumentType.TEXT,
          content: textContent,
          fingerprint,
        });

        documents.push(doc);
      } catch {
        // Skip unparseable line or treat as plain text line
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

    for (const entry of entries) {
      if (entry.isFile()) {
        const entryPath = path.join(dirPath, entry.name);
        const stream = fs.createReadStream(entryPath, { encoding: "utf8" });
        let textContent = "";
        for await (const chunk of stream) {
          textContent += chunk;
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

    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let textContent = "";
    for await (const chunk of stream) {
      textContent += chunk;
    }

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

  private mapRawDocToEntity(raw: any, datasetId: DatasetId): Document {
    const checksum = ContentHasher.hashString(raw.content ?? "");
    return new Document({
      id: DocumentId.from(raw.id),
      datasetId,
      name: DocumentName.from(raw.name ?? raw.id),
      type: (raw.type as DocumentType) ?? DocumentType.TEXT,
      content: raw.content ?? "",
      fingerprint: raw.fingerprint ? DocumentFingerprint.from(raw.fingerprint) : DocumentFingerprint.from(checksum.getValue()),
    });
  }
}
