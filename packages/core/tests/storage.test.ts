import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  LocalFileSourceResolver,
  LocalFileDatasetLoader,
  FileDatasetRepository,
  Dataset,
  Document,
  DatasetId,
  DatasetName,
  DocumentId,
  DocumentName,
  DocumentType,
  Version,
  DatasetSource,
  InvalidDatasetError,
} from "../dist/index.js";

test("LocalFileSourceResolver resolves local file paths and file URIs", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recon_resolver_test_"));
  const sampleFile = path.join(tmpDir, "sample.json");
  await fs.writeFile(sampleFile, JSON.stringify({ hello: "world" }), "utf8");

  const resolver = new LocalFileSourceResolver();

  // Test local string path
  assert.equal(resolver.supports(sampleFile), true);
  const resPath = await resolver.resolve(sampleFile);
  assert.equal(resPath.exists, true);
  assert.equal(resPath.isDirectory, false);
  assert.equal(resPath.mediaType, "application/json");

  // Test file:// URI
  const fileUriStr = `file:///${sampleFile.replace(/\\/g, "/")}`;
  assert.equal(resolver.supports(fileUriStr), true);
  const resUri = await resolver.resolve(fileUriStr);
  assert.equal(resUri.exists, true);

  // Test non-existent local path
  const nonExistent = path.join(tmpDir, "does_not_exist.txt");
  const resMissing = await resolver.resolve(nonExistent);
  assert.equal(resMissing.exists, false);

  // Test unsupported non-local URI schemes
  assert.equal(resolver.supports("s3://my-bucket/dataset.json"), false);
  assert.equal(resolver.supports("https://example.com/data.csv"), false);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("LocalFileDatasetLoader loads dataset and documents from JSON manifest and JSONL file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recon_loader_test_"));
  const loader = new LocalFileDatasetLoader();

  // 1. JSON manifest dataset load
  const manifestPath = path.join(tmpDir, "dataset.json");
  const manifestContent = {
    id: "ds_manifest_001",
    name: "Manifest Test Dataset",
    version: "1.0.0",
    source: { type: "file", uri: manifestPath },
    documents: [
      { id: "doc_1", name: "Doc One", type: "text", content: "Hello from Doc 1" },
      { id: "doc_2", name: "Doc Two", type: "markdown", content: "# Doc 2 Header" },
    ],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifestContent, null, 2), "utf8");

  const loadResult = await loader.load(manifestPath);
  assert.equal(loadResult.dataset.getId().getValue(), "ds_manifest_001");
  assert.equal(loadResult.documents.length, 2);
  assert.equal(loadResult.documents[0].getContent(), "Hello from Doc 1");

  // 2. JSONL stream dataset load
  const jsonlPath = path.join(tmpDir, "dataset.jsonl");
  const jsonlLines = [
    JSON.stringify({ id: "rec_1", name: "Record 1", content: "JSONL Content 1" }),
    JSON.stringify({ id: "rec_2", name: "Record 2", content: "JSONL Content 2" }),
  ].join("\n");
  await fs.writeFile(jsonlPath, jsonlLines, "utf8");

  const jsonlResult = await loader.load(jsonlPath);
  assert.equal(jsonlResult.documents.length, 2);
  assert.equal(jsonlResult.documents[0].getId().getValue(), "rec_1");
  assert.equal(jsonlResult.documents[1].getContent(), "JSONL Content 2");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("FileDatasetRepository manages persistence, safe streaming, and enforces version immutability", async () => {
  const baseStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "recon_repo_test_"));
  const repo = new FileDatasetRepository(baseStorageDir);

  const datasetId = DatasetId.from("ds_repo_001");
  const dataset = new Dataset({
    id: datasetId,
    name: DatasetName.from("Repository Storage Dataset"),
    version: Version.from("1.0.0"),
    source: DatasetSource.from("file", path.join(baseStorageDir, "source")),
  });

  const doc1 = new Document({
    id: DocumentId.from("doc_repo_1"),
    datasetId,
    name: DocumentName.from("Repo Document 1"),
    type: DocumentType.TEXT,
    content: "Large streaming test payload ".repeat(500),
  });

  // 1. Save draft dataset & documents
  await repo.save(dataset, [doc1]);

  const existsDraft = await repo.exists(datasetId);
  assert.equal(existsDraft, true);

  const fetched = await repo.findById(datasetId);
  assert.notEqual(fetched, null);
  assert.equal(fetched!.getName().getValue(), "Repository Storage Dataset");

  // 2. Publish version v1.0.0
  const version1 = Version.from("1.0.0");
  const publishedSnapshot = await repo.publishVersion(dataset, [doc1], version1, "First release");

  assert.equal(publishedSnapshot.isPublished(), true);
  assert.equal(publishedSnapshot.getDocumentCount(), 1);
  assert.notEqual(publishedSnapshot.getChecksum(), null);

  const existsV1 = await repo.exists(datasetId, version1);
  assert.equal(existsV1, true);

  // 3. Immutability guarantee: Re-publishing version v1.0.0 must fail
  await assert.rejects(async () => {
    await repo.publishVersion(dataset, [doc1], version1, "Attempt overwrite");
  }, InvalidDatasetError);

  // 4. Find by version and list versions
  const versionSnapshot = await repo.findByVersion(datasetId, version1);
  assert.notEqual(versionSnapshot, null);
  assert.equal(versionSnapshot!.version.getVersion().getValue(), "1.0.0");
  assert.equal(versionSnapshot!.documents.length, 1);
  assert.equal(versionSnapshot!.documents[0].getId().getValue(), "doc_repo_1");

  const versions = await repo.listVersions(datasetId);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].getVersion().getValue(), "1.0.0");

  // 5. Delete dataset
  const deleted = await repo.delete(datasetId);
  assert.equal(deleted, true);
  assert.equal(await repo.exists(datasetId), false);

  await fs.rm(baseStorageDir, { recursive: true, force: true });
});

test("LocalFileSourceResolver handles standard RFC 8089 file URLs across platforms and special paths", async () => {
  const resolver = new LocalFileSourceResolver();

  // Paths with spaces and special characters
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recon_uri test_"));
  const pathWithSpaces = path.join(tmpDir, "file with spaces #1.txt");
  await fs.writeFile(pathWithSpaces, "Content in space path", "utf8");

  const res = await resolver.resolve(pathWithSpaces);
  assert.equal(res.exists, true);
  assert.equal(res.scheme, "file");
  assert.equal(res.uri.getValue().startsWith("file://"), true);

  // Test round-trip resolve using generated file:// URI
  const roundTripRes = await resolver.resolve(res.uri.getValue());
  assert.equal(roundTripRes.exists, true);
  assert.equal(roundTripRes.pathOrLocation, path.resolve(pathWithSpaces));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("LocalFileDatasetLoader enforces configurable max file size limits and prevents unbounded memory accumulation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recon_loader_limit_test_"));

  // 1. File at allowed size (100 bytes limit, file is 50 bytes)
  const loader = new LocalFileDatasetLoader({ maxFileSizeBytes: 100 });
  const smallFile = path.join(tmpDir, "small.txt");
  await fs.writeFile(smallFile, "A".repeat(50), "utf8");

  const smallResult = await loader.load(smallFile);
  assert.equal(smallResult.documents.length, 1);
  assert.equal(smallResult.documents[0].getContent().length, 50);

  // 2. Oversized file (100 bytes limit, file is 150 bytes)
  const largeFile = path.join(tmpDir, "large.txt");
  await fs.writeFile(largeFile, "B".repeat(150), "utf8");

  await assert.rejects(async () => {
    await loader.load(largeFile);
  }, InvalidDatasetError);

  // 3. Oversized JSONL file
  const largeJsonl = path.join(tmpDir, "large.jsonl");
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `rec_${i}`, content: "X".repeat(20) })).join("\n");
  await fs.writeFile(largeJsonl, lines, "utf8");

  await assert.rejects(async () => {
    await loader.load(largeJsonl);
  }, InvalidDatasetError);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("FileDatasetRepository propagates non-ENOENT filesystem errors during publishVersion", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recon_repo_err_test_"));
  const repo = new FileDatasetRepository(tmpDir);

  const datasetId = DatasetId.from("ds_err_001");
  const dataset = new Dataset({
    id: datasetId,
    name: DatasetName.from("Err Test Dataset"),
    version: Version.from("1.0.0"),
    source: DatasetSource.from("file", tmpDir),
  });

  const doc = new Document({
    id: DocumentId.from("doc_1"),
    datasetId,
    name: DocumentName.from("Doc 1"),
    type: DocumentType.TEXT,
    content: "Content",
  });

  // 1. Existing version throws InvalidDatasetError
  const v1 = Version.from("1.0.0");
  await repo.publishVersion(dataset, [doc], v1);
  await assert.rejects(async () => {
    await repo.publishVersion(dataset, [doc], v1);
  }, InvalidDatasetError);

  // 2. Non-ENOENT invalid path system error (e.g., null byte in path) is propagated and NOT swallowed
  const badDatasetId = DatasetId.from("ds_err_\0_bad");
  const badDataset = new Dataset({
    id: badDatasetId,
    name: DatasetName.from("Bad Dataset"),
    version: Version.from("1.0.0"),
    source: DatasetSource.from("file", tmpDir),
  });

  await assert.rejects(async () => {
    await repo.publishVersion(badDataset, [doc], v1);
  }, (err: unknown) => {
    assert.equal(err instanceof InvalidDatasetError, false);
    return true;
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
});
