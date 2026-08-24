import { Dataset } from "../entities/Dataset.js";
import { DatasetVersion } from "../entities/DatasetVersion.js";
import { Document } from "../entities/Document.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { Version } from "../value-objects/Version.js";

/**
 * Snapshot structure encapsulating a Dataset entity, its DatasetVersion metadata, and document collection.
 */
export interface DatasetVersionSnapshot {
  readonly dataset: Dataset;
  readonly version: DatasetVersion;
  readonly documents: readonly Document[];
}

/**
 * Storage Repository interface for persisting dataset manifests, document payloads, and version metadata.
 */
export interface DatasetRepository {
  /**
   * Saves or updates a draft Dataset and its documents.
   */
  save(dataset: Dataset, documents?: Iterable<Document>): Promise<void>;

  /**
   * Finds a dataset by its unique DatasetId (returns latest version).
   */
  findById(id: DatasetId): Promise<Dataset | null>;

  /**
   * Finds a specific immutable dataset version snapshot by DatasetId and Version.
   */
  findByVersion(id: DatasetId, version: Version): Promise<DatasetVersionSnapshot | null>;

  /**
   * Lists all published/recorded version points for a dataset.
   */
  listVersions(id: DatasetId): Promise<DatasetVersion[]>;

  /**
   * Publishes an immutable dataset version snapshot.
   * Throws an error if the version snapshot already exists and is published.
   */
  publishVersion(
    dataset: Dataset,
    documents: Iterable<Document>,
    version: Version,
    description?: string
  ): Promise<DatasetVersion>;

  /**
   * Checks if a dataset or specific dataset version exists in storage.
   */
  exists(id: DatasetId, version?: Version): Promise<boolean>;

  /**
   * Deletes a dataset and all associated versions from storage.
   */
  delete(id: DatasetId): Promise<boolean>;
}
