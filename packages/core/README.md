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
| `.txt` | `TEXT` | `text/plain` |
| `.md`, `.markdown` | `MARKDOWN` | `text/markdown` |
| `.json` | `JSON` | `application/json` |
| `.pdf` | `PDF` | `application/pdf` |
| `.html`, `.htm` | `HTML` | `text/html` |

## HTML Ingestion

The `@recon-os/core` package provides `HtmlFileLoader` for ingesting HTML documents.

**What it does:** Ingests local `.html` and `.htm` files, strips boilerplate tags (`<script>`, `<style>`, `<nav>`, `<footer>`, `<noscript>`, `<svg>`, comments), extracts clean readable text, and populates document metadata.
**Metadata extracted:**
- `title`: Extracted from the HTML `<title>` tag.
- `description`: Extracted from `<meta name="description" content="...">`.
- `keywords`: Extracted from `<meta name="keywords" content="...">`.
- `ogTitle`, `ogDescription`, `ogType`, `ogUrl`: Extracted from OpenGraph meta properties.
- `lines`, `words`, `characters`: Accurate text metrics computed via a memory-efficient single-pass scanner.
**Error behavior:** Rejects unsupported extensions, missing files, directories, files exceeding `maxFileSizeBytes` (default 10 MiB), and invalid UTF-8 byte sequences.

### Usage Example

```ts
import { HtmlFileLoader, DatasetSource, DatasetId } from "@recon-os/core";

const loader = new HtmlFileLoader();
const source = DatasetSource.from("file", "/path/to/article.html");
const datasetId = DatasetId.from("ds_articles_001");

const doc = await loader.load(source, datasetId);
console.log(doc.getContent()); // Clean sanitized body text
console.log(doc.getMetadata().get("title")); // Extracted title
console.log(doc.getMetadata().get("description")); // Meta description
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
