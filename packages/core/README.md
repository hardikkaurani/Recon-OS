# @recon-os/core

Domain models, interfaces, and primitives for the Recon-OS retrieval-augmented generation platform.

## What this package provides

- **Domain entities** — `Document`, `Dataset`, `DatasetVersion`, `DatasetCollection`
- **Value objects** — `DocumentId`, `DatasetId`, `DocumentFingerprint`, `MimeType`, `DatasetSource`, `Version`, `URI`, `Checksum`, and more
- **Interfaces** — `DatasetLoader`, `FileLoader`, `SourceResolver`, `DatasetRepository`, `MetadataExtractor`, `DatasetValidator`, `DatasetProcessor`
- **Source resolution** — `LocalFileSourceResolver` resolves local filesystem paths into validated `ResolvedSource` descriptors
- **File loading** — `LocalFileLoader` & `LocalFileDatasetLoader` load UTF-8 text, Markdown, JSON, and JSONL files into `Document` and `Dataset` aggregates
- **Validation** — `CompositeDatasetValidator`, `DuplicateDocumentValidator`, `ChecksumValidator`, `SchemaComplianceValidator`
- **Storage & Versioning** — `FileDatasetRepository` for immutable published dataset version snapshots and `DatasetDiffEngine` for differential diffing
- **Errors** — `DomainError`, `UnsupportedSourceError`, `InvalidDocumentError`, `InvalidDatasetError`

## Supported file types

| Extension | `DocumentType` | MIME type |
|-----------|----------------|-----------|
| `.txt` | `TEXT` | `text/plain` |
| `.md`, `.markdown` | `MARKDOWN` | `text/markdown` |
| `.json` | `JSON` | `application/json` |
| `.jsonl`, `.ndjson` | `JSON` | `application/x-ndjson` |

## Features

- **Dataset Domain Models:** Strongly-typed domain aggregates (`Dataset`, `Document`, `DatasetVersion`, `DatasetCollection`) and value objects (`DatasetId`, `Version`, `URI`, `Checksum`).
- **Dataset Validation Framework:** Extensible quality assurance pipeline (`CompositeDatasetValidator`, `DuplicateDocumentValidator`, `ChecksumValidator`, `SchemaComplianceValidator`).
- **Storage & Version Control Infrastructure:** Immutable dataset versioning (`DatasetVersion`), SemVer progression (`Version`), content-addressable cryptographic digests (`ContentHasher`), source resolvers (`LocalFileSourceResolver`), dataset loaders (`LocalFileDatasetLoader`), persistent repositories (`FileDatasetRepository`), and differential version diffing (`DatasetDiffEngine`).

## Usage

### Single File Loading

```ts
import {
  LocalFileLoader,
  DatasetSource,
  DatasetId,
  UnsupportedSourceError,
  InvalidDocumentError,
} from "@recon-os/core";

const loader = new LocalFileLoader();
const source = DatasetSource.from("file", "/path/to/notes.md");
const datasetId = DatasetId.from("ds_papers_001");

try {
  const doc = await loader.load(source, datasetId);

  console.log(doc.getId().getValue());             // sha256 hex of content bytes
  console.log(doc.getName().getValue());           // "notes.md"
  console.log(doc.getContent());                   // raw UTF-8 string
  console.log(doc.getFingerprint().getChecksum()); // sha256 hex (same as id)
  console.log(doc.getMetadata().getValue());       // { filename, extension, mimeType, ... }
} catch (err) {
  if (err instanceof UnsupportedSourceError) {
    // source type not "file", extension not supported, path missing/is directory
  }
  if (err instanceof InvalidDocumentError) {
    // file contains invalid UTF-8 byte sequences
  }
}
```

### Dataset Storage & Version Control

```ts
import {
  Version,
  DatasetVersion,
  LocalFileDatasetLoader,
  FileDatasetRepository,
  DatasetDiffEngine,
} from "@recon-os/core";

// 1. Load dataset & documents from local file/directory
const loader = new LocalFileDatasetLoader();
const { dataset, documents } = await loader.load("./data/benchmark.jsonl");

// 2. Persist & publish immutable dataset version
const repo = new FileDatasetRepository("./storage");
const version = Version.from("1.0.0");
const publishedSnapshot = await repo.publishVersion(dataset, documents, version, "Initial Benchmark Snapshot");

// 3. Compute differential diff between version points
const diff = DatasetDiffEngine.diff(v1Docs, v2Docs);
console.log(`Added: ${diff.summary.totalAdded}, Modified: ${diff.summary.totalModified}`);
```

### `DocumentId` semantics

`DocumentId` is the SHA-256 hex digest of the raw file bytes. This is **content-addressed identity**: the same bytes always produce the same `DocumentId`, and editing a file produces a new `DocumentId`. Recon-OS `Document` entities are immutable; versioning is represented by producing new entities.

### Custom loaders

To add support for additional file types, extend `BaseFileLoader` (internal) or implement `FileLoader` directly. Use `LocalFileSourceResolver` or implement `SourceResolver` for custom source types (HTTP, S3, etc.).

## Scripts

```sh
pnpm build        # compile TypeScript to dist/
pnpm typecheck    # type-check without emitting
pnpm lint         # ESLint
pnpm test         # build + run all tests
```
