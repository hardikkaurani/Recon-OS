import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    TextFileLoader,
    DatasetSource,
    DatasetId,
    DocumentType,
    UnsupportedSourceError,
} from "../dist/index.js";

describe("TextFileLoader & Encoding Resolution Engine (#17)", () => {
    let testDir: string;
    const datasetId = DatasetId.from("ds_text_test");

    before(async () => {
        testDir = join(tmpdir(), `recon_os_text_test_${Date.now()}`);
        await mkdir(testDir, { recursive: true });
    });

    after(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    test("1: Loads plain UTF-8 .txt file with correct metadata, lines, words, chars", async () => {
        const filePath = join(testDir, "sample.txt");
        const textContent = "Hello Recon-OS\nSecond line of plain text\nThird line";
        await writeFile(filePath, textContent, "utf-8");

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", filePath), datasetId);

        assert.equal(doc.getType(), DocumentType.TEXT);
        assert.equal(doc.getContent(), textContent);
        assert.equal(doc.getMetadata().get("mimeType"), "text/plain");
        assert.equal(doc.getMetadata().get("lines"), 3);
        assert.equal(doc.getMetadata().get("words"), 9);
        assert.equal(doc.getMetadata().get("characters"), textContent.length);
        assert.equal(doc.getMetadata().get("encoding"), "utf-8");
    });

    test("2: Loads .log file as DocumentType.TEXT", async () => {
        const logPath = join(testDir, "system.log");
        const logContent = "[INFO] 2026-10-21 System boot successful\n[WARN] High memory usage";
        await writeFile(logPath, logContent, "utf-8");

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", logPath), datasetId);

        assert.equal(doc.getType(), DocumentType.TEXT);
        assert.equal(doc.getContent(), logContent);
        assert.equal(doc.getMetadata().get("extension"), "log");
        assert.equal(doc.getMetadata().get("lines"), 2);
    });

    test("3: Resolves UTF-16LE with BOM without unicode replacement characters", async () => {
        const utf16lePath = join(testDir, "utf16le.txt");
        const text = "UTF-16 Little Endian encoded document";
        // Create buffer with UTF-16LE BOM: 0xFF, 0xFE
        const textBuf = Buffer.from(text, "utf16le");
        const bomBuf = Buffer.from([0xFF, 0xFE]);
        const fullBuf = Buffer.concat([bomBuf, textBuf]);
        await writeFile(utf16lePath, fullBuf);

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", utf16lePath), datasetId);

        assert.equal(doc.getContent(), text);
        assert.ok(!doc.getContent().includes("\uFFFD"), "Should not contain replacement characters");
        assert.equal(doc.getMetadata().get("encoding"), "utf-16le");
    });

    test("4: Resolves UTF-16BE with BOM without unicode replacement characters", async () => {
        const utf16bePath = join(testDir, "utf16be.txt");
        const text = "UTF-16 Big Endian test";
        // Manual UTF-16BE encoding with BOM 0xFE, 0xFF
        const bytes = [0xFE, 0xFF];
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            bytes.push((code >> 8) & 0xFF);
            bytes.push(code & 0xFF);
        }
        await writeFile(utf16bePath, Buffer.from(bytes));

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", utf16bePath), datasetId);

        assert.equal(doc.getContent(), text);
        assert.ok(!doc.getContent().includes("\uFFFD"), "Should not contain replacement characters");
        assert.equal(doc.getMetadata().get("encoding"), "utf-16be");
    });

    test("5: Handles UTF-8 BOM cleanly", async () => {
        const bomPath = join(testDir, "utf8bom.txt");
        const text = "Text with UTF-8 BOM header";
        const bomBuf = Buffer.from([0xEF, 0xBB, 0xBF]);
        const textBuf = Buffer.from(text, "utf-8");
        await writeFile(bomPath, Buffer.concat([bomBuf, textBuf]));

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", bomPath), datasetId);

        assert.equal(doc.getContent(), text);
        assert.equal(doc.getMetadata().get("encoding"), "utf-8");
    });

    test("6: Rejects unsupported file extensions (e.g. .pdf, .json)", async () => {
        const pdfPath = join(testDir, "fake.pdf");
        await writeFile(pdfPath, "PDF content");

        const loader = new TextFileLoader();
        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", pdfPath), datasetId),
            UnsupportedSourceError
        );
    });

    test("7: Enforces file size guard limit", async () => {
        const largePath = join(testDir, "oversized.txt");
        await writeFile(largePath, "a".repeat(1024));

        const loader = new TextFileLoader({ maxFileSizeBytes: 500 });
        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", largePath), datasetId),
            UnsupportedSourceError
        );
    });

    test("8: Computes deterministic DocumentId from content bytes", async () => {
        const path1 = join(testDir, "file1.txt");
        const path2 = join(testDir, "file2.txt");
        const content = "Identical text content for hashing test";
        await writeFile(path1, content, "utf-8");
        await writeFile(path2, content, "utf-8");

        const loader = new TextFileLoader();
        const doc1 = await loader.load(DatasetSource.from("file", path1), datasetId);
        const doc2 = await loader.load(DatasetSource.from("file", path2), datasetId);

        assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
    });
});
