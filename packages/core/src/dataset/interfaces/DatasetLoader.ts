import { Dataset } from "../entities/Dataset.js";
import { Document } from "../entities/Document.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { URI } from "../value-objects/URI.js";

export interface DatasetLoadResult {
  readonly dataset: Dataset;
  readonly documents: readonly Document[];
}

/**
 * Interface for loading datasets from underlying sources.
 */
export interface DatasetLoader {
  /**
   * Loads a dataset and its document collection from the specified source.
   * @param source - The dataset source configuration, URI, or path
   * @returns A promise that resolves to the loaded Dataset aggregate and documents
   */
  load(source: DatasetSource | URI | string): Promise<DatasetLoadResult>;
}

