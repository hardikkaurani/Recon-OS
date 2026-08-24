import { DatasetId } from "../value-objects/DatasetId.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { Document } from "../entities/Document.js";

/**
 * Document-level loader interface.
 *
 * Responsible for transforming a single {@link DatasetSource} into a validated
 * Recon-OS {@link Document} entity. This is distinct from {@link DatasetLoader},
 * which operates at the full-dataset aggregate level.
 *
 * Callers supply the {@link DatasetId} because the loader is unaware of which
 * dataset the resulting document belongs to — that is the caller's concern.
 *
 * @example
 * ```ts
 * const loader: FileLoader = new LocalFileLoader();
 * const doc = await loader.load(
 *   DatasetSource.from("file", "/path/to/readme.md"),
 *   DatasetId.from("ds_001"),
 * );
 * ```
 */
export interface FileLoader {
    /**
     * Loads a single document from the specified source.
     *
     * @param source - The source descriptor identifying the file to load.
     * @param datasetId - The dataset this document belongs to.
     * @returns A promise that resolves to a validated {@link Document}.
     * @throws {UnsupportedSourceError} if the source cannot be resolved or the
     *   file type is not supported by this loader.
     * @throws {InvalidDocumentError} if the file content cannot be decoded or
     *   the resulting document fails domain validation.
     */
    load(source: DatasetSource, datasetId: DatasetId): Promise<Document>;
}
