import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DatasetRepository, DatasetVersionSnapshot } from "../interfaces/DatasetRepository.js";
import { Dataset } from "../entities/Dataset.js";
import { DatasetVersion } from "../entities/DatasetVersion.js";
import { Document } from "../entities/Document.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { Version } from "../value-objects/Version.js";
import { DocumentId } from "../value-objects/DocumentId.js";
import { DocumentName } from "../value-objects/DocumentName.js";
import { DocumentFingerprint } from "../value-objects/DocumentFingerprint.js";
import { Timestamp } from "../value-objects/Timestamp.js";
import { DocumentType } from "../enums/DocumentType.js";
import { InvalidDatasetError } from "../errors/DatasetError.js";
import { ContentHasher } from "../versioning/ContentHasher.js";

interface RawDocumentRecord {
  id: string;
  name?: string;
  type?: DocumentType;
  content?: string;
  fingerprint?: string | null;
}

export class FileDatasetRepository implements DatasetRepository {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    if (!baseDir || typeof baseDir !== "string") {
      throw new InvalidDatasetError("FileDatasetRepository requires a valid baseDir");
    }
    this.baseDir = path.resolve(baseDir);
  }

  public async save(dataset: Dataset, documents?: Iterable<Document>): Promise<void> {
    const datasetDir = this.getDatasetDir(dataset.getId());
    const docsDir = path.join(datasetDir, "documents");
    await fsPromises.mkdir(docsDir, { recursive: true });

    const docList = Array.from(documents ?? []);
    const docIds: string[] = [];

    for (const doc of docList) {
      await this.saveDocumentFile(docsDir, doc);
      docIds.push(doc.getId().getValue());
    }

    const manifestPath = path.join(datasetDir, "manifest.json");
    const manifestPayload = {
      dataset: dataset.toJSON(),
      documentIds: docIds,
      updatedAt: new Date().toISOString(),
    };

    await fsPromises.writeFile(manifestPath, JSON.stringify(manifestPayload, null, 2), "utf8");
  }

  public async findById(id: DatasetId): Promise<Dataset | null> {
    const manifestPath = path.join(this.getDatasetDir(id), "manifest.json");
    try {
      const content = await fsPromises.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(content);
      return Dataset.fromJSON(parsed.dataset);
    } catch {
      return null;
    }
  }

  public async findByVersion(id: DatasetId, version: Version): Promise<DatasetVersionSnapshot | null> {
    const versionPath = path.join(this.getDatasetDir(id), "versions", `${version.getValue()}.json`);
    try {
      const content = await fsPromises.readFile(versionPath, "utf8");
      const parsed = JSON.parse(content);

      const dataset = Dataset.fromJSON(parsed.dataset);
      const datasetVersion = DatasetVersion.snapshot({
        version: Version.from(parsed.version.version),
        datasetId: id,
        description: parsed.version.description ?? null,
        checksum: parsed.version.checksum ? ContentHasher.hashString(parsed.version.checksum) : null,
        documentCount: parsed.version.documentCount ?? 0,
        totalBytes: parsed.version.totalBytes ?? 0,
        isPublished: parsed.version.isPublished ?? true,
        publishedAt: parsed.version.publishedAt ? Timestamp.from(parsed.version.publishedAt) : undefined,
        createdAt: parsed.version.createdAt ? Timestamp.from(parsed.version.createdAt) : undefined,
        documentIds: parsed.version.documentIds ?? [],
      });

      const docs: Document[] = [];
      const docsDir = path.join(this.getDatasetDir(id), "documents");

      if (Array.isArray(parsed.documents)) {
        for (const rawDoc of parsed.documents) {
          docs.push(this.mapRawDoc(rawDoc, id));
        }
      } else if (Array.isArray(parsed.version.documentIds)) {
        for (const docId of parsed.version.documentIds) {
          const doc = await this.readDocumentFile(docsDir, docId, id);
          if (doc) docs.push(doc);
        }
      }

      return { dataset, version: datasetVersion, documents: Object.freeze(docs) };
    } catch {
      return null;
    }
  }

  public async listVersions(id: DatasetId): Promise<DatasetVersion[]> {
    const versionsDir = path.join(this.getDatasetDir(id), "versions");
    try {
      const files = await fsPromises.readdir(versionsDir);
      const versions: DatasetVersion[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = await fsPromises.readFile(path.join(versionsDir, file), "utf8");
          const parsed = JSON.parse(content);
          versions.push(
            DatasetVersion.snapshot({
              version: Version.from(parsed.version.version),
              datasetId: id,
              description: parsed.version.description ?? null,
              checksum: parsed.version.checksum ? ContentHasher.hashString(parsed.version.checksum) : null,
              documentCount: parsed.version.documentCount ?? 0,
              totalBytes: parsed.version.totalBytes ?? 0,
              isPublished: parsed.version.isPublished ?? true,
              documentIds: parsed.version.documentIds ?? [],
            })
          );
        }
      }

      return versions.sort((a, b) => a.getVersion().compare(b.getVersion()));
    } catch {
      return [];
    }
  }

  public async publishVersion(
    dataset: Dataset,
    documents: Iterable<Document>,
    version: Version,
    description?: string
  ): Promise<DatasetVersion> {
    const datasetDir = this.getDatasetDir(dataset.getId());
    const versionsDir = path.join(datasetDir, "versions");
    await fsPromises.mkdir(versionsDir, { recursive: true });

    const versionFile = path.join(versionsDir, `${version.getValue()}.json`);
    try {
      await fsPromises.access(versionFile);
      throw new InvalidDatasetError(
        `Dataset version v${version.getValue()} is already published and immutable`
      );
    } catch (err: unknown) {
      if (err instanceof InvalidDatasetError) {
        throw err;
      }
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        // File does not exist — publishing may proceed.
      } else {
        throw err;
      }
    }

    const docList = Array.from(documents);
    await this.save(dataset, docList);

    const rootChecksum = ContentHasher.hashDataset(dataset, docList);
    const totalBytes = docList.reduce((acc, d) => acc + d.getSize(), 0);
    const documentIds = docList.map((d) => d.getId().getValue());

    const publishedDataset = dataset.withVersion(version);

    const versionSnapshot = DatasetVersion.snapshot({
      version,
      datasetId: dataset.getId(),
      description: description ?? null,
      checksum: rootChecksum,
      documentCount: docList.length,
      totalBytes,
      isPublished: true,
      publishedAt: Timestamp.now(),
      documentIds,
    });

    const snapshotPayload = {
      version: {
        version: version.getValue(),
        datasetId: dataset.getId().getValue(),
        description: description ?? null,
        checksum: rootChecksum.getValue(),
        documentCount: docList.length,
        totalBytes,
        isPublished: true,
        publishedAt: versionSnapshot.getPublishedAt()?.getValue(),
        createdAt: versionSnapshot.getCreatedAt().getValue(),
        documentIds,
      },
      dataset: publishedDataset.toJSON(),
      documents: docList.map((d) => ({
        id: d.getId().getValue(),
        name: d.getName().getValue(),
        type: d.getType(),
        content: d.getContent(),
        fingerprint: d.getFingerprint() ? d.getFingerprint()!.getChecksum() : null,
      })),
    };

    await fsPromises.writeFile(versionFile, JSON.stringify(snapshotPayload, null, 2), "utf8");

    // Make version file read-only on supporting systems if possible
    try {
      await fsPromises.chmod(versionFile, 0o444);
    } catch {
      // Ignore chmod errors on unsupported OS/filesystems
    }

    return versionSnapshot;
  }

  public async exists(id: DatasetId, version?: Version): Promise<boolean> {
    if (version) {
      const versionPath = path.join(this.getDatasetDir(id), "versions", `${version.getValue()}.json`);
      try {
        await fsPromises.access(versionPath);
        return true;
      } catch {
        return false;
      }
    }

    const manifestPath = path.join(this.getDatasetDir(id), "manifest.json");
    try {
      await fsPromises.access(manifestPath);
      return true;
    } catch {
      return false;
    }
  }

  public async delete(id: DatasetId): Promise<boolean> {
    const datasetDir = this.getDatasetDir(id);
    try {
      await fsPromises.rm(datasetDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private getDatasetDir(id: DatasetId): string {
    return path.join(this.baseDir, id.getValue());
  }

  private async saveDocumentFile(docsDir: string, doc: Document): Promise<void> {
    const filePath = path.join(docsDir, `${doc.getId().getValue()}.json`);
    const docPayload = JSON.stringify({
      id: doc.getId().getValue(),
      datasetId: doc.getDatasetId().getValue(),
      name: doc.getName().getValue(),
      type: doc.getType(),
      content: doc.getContent(),
      fingerprint: doc.getFingerprint() ? doc.getFingerprint()!.getChecksum() : null,
    });

    const readStream = Readable.from([docPayload]);
    const writeStream = fs.createWriteStream(filePath, { encoding: "utf8" });
    await pipeline(readStream, writeStream);
  }

  private async readDocumentFile(docsDir: string, docId: string, datasetId: DatasetId): Promise<Document | null> {
    const filePath = path.join(docsDir, `${docId}.json`);
    try {
      const content = await fsPromises.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return this.mapRawDoc(parsed, datasetId);
    } catch {
      return null;
    }
  }

  private mapRawDoc(raw: RawDocumentRecord, datasetId: DatasetId): Document {
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
