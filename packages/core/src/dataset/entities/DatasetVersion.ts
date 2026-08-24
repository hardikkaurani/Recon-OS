import { Version } from "../value-objects/Version.js";
import { Timestamp } from "../value-objects/Timestamp.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { Checksum } from "../value-objects/Checksum.js";
import { InvalidDatasetError } from "../errors/DatasetError.js";

export interface DatasetVersionProps {
  version: Version;
  datasetId?: DatasetId | null;
  description?: string | null;
  checksum?: Checksum | null;
  documentCount?: number;
  totalBytes?: number;
  isPublished?: boolean;
  publishedAt?: Timestamp | null;
  createdAt?: Timestamp;
  documentIds?: readonly string[];
}

/**
 * DatasetVersion represents an immutable version point or published snapshot of a Dataset.
 * Entity: possesses version identity, cryptographic root checksum, and creation timestamp.
 */
export class DatasetVersion {
  private readonly version: Version;
  private readonly datasetId: DatasetId | null;
  private readonly description: string | null;
  private readonly checksum: Checksum | null;
  private readonly documentCount: number;
  private readonly totalBytes: number;
  private readonly isPublishedState: boolean;
  private readonly publishedAt: Timestamp | null;
  private readonly createdAt: Timestamp;
  private readonly documentIds: readonly string[];

  constructor(props: DatasetVersionProps) {
    if (!props || !props.version) {
      throw new InvalidDatasetError("DatasetVersion requires a valid Version");
    }
    this.version = props.version;
    this.datasetId = props.datasetId ?? null;
    this.description = props.description ?? null;
    this.checksum = props.checksum ?? null;
    this.documentCount = Math.max(0, props.documentCount ?? 0);
    this.totalBytes = Math.max(0, props.totalBytes ?? 0);
    this.isPublishedState = props.isPublished ?? false;
    this.publishedAt = props.publishedAt ?? (this.isPublishedState ? Timestamp.now() : null);
    this.createdAt = props.createdAt ?? new Timestamp(new Date());
    this.documentIds = Object.freeze(props.documentIds ? [...props.documentIds] : []);
  }

  public getVersion(): Version {
    return this.version;
  }

  public getDatasetId(): DatasetId | null {
    return this.datasetId;
  }

  public getDescription(): string | null {
    return this.description;
  }

  public getChecksum(): Checksum | null {
    return this.checksum;
  }

  public getDocumentCount(): number {
    return this.documentCount;
  }

  public getTotalBytes(): number {
    return this.totalBytes;
  }

  public isPublished(): boolean {
    return this.isPublishedState;
  }

  public getPublishedAt(): Timestamp | null {
    return this.publishedAt;
  }

  public getCreatedAt(): Timestamp {
    return this.createdAt;
  }

  public getDocumentIds(): readonly string[] {
    return this.documentIds;
  }

  /**
   * Publishes this version snapshot, returning a new published DatasetVersion.
   * Throws if already published (immutability enforcement).
   */
  public publish(publishedAt?: Timestamp): DatasetVersion {
    if (this.isPublishedState) {
      throw new InvalidDatasetError(`DatasetVersion v${this.version.getValue()} is already published and immutable`);
    }
    return new DatasetVersion({
      ...this.toProps(),
      isPublished: true,
      publishedAt: publishedAt ?? new Timestamp(new Date()),
    });
  }

  public equals(other: DatasetVersion): boolean {
    return Boolean(other && this.version.equals(other.version));
  }

  public toString(): string {
    const status = this.isPublishedState ? "published" : "draft";
    return `DatasetVersion(v${this.version.getValue()} [${status}])`;
  }

  public toProps(): DatasetVersionProps {
    return {
      version: this.version,
      datasetId: this.datasetId,
      description: this.description,
      checksum: this.checksum,
      documentCount: this.documentCount,
      totalBytes: this.totalBytes,
      isPublished: this.isPublishedState,
      publishedAt: this.publishedAt,
      createdAt: this.createdAt,
      documentIds: this.documentIds,
    };
  }

  public static create(
    version: Version,
    description: string | null = null,
    datasetId: DatasetId | null = null
  ): DatasetVersion {
    return new DatasetVersion({ version, description, datasetId });
  }

  public static snapshot(props: DatasetVersionProps): DatasetVersion {
    return new DatasetVersion(props);
  }
}

