# @recon-os/core

Domain models, interfaces, and primitives for the Recon-OS retrieval-augmented generation platform.

## What this package provides

- **Domain entities** — `Document`, `Dataset`
- **Value objects** — `DocumentId`, `DatasetId`, `DocumentFingerprint`, `MimeType`, `DatasetSource`, `URI`, and more
- **Interfaces** — `DatasetLoader`, `FileLoader`, `SourceResolver`, `MetadataExtractor`, `DatasetValidator`, `DatasetProcessor`
- **Source resolution** — `LocalFileSourceResolver` resolves local filesystem paths into validated `ResolvedSource` descriptors
- **File loading** — `LocalFileLoader` loads UTF-8 text, Markdown, and JSON files into `Document` entities
- **Validation** — `DuplicateDocumentValidator`, `ContentSizeValidator`, `EncodingValidator`, and more
- **Errors** — `DomainError`, `UnsupportedSourceError`, `InvalidDocumentError`, `InvalidDatasetError`

## Supported file types

| Extension | `DocumentType` | MIME type |
|-----------|----------------|-----------|
| `.txt` | `TEXT` | `text/plain` |
| `.md`, `.markdown` | `MARKDOWN` | `text/markdown` |
| `.json` | `JSON` | `application/json` |

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

### `DocumentId` semantics

`DocumentId` is the SHA-256 hex digest of the raw file bytes. This is **content-addressed identity**: the same bytes always produce the same `DocumentId`, and editing a file produces a new `DocumentId`. This is intentional — Recon-OS `Document` entities are immutable; versioning is represented by producing new entities.

### Custom loaders

To add support for additional file types, extend `BaseFileLoader` (internal) or implement `FileLoader` directly. Use `LocalFileSourceResolver` or implement `SourceResolver` for custom source types (HTTP, S3, etc.).

## Scripts

```sh
pnpm build        # compile TypeScript to dist/
pnpm typecheck    # type-check without emitting
pnpm lint         # ESLint
pnpm test         # build + run all tests
```
