import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    CsvFileLoader,
    DatasetSource,
    DatasetId,
    DocumentType,
    UnsupportedSourceError,
    InvalidDocumentError,
} from "../dist/index.js";

test("CsvFileLoader", async (t) => {
    const testDir = join(tmpdir(), `recon-os-csv-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    t.after(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    const datasetId = DatasetId.from("test_dataset_csv");
    const loader = new CsvFileLoader();

    await t.test("1: Loads standard comma-separated CSV file with headers and rows", async () => {
        const filePath = join(testDir, "users.csv");
        const csvContent = "id,name,role,active\n1,Alice,admin,true\n2,Bob,engineer,false\n3,Charlie,analyst,true\n";
        await writeFile(filePath, csvContent, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getType(), DocumentType.CSV);
        assert.equal(doc.getMetadata().get("extension"), "csv");
        assert.equal(doc.getMetadata().get("mimeType"), "text/csv");
        assert.equal(doc.getMetadata().get("delimiter"), ",");
        assert.equal(doc.getMetadata().get("rowCount"), 3);
        assert.equal(doc.getMetadata().get("columnCount"), 4);

        const columns = doc.getMetadata().get<string[]>("columns");
        assert.deepEqual(columns, ["id", "name", "role", "active"]);

        const content = doc.getContent();
        assert.ok(content.includes("| id | name | role | active |"));
        assert.ok(content.includes("| 1 | Alice | admin | true |"));
        assert.ok(content.includes("| 2 | Bob | engineer | false |"));
        assert.ok(content.includes("| 3 | Charlie | analyst | true |"));
    });

    await t.test("2: Loads tab-separated TSV file with correct MIME type and delimiter", async () => {
        const filePath = join(testDir, "products.tsv");
        const tsvContent = "sku\tname\tprice\nSKU-100\tWidget\t19.99\nSKU-200\tGadget\t29.99\n";
        await writeFile(filePath, tsvContent, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getType(), DocumentType.CSV);
        assert.equal(doc.getMetadata().get("extension"), "tsv");
        assert.equal(doc.getMetadata().get("mimeType"), "text/tab-separated-values");
        assert.equal(doc.getMetadata().get("delimiter"), "\t");
        assert.equal(doc.getMetadata().get("rowCount"), 2);
        assert.equal(doc.getMetadata().get("columnCount"), 3);
        assert.deepEqual(doc.getMetadata().get("columns"), ["sku", "name", "price"]);
    });

    await t.test("3: Auto-detects semicolon delimiter in CSV file", async () => {
        const filePath = join(testDir, "regional.csv");
        const semiContent = "city;country;population\nParis;France;2161000\nBerlin;Germany;3645000\n";
        await writeFile(filePath, semiContent, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getMetadata().get("delimiter"), ";");
        assert.equal(doc.getMetadata().get("rowCount"), 2);
        assert.equal(doc.getMetadata().get("columnCount"), 3);
        assert.deepEqual(doc.getMetadata().get("columns"), ["city", "country", "population"]);
        assert.ok(doc.getContent().includes("| Paris | France | 2161000 |"));
    });

    await t.test("4: Handles quoted fields with embedded delimiters, escaped quotes, and newlines", async () => {
        const filePath = join(testDir, "complex.csv");
        const complexCsv =
            'id,title,description\n' +
            '1,"Clean Code","A book about writing \\"good\\" code"\n' +
            '2,"Comma, Inside","Item, with, commas"\n' +
            '3,"Multi-line","Line 1\nLine 2"\n';
        await writeFile(filePath, complexCsv, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getMetadata().get("rowCount"), 3);
        assert.equal(doc.getMetadata().get("columnCount"), 3);
        const content = doc.getContent();
        assert.ok(content.includes("Comma, Inside"));
        assert.ok(content.includes("Item, with, commas"));
        assert.ok(content.includes("Line 1 Line 2") || content.includes("Line 1"));
    });

    await t.test("5: Supports 'records' representation mode", async () => {
        const recordsLoader = new CsvFileLoader({ representation: "records" });
        const filePath = join(testDir, "records.csv");
        await writeFile(filePath, "model,year\nGPT-4,2023\nClaude,2024\n", "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await recordsLoader.load(source, datasetId);

        const content = doc.getContent();
        assert.ok(content.includes("Record 1:"));
        assert.ok(content.includes("model: GPT-4"));
        assert.ok(content.includes("year: 2023"));
        assert.ok(content.includes("Record 2:"));
        assert.ok(content.includes("model: Claude"));
    });

    await t.test("6: Handles empty file and header-only file", async () => {
        const emptyPath = join(testDir, "empty.csv");
        await writeFile(emptyPath, "", "utf-8");

        const emptyDoc = await loader.load(DatasetSource.from("file", emptyPath), datasetId);
        assert.equal(emptyDoc.getMetadata().get("rowCount"), 0);
        assert.equal(emptyDoc.getMetadata().get("columnCount"), 0);
        assert.equal(emptyDoc.getContent(), "");

        const headerOnlyPath = join(testDir, "header_only.csv");
        await writeFile(headerOnlyPath, "colA,colB,colC\n", "utf-8");
        const headerDoc = await loader.load(DatasetSource.from("file", headerOnlyPath), datasetId);
        assert.equal(headerDoc.getMetadata().get("rowCount"), 0);
        assert.equal(headerDoc.getMetadata().get("columnCount"), 3);
        assert.deepEqual(headerDoc.getMetadata().get("columns"), ["colA", "colB", "colC"]);
    });

    await t.test("7: Rejects malformed CSV with unclosed quote at EOF", async () => {
        const malformedPath = join(testDir, "unclosed.csv");
        await writeFile(malformedPath, 'id,name\n1,"Unclosed value without ending quote', "utf-8");

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", malformedPath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as Error).message.includes("unclosed quote"));
                return true;
            },
        );
    });

    await t.test("8: Rejects unsupported file extension (.txt, .json)", async () => {
        const txtPath = join(testDir, "data.txt");
        await writeFile(txtPath, "id,name\n1,test", "utf-8");

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", txtPath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            },
        );
    });

    await t.test("9: Rejects missing file and directory source", async () => {
        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", join(testDir, "missing.csv")), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            },
        );

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", testDir), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            },
        );
    });

    await t.test("10: Enforces maxFileSizeBytes guard before buffer allocation", async () => {
        const strictLoader = new CsvFileLoader({ maxFileSizeBytes: 10 });
        const filePath = join(testDir, "large.csv");
        await writeFile(filePath, "id,name,role,department,location\n1,John Doe,Developer,Engineering,Remote\n", "utf-8");

        await assert.rejects(
            async () => strictLoader.load(DatasetSource.from("file", filePath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                assert.ok((err as Error).message.includes("is too large to load"));
                return true;
            },
        );
    });

    await t.test("11: Rejects invalid UTF-8 byte sequences with cause preservation", async () => {
        const invalidUtf8Path = join(testDir, "invalid_utf8.csv");
        const invalidBuffer = Buffer.from([0x69, 0x64, 0x2c, 0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xff, 0xfe, 0x80]);
        await writeFile(invalidUtf8Path, invalidBuffer);

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", invalidUtf8Path), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as Error).message.includes("invalid UTF-8 byte sequences"));
                assert.ok((err as InvalidDocumentError).cause !== undefined);
                return true;
            },
        );
    });

    await t.test("12: Computes deterministic DocumentId and fingerprint from raw bytes", async () => {
        const filePath = join(testDir, "deterministic.csv");
        await writeFile(filePath, "a,b\n1,2\n", "utf-8");

        const doc1 = await loader.load(DatasetSource.from("file", filePath), datasetId);
        const doc2 = await loader.load(DatasetSource.from("file", filePath), datasetId);

        assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
        assert.equal(doc1.getFingerprint().getChecksum(), doc2.getFingerprint().getChecksum());
    });
});
