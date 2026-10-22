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
| --- | --- | --- |
| `.txt`, `.log` | `TEXT` | `text/plain` |
| `.md`, `.markdown` | `MARKDOWN` | `text/markdown` |
| `.json` | `JSON` | `application/json` |
| `.pdf` | `PDF` | `application/pdf` |

## Plain Text & Log Ingestion

The `@recon-os/core` package provides `TextFileLoader` for ingesting plain text and log files (`.txt`, `.log`).

**What it does:** Reads plain text files from local storage, resolves byte-order marks (BOM) for multiple character encodings, validates encoding integrity, and computes single-pass structural statistics without intermediate heap arrays.
**Supported behavior:**
- Supports `.txt` and `.log` extensions.
- Detects and resolves BOMs: UTF-8 (`EF BB BF`), UTF-16LE (`FF FE`), and UTF-16BE (`FE FF`).
- Falls back to strict UTF-8 decoding when no BOM is present.
- Detects and rejects unsupported UTF-32 encodings (UTF-32LE `FF FE 00 00`, UTF-32BE `00 00 FE FF`) before UTF-16 inspection.
**Document metadata:** Stores structural text attributes in `DocumentMetadata`:
- `encoding`: Normalized canonical encoding string (e.g., `'UTF-8'`, `'UTF-16LE'`, `'UTF-16BE'`) via `Encoding` value object
- `lines`: Number of lines, accounting for CRLF, LF, CR, and trailing newlines (empty files return 0)
- `words`: Number of whitespace-separated tokens
- `characters`: Total character count
- `filename`, `extension`, `mimeType`, `sourceUri`, `sourcePath`, `sizeBytes`
**Error behavior:**
- Rejects non-existent paths, directories, and unsupported extensions with `UnsupportedSourceError`.
- Rejects files exceeding the configured limit (defaults to 10 MiB, configurable via `maxFileSizeBytes`) with `UnsupportedSourceError`.
- Rejects malformed UTF-8/UTF-16 sequences, odd-length UTF-16 payloads, and UTF-32 encodings with `InvalidDocumentError`, preserving root decoding exceptions via `{ cause }`.

### Minimal Usage Example

```ts
import { TextFileLoader, DatasetSource, DatasetId } from "@recon-os/core";

const loader = new TextFileLoader({ maxFileSizeBytes: 10 * 1024 * 1024 });
const source = DatasetSource.from("file", "/path/to/system.log");
const datasetId = DatasetId.from("ds_logs_001");

const doc = await loader.load(source, datasetId);
console.log(doc.getContent());
console.log(doc.getMetadata().get("lines"));
console.log(doc.getMetadata().get("encoding")); // "UTF-8"
```


## PDF Ingestion

The `@recon-os/core` package provides a `PdfFileLoader` for ingesting PDF files.

**What it does:** Extracts text from a PDF file using `pdf-parse`, generating a single `Document` entity containing the entire PDF's text.
**Supported behavior:** It handles single-page and multi-page PDFs, preserving text order.
**Document metadata:** PDF metadata is stored cleanly inside `DocumentMetadata` with keys:
- `totalPages`: the total number of pages in the PDF source artifact
- `title`: the title extracted from the PDF metadata (if present)
**Error behavior:** Rejects encrypted or corrupted PDFs, throwing an `InvalidDocumentError`.
**Limitations:** Does not perform OCR. Images and layout tables are not reconstructed unless the underlying text parser (`pdf-parse`) naturally extracts them.

### Minimal Usage Example

```ts
import { PdfFileLoader, DatasetSource, DatasetId } from "@recon-os/core";

const loader = new PdfFileLoader();
const source = DatasetSource.from("file", "/path/to/report.pdf");
const datasetId = DatasetId.from("ds_papers_001");

const doc = await loader.load(source, datasetId);
console.log(doc.getContent()); // All extracted PDF text
console.log(doc.getMetadata().get("totalPages")); // Total number of pages
```

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
