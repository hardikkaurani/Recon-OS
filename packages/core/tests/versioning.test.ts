import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  Version,
  DatasetVersion,
  DatasetId,
  DocumentId,
  DocumentName,
  DocumentType,
  Document,
  Dataset,
  DatasetName,
  DatasetSource,
  ContentHasher,
  DatasetDiffEngine,
  InvalidDatasetError,
  DocumentMetadata,
  DocumentFingerprint,
} from "../dist/index.js";

test("Version protects SemVer formatting, comparison, and incrementation invariants", () => {
  const v1 = Version.from("1.4.2");
  assert.equal(v1.getMajor(), 1);
  assert.equal(v1.getMinor(), 4);
  assert.equal(v1.getPatch(), 2);
  assert.equal(v1.getPrerelease(), null);

  const v1Prerelease = Version.from("1.4.2-alpha.1");
  assert.equal(v1Prerelease.getPrerelease(), "alpha.1");

  // SemVer comparison
  const v2 = Version.from("2.0.0");

  assert.equal(v1.compare(v2) < 0, true);
  assert.equal(v2.compare(v1) > 0, true);
  assert.equal(v1.compare(Version.from("1.4.2")), 0);
  assert.equal(v2.isGreaterThan(v1), true);
  assert.equal(v1.isLessThan(v2), true);
  assert.equal(v1Prerelease.isLessThan(v1), true);

  // SemVer incrementation
  assert.equal(v1.incrementMajor().getValue(), "2.0.0");
  assert.equal(v1.incrementMinor().getValue(), "1.5.0");
  assert.equal(v1.incrementPatch().getValue(), "1.4.3");

  const vWithPrefix = Version.from("v1.4.2");
  assert.equal(vWithPrefix.incrementMinor().getValue(), "v1.5.0");

  assert.throws(() => new Version(""), InvalidDatasetError);
  assert.throws(() => new Version("invalid-version-format-abc!!!"), InvalidDatasetError);
});

test("Version strictly adheres to SemVer 2.0 prerelease precedence and build metadata rules", () => {
  // Numeric vs string prerelease precedence (1.0.0-alpha.2 < 1.0.0-alpha.10)
  const vAlpha2 = Version.from("1.0.0-alpha.2");
  const vAlpha10 = Version.from("1.0.0-alpha.10");
  assert.equal(vAlpha2.isLessThan(vAlpha10), true);

  // Field length precedence (1.0.0-alpha < 1.0.0-alpha.1)
  const vAlpha = Version.from("1.0.0-alpha");
  const vAlpha1 = Version.from("1.0.0-alpha.1");
  assert.equal(vAlpha.isLessThan(vAlpha1), true);

  // Lexical prerelease comparison (1.0.0-alpha.1 < 1.0.0-beta.1)
  const vBeta1 = Version.from("1.0.0-beta.1");
  assert.equal(vAlpha1.isLessThan(vBeta1), true);

  // Build metadata parsing and precedence equality (1.0.0+build.1 == 1.0.0+build.2)
  const vBuild1 = Version.from("1.0.0+build.1");
  const vBuild2 = Version.from("1.0.0+build.2");
  assert.equal(vBuild1.getBuildMetadata(), "build.1");
  assert.equal(vBuild1.compare(vBuild2), 0);
  assert.equal(vBuild1.equals(vBuild2), true);

  // Valid SemVer 2.0 with prerelease + build metadata
  const vComplex = Version.from("1.0.0-alpha+001");
  assert.equal(vComplex.getPrerelease(), "alpha");
  assert.equal(vComplex.getBuildMetadata(), "001");
});

test("DatasetVersion maintains immutable published version guarantees", () => {
  const datasetId = DatasetId.from("ds_bench_001");
  const ver = Version.from("1.0.0");
  const draftVersion = DatasetVersion.create(ver, "Initial draft", datasetId);

  assert.equal(draftVersion.isPublished(), false);
  assert.equal(draftVersion.getPublishedAt(), null);

  const publishedVersion = draftVersion.publish();
  assert.equal(publishedVersion.isPublished(), true);
  assert.notEqual(publishedVersion.getPublishedAt(), null);

  // Immutability: Re-publishing an already published version must throw InvalidDatasetError
  assert.throws(() => {
    publishedVersion.publish();
  }, InvalidDatasetError);
});

test("ContentHasher calculates deterministic SHA-256 cryptographic digests", async () => {
  const digest1 = ContentHasher.hashString("Recon-OS Dataset Control");
  const digest2 = ContentHasher.hashString("Recon-OS Dataset Control");
  const digest3 = ContentHasher.hashString("Different payload");

  assert.equal(digest1.getValue(), digest2.getValue());
  assert.notEqual(digest1.getValue(), digest3.getValue());

  // Buffer hashing
  const bufDigest = ContentHasher.hashBuffer(Buffer.from("Recon-OS Dataset Control", "utf8"));
  assert.equal(bufDigest.getValue(), digest1.getValue());

  // Stream hashing
  const stream = Readable.from(["Recon-OS ", "Dataset ", "Control"]);
  const streamDigest = await ContentHasher.hashStream(stream);
  assert.equal(streamDigest.getValue(), digest1.getValue());

  // Deterministic dataset hashing
  const ds = new Dataset({
    id: DatasetId.from("ds_test_hash"),
    name: DatasetName.from("Test Hash Dataset"),
    version: Version.from("1.0.0"),
    source: DatasetSource.from("file", "/path/to/data"),
  });

  const docA = new Document({
    id: DocumentId.from("doc_a"),
    datasetId: ds.getId(),
    name: DocumentName.from("Doc A"),
    type: DocumentType.TEXT,
    content: "Content A",
    fingerprint: DocumentFingerprint.from(ContentHasher.hashString("Content A").getValue()),
  });

  const docB = new Document({
    id: DocumentId.from("doc_b"),
    datasetId: ds.getId(),
    name: DocumentName.from("Doc B"),
    type: DocumentType.TEXT,
    content: "Content B",
    fingerprint: DocumentFingerprint.from(ContentHasher.hashString("Content B").getValue()),
  });

  // Re-ordering documents must yield identical hash due to internal deterministic sorting
  const hash1 = ContentHasher.hashDataset(ds, [docA, docB]);
  const hash2 = ContentHasher.hashDataset(ds, [docB, docA]);
  assert.equal(hash1.getValue(), hash2.getValue());
});

test("DatasetDiffEngine accurately identifies added, removed, modified, and unchanged documents", () => {
  const datasetId = DatasetId.from("ds_diff_test");

  const doc1 = new Document({
    id: DocumentId.from("doc_1"),
    datasetId,
    name: DocumentName.from("Unchanged Doc"),
    type: DocumentType.TEXT,
    content: "Static content",
    fingerprint: DocumentFingerprint.from(ContentHasher.hashString("Static content").getValue()),
  });

  const doc2V1 = new Document({
    id: DocumentId.from("doc_2"),
    datasetId,
    name: DocumentName.from("Doc 2 Original"),
    type: DocumentType.TEXT,
    content: "Original text",
    fingerprint: DocumentFingerprint.from(ContentHasher.hashString("Original text").getValue()),
  });

  const doc2V2 = new Document({
    id: DocumentId.from("doc_2"),
    datasetId,
    name: DocumentName.from("Doc 2 Updated Name"),
    type: DocumentType.TEXT,
    content: "Modified text content",
    fingerprint: DocumentFingerprint.from(ContentHasher.hashString("Modified text content").getValue()),
    metadata: DocumentMetadata.from({ author: "Tester" }),
  });

  const doc3 = new Document({
    id: DocumentId.from("doc_3"),
    datasetId,
    name: DocumentName.from("Removed Doc"),
    type: DocumentType.TEXT,
    content: "Will be deleted",
  });

  const doc4 = new Document({
    id: DocumentId.from("doc_4"),
    datasetId,
    name: DocumentName.from("Added Doc"),
    type: DocumentType.TEXT,
    content: "Newly added document",
  });

  const beforeDocs = [doc1, doc2V1, doc3];
  const afterDocs = [doc1, doc2V2, doc4];

  const diffResult = DatasetDiffEngine.diff(beforeDocs, afterDocs);

  assert.equal(diffResult.summary.totalUnchanged, 1);
  assert.equal(diffResult.summary.totalModified, 1);
  assert.equal(diffResult.summary.totalAdded, 1);
  assert.equal(diffResult.summary.totalRemoved, 1);

  assert.equal(diffResult.addedDocuments[0].getId().getValue(), "doc_4");
  assert.equal(diffResult.removedDocuments[0].getId().getValue(), "doc_3");
  assert.equal(diffResult.unchangedDocuments[0].getId().getValue(), "doc_1");

  const mod = diffResult.modifiedDocuments[0];
  assert.equal(mod.before.getId().getValue(), "doc_2");
  assert.equal(mod.changes.includes("content"), true);
  assert.equal(mod.changes.includes("name"), true);
  assert.equal(mod.changes.includes("metadata"), true);
});

test("DatasetDiffEngine supports custom identity key mapping for content-addressed documents", () => {
  const datasetId = DatasetId.from("ds_content_addressed");

  // Content-addressed documents (ID derived from content SHA-256)
  const docBefore = new Document({
    id: DocumentId.from(ContentHasher.hashString("Original Content").getValue()),
    datasetId,
    name: DocumentName.from("Guide.md"),
    type: DocumentType.TEXT,
    content: "Original Content",
  });

  const docAfter = new Document({
    id: DocumentId.from(ContentHasher.hashString("Updated Content").getValue()),
    datasetId,
    name: DocumentName.from("Guide.md"),
    type: DocumentType.TEXT,
    content: "Updated Content",
  });

  // Default matching by DocumentId: content edit produces new ID -> 1 removal, 1 addition
  const defaultDiff = DatasetDiffEngine.diff([docBefore], [docAfter]);
  assert.equal(defaultDiff.summary.totalRemoved, 1);
  assert.equal(defaultDiff.summary.totalAdded, 1);
  assert.equal(defaultDiff.summary.totalModified, 0);

  // Logical key matching by document name: identifies content modification
  const logicalDiff = DatasetDiffEngine.diff([docBefore], [docAfter], {
    getIdentityKey: (doc) => doc.getName().getValue(),
  });
  assert.equal(logicalDiff.summary.totalRemoved, 0);
  assert.equal(logicalDiff.summary.totalAdded, 0);
  assert.equal(logicalDiff.summary.totalModified, 1);
  assert.equal(logicalDiff.modifiedDocuments[0].changes.includes("content"), true);
});
