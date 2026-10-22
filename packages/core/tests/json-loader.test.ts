import { test, suite, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  DatasetSource,
  DatasetId,
  DocumentType,
  UnsupportedSourceError,
  InvalidDocumentError,
} from "../dist/index.js";
import { JsonFileLoader } from "../dist/dataset/loaders/JsonFileLoader.js";

const DS_ID = DatasetId.from("ds_json_test");

suite("JsonFileLoader", () => {
  let tempDir: string;
  let loader: JsonFileLoader;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "json-loader-test-"));
    loader = new JsonFileLoader();
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Basic JSON Loading ──────────────────────────────────────────────────

  test("1: loads valid JSON object as DocumentType.JSON with application/json MIME", async () => {
    const filePath = join(tempDir, "sample.json");
    await writeFile(
      filePath,
      JSON.stringify({ id: 1, title: "Recon-OS Guide", content: "Architecture details" }),
      "utf8",
    );

    const doc = await loader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getType(), DocumentType.JSON);
    assert.equal(doc.getMetadata().get<string>("mimeType"), "application/json");
    assert.equal(doc.getMetadata().get<string>("format"), "json");
    assert.equal(doc.getMetadata().get<string>("schemaType"), "object");
    assert.equal(doc.getMetadata().get<number>("recordCount"), 1);
    assert.equal(doc.getContent(), "Architecture details");
    assert.ok(doc.getId().getValue().length === 64, "DocumentId should be 64-char hex SHA-256");
  });

  test("2: extracts nested text field using dot-notation contentKey", async () => {
    const filePath = join(tempDir, "dot-path.json");
    await writeFile(
      filePath,
      JSON.stringify({
        data: {
          article: {
            text: "Extracted nested article text.",
          },
        },
      }),
      "utf8",
    );

    const customLoader = new JsonFileLoader({ contentKey: "data.article.text" });
    const doc = await customLoader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getContent(), "Extracted nested article text.");
  });

  test("3: extracts nested text field using RFC 6901 JSON Pointer contentKey", async () => {
    const filePath = join(tempDir, "pointer-path.json");
    await writeFile(
      filePath,
      JSON.stringify({
        payload: {
          section: {
            body: "Extracted with RFC 6901 pointer.",
          },
        },
      }),
      "utf8",
    );

    const customLoader = new JsonFileLoader({ contentKey: "/payload/section/body" });
    const doc = await customLoader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getContent(), "Extracted with RFC 6901 pointer.");
  });

  test("4: merges custom metadata using metadataKey", async () => {
    const filePath = join(tempDir, "meta.json");
    await writeFile(
      filePath,
      JSON.stringify({
        content: "Document with metadata",
        meta: {
          author: "Alice",
          category: "Security",
        },
      }),
      "utf8",
    );

    const customLoader = new JsonFileLoader({ metadataKey: "meta" });
    const doc = await customLoader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getMetadata().get<string>("author"), "Alice");
    assert.equal(doc.getMetadata().get<string>("category"), "Security");
  });

  // ─── JSON Lines (JSONL / NDJSON) ─────────────────────────────────────────

  test("5: loads JSONL file with application/x-ndjson MIME and format metadata", async () => {
    const filePath = join(tempDir, "records.jsonl");
    const jsonlContent = [
      JSON.stringify({ id: 101, text: "First record" }),
      JSON.stringify({ id: 102, text: "Second record" }),
      "", // Blank line should be ignored
      JSON.stringify({ id: 103, text: "Third record" }),
    ].join("\n");
    await writeFile(filePath, jsonlContent, "utf8");

    const doc = await loader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getType(), DocumentType.JSON);
    assert.equal(doc.getMetadata().get<string>("mimeType"), "application/x-ndjson");
    assert.equal(doc.getMetadata().get<string>("format"), "jsonl");
    assert.equal(doc.getMetadata().get<number>("recordCount"), 3);
  });

  test("6: extracts targeted field across JSONL records when contentKey is provided", async () => {
    const filePath = join(tempDir, "extract.ndjson");
    const ndjson = [
      JSON.stringify({ msg: "Log entry 1" }),
      JSON.stringify({ msg: "Log entry 2" }),
    ].join("\n");
    await writeFile(filePath, ndjson, "utf8");

    const customLoader = new JsonFileLoader({ contentKey: "msg" });
    const doc = await customLoader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getContent(), "Log entry 1\nLog entry 2");
  });

  // ─── Record Decomposition (loadRecords) ─────────────────────────────────

  test("7: decomposes JSON array into separate Document entities via loadRecords", async () => {
    const filePath = join(tempDir, "array.json");
    const items = [
      { id: "a", text: "Alpha" },
      { id: "b", text: "Beta" },
      { id: "c", text: "Gamma" },
    ];
    await writeFile(filePath, JSON.stringify(items), "utf8");

    const docs = await loader.loadRecords(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(docs.length, 3);
    assert.equal(docs[0]!.getContent(), "Alpha");
    assert.equal(docs[1]!.getContent(), "Beta");
    assert.equal(docs[2]!.getContent(), "Gamma");
    assert.equal(docs[0]!.getMetadata().get<number>("recordIndex"), 0);
    assert.equal(docs[0]!.getMetadata().get<number>("totalRecords"), 3);
    assert.ok(docs[0]!.getId().getValue() !== docs[1]!.getId().getValue());
  });

  test("8: decomposes JSONL into separate Document entities via loadRecords", async () => {
    const filePath = join(tempDir, "items.jsonl");
    const jsonl = [
      JSON.stringify({ title: "T1", text: "Content 1" }),
      JSON.stringify({ title: "T2", text: "Content 2" }),
    ].join("\n");
    await writeFile(filePath, jsonl, "utf8");

    const docs = await loader.loadRecords(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.getContent(), "Content 1");
    assert.equal(docs[1]!.getContent(), "Content 2");
  });

  test("9: loadRecords on single JSON object returns single-element array", async () => {
    const filePath = join(tempDir, "single.json");
    await writeFile(filePath, JSON.stringify({ key: "value" }), "utf8");

    const docs = await loader.loadRecords(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.getType(), DocumentType.JSON);
  });

  // ─── Deterministic Identity & BOM Handling ──────────────────────────────

  test("10: document identity is deterministic for identical raw bytes", async () => {
    const filePath = join(tempDir, "deterministic.json");
    await writeFile(filePath, JSON.stringify({ test: "deterministic" }), "utf8");

    const doc1 = await loader.load(DatasetSource.from("file", filePath), DS_ID);
    const doc2 = await loader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
    assert.equal(
      doc1.getFingerprint()?.getChecksum(),
      doc2.getFingerprint()?.getChecksum(),
    );
  });

  test("11: strips UTF-8 BOM cleanly without parse errors", async () => {
    const filePath = join(tempDir, "bom.json");
    const bomPayload = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ bom: true, content: "BOM passed" })),
    ]);
    await writeFile(filePath, bomPayload);

    const doc = await loader.load(DatasetSource.from("file", filePath), DS_ID);

    assert.equal(doc.getContent(), "BOM passed");
  });

  // ─── Error Handling & Security Boundaries ───────────────────────────────

  test("12: malformed JSON throws InvalidDocumentError with cause preserved", async () => {
    const filePath = join(tempDir, "broken.json");
    await writeFile(filePath, "{ invalid json }", "utf8");

    await assert.rejects(
      () => loader.load(DatasetSource.from("file", filePath), DS_ID),
      (err: unknown) => {
        assert.ok(err instanceof InvalidDocumentError);
        const docErr = err as InvalidDocumentError & { cause?: unknown };
        assert.ok(docErr.message.includes("Malformed JSON"));
        assert.ok(docErr.cause !== undefined, "error.cause must be preserved");
        return true;
      },
    );
  });

  test("13: malformed JSONL line throws InvalidDocumentError with line number", async () => {
    const filePath = join(tempDir, "broken.jsonl");
    await writeFile(
      filePath,
      `{"valid": 1}\n{not valid json}\n{"valid": 2}`,
      "utf8",
    );

    await assert.rejects(
      () => loader.load(DatasetSource.from("file", filePath), DS_ID),
      (err: unknown) => {
        assert.ok(err instanceof InvalidDocumentError);
        const docErr = err as InvalidDocumentError & { cause?: unknown };
        assert.ok(docErr.message.includes("line 2"));
        assert.ok(docErr.cause !== undefined);
        return true;
      },
    );
  });

  test("14: oversized file exceeding maxFileSizeBytes throws UnsupportedSourceError", async () => {
    const filePath = join(tempDir, "oversized.json");
    await writeFile(filePath, JSON.stringify({ huge: "data" }), "utf8");

    const smallLoader = new JsonFileLoader({ maxFileSizeBytes: 10 }); // 10 bytes limit
    await assert.rejects(
      () => smallLoader.load(DatasetSource.from("file", filePath), DS_ID),
      UnsupportedSourceError,
    );
  });

  test("15: unsupported file extension throws UnsupportedSourceError", async () => {
    const filePath = join(tempDir, "data.xml");
    await writeFile(filePath, "<xml>test</xml>", "utf8");

    await assert.rejects(
      () => loader.load(DatasetSource.from("file", filePath), DS_ID),
      UnsupportedSourceError,
    );
  });

  test("16: non-existent file source throws UnsupportedSourceError", async () => {
    const missing = join(tempDir, "does-not-exist.json");
    await assert.rejects(
      () => loader.load(DatasetSource.from("file", missing), DS_ID),
      UnsupportedSourceError,
    );
  });

  test("17: invalid UTF-8 bytes throw InvalidDocumentError with cause preserved", async () => {
    const filePath = join(tempDir, "invalid-utf8.json");
    await writeFile(filePath, Buffer.from([0x80, 0x81, 0xff]));

    await assert.rejects(
      () => loader.load(DatasetSource.from("file", filePath), DS_ID),
      (err: unknown) => {
        assert.ok(err instanceof InvalidDocumentError);
        const docErr = err as InvalidDocumentError & { cause?: unknown };
        assert.ok(docErr.cause !== undefined, "error.cause must be preserved for UTF-8 decode errors");
        return true;
      },
    );
  });
});
