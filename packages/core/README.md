# @recon-os/core

Shared domain types, interfaces, and primitives for Recon-OS. Every other package
that models RAG concepts depends on this one for its vocabulary.

- **Purpose:** Define the common data contracts of the platform (documents, chunks,
  embeddings, retrieval, generation, evaluation, experiments).
- **Audience:** Authors of engine and application packages.
- **When to update:** When the platform's domain model changes.
- **Expansion:** New domain types are added here as modules are specified.

## Scope

This package is types and interfaces only. It contains no runtime logic, no I/O, and
no provider integrations. That keeps it cheap to depend on and safe to import anywhere.

## Public surface

- `src/types.ts` — the domain model (`Document`, `Chunk`, `Embedding`,
  `RetrievalQuery`, `RetrievalResult`, `GenerationRequest`, `GenerationResponse`,
  `EvaluationMetric`, `Experiment`).
- `src/index.ts` — re-exports the domain model.

## Features

- **Dataset Domain Models:** Strongly-typed domain aggregates (`Dataset`, `Document`, `DatasetVersion`, `DatasetCollection`) and value objects (`DatasetId`, `Version`, `URI`, `Checksum`).
- **Dataset Validation Framework:** Extensible quality assurance pipeline (`CompositeDatasetValidator`, `DuplicateDocumentValidator`, `ChecksumValidator`, `SchemaComplianceValidator`).
- **Storage & Version Control Infrastructure:** Immutable dataset versioning (`DatasetVersion`), SemVer progression (`Version`), content-addressable cryptographic digests (`ContentHasher`), source resolvers (`LocalFileSourceResolver`), dataset loaders (`LocalFileDatasetLoader`), persistent repositories (`FileDatasetRepository`), and differential version diffing (`DatasetDiffEngine`).

## Usage

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

The build emits declarations to `dist/`; the source under `src/` is the single source of truth.
