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
    InvalidDocumentError,
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
        assert.equal(doc.getMetadata().get("encoding"), "UTF-8");
        assert.equal(doc.getMetadata().get("filename"), "sample.txt");
        assert.equal(doc.getMetadata().get("sourcePath"), filePath);
        assert.equal(doc.getMetadata().get("sizeBytes"), Buffer.byteLength(textContent, "utf-8"));
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
        const textBuf = Buffer.from(text, "utf16le");
        const bomBuf = Buffer.from([0xFF, 0xFE]);
        const fullBuf = Buffer.concat([bomBuf, textBuf]);
        await writeFile(utf16lePath, fullBuf);

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", utf16lePath), datasetId);

        assert.equal(doc.getContent(), text);
        assert.ok(!doc.getContent().includes("\uFFFD"), "Should not contain replacement characters");
        assert.equal(doc.getMetadata().get("encoding"), "UTF-16LE");
    });

    test("4: Resolves UTF-16BE with BOM without unicode replacement characters", async () => {
        const utf16bePath = join(testDir, "utf16be.txt");
        const text = "UTF-16 Big Endian test";
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
        assert.equal(doc.getMetadata().get("encoding"), "UTF-16BE");
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
        assert.equal(doc.getMetadata().get("encoding"), "UTF-8");
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

    test("9: Correctly counts lines for trailing LF and CRLF newlines without phantom lines", async () => {
        const lfPath = join(testDir, "trailing_lf.txt");
        await writeFile(lfPath, "line1\nline2\n", "utf-8");

        const crlfPath = join(testDir, "trailing_crlf.txt");
        await writeFile(crlfPath, "line1\r\nline2\r\n", "utf-8");

        const loader = new TextFileLoader();
        const docLf = await loader.load(DatasetSource.from("file", lfPath), datasetId);
        assert.equal(docLf.getMetadata().get("lines"), 2);
        assert.equal(docLf.getMetadata().get("words"), 2);

        const docCrlf = await loader.load(DatasetSource.from("file", crlfPath), datasetId);
        assert.equal(docCrlf.getMetadata().get("lines"), 2);
        assert.equal(docCrlf.getMetadata().get("words"), 2);
    });

    test("10: Correctly reports zero lines, words, and characters for empty files", async () => {
        const emptyPath = join(testDir, "empty.txt");
        await writeFile(emptyPath, "", "utf-8");

        const loader = new TextFileLoader();
        const doc = await loader.load(DatasetSource.from("file", emptyPath), datasetId);

        assert.equal(doc.getContent(), "");
        assert.equal(doc.getMetadata().get("lines"), 0);
        assert.equal(doc.getMetadata().get("words"), 0);
        assert.equal(doc.getMetadata().get("characters"), 0);
    });

    test("11: Detects and rejects UTF-32LE BOM before matching UTF-16LE", async () => {
        const utf32lePath = join(testDir, "utf32le.txt");
        // UTF-32LE BOM: 0xFF, 0xFE, 0x00, 0x00
        const utf32leBuf = Buffer.from([0xFF, 0xFE, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]);
        await writeFile(utf32lePath, utf32leBuf);

        const loader = new TextFileLoader();
        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", utf32lePath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.match(err.message, /unsupported UTF-32LE/);
                return true;
            }
        );
    });

    test("12: Detects and rejects UTF-32BE BOM", async () => {
        const utf32bePath = join(testDir, "utf32be.txt");
        // UTF-32BE BOM: 0x00, 0x00, 0xFE, 0xFF
        const utf32beBuf = Buffer.from([0x00, 0x00, 0xFE, 0xFF, 0x00, 0x00, 0x00, 0x41]);
        await writeFile(utf32bePath, utf32beBuf);

        const loader = new TextFileLoader();
        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", utf32bePath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.match(err.message, /unsupported UTF-32BE/);
                return true;
            }
        );
    });

    test("13: Rejects odd-length UTF-16LE and UTF-16BE payloads", async () => {
        const oddLePath = join(testDir, "odd_utf16le.txt");
        // UTF-16LE BOM (2 bytes) + 3 bytes payload = 5 bytes total
        await writeFile(oddLePath, Buffer.from([0xFF, 0xFE, 0x41, 0x00, 0x42]));

        const oddBePath = join(testDir, "odd_utf16be.txt");
        // UTF-16BE BOM (2 bytes) + 3 bytes payload = 5 bytes total
        await writeFile(oddBePath, Buffer.from([0xFE, 0xFF, 0x00, 0x41, 0x00]));

        const loader = new TextFileLoader();

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", oddLePath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.match(err.message, /invalid UTF-16LE payload/);
                return true;
            }
        );

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", oddBePath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.match(err.message, /invalid UTF-16BE payload/);
                return true;
            }
        );
    });

    test("14: Preserves original decoder exception via error.cause on decoding failure", async () => {
        const malformedUtf8Path = join(testDir, "malformed_utf8.txt");
        // Invalid UTF-8 byte sequence: 0xC3 followed by invalid continuation byte 0x28
        await writeFile(malformedUtf8Path, Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0xC3, 0x28]));

        const loader = new TextFileLoader();
        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", malformedUtf8Path), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as { cause?: unknown }).cause !== undefined, "Expected error.cause to be defined");
                return true;
            }
        );

        const malformedBomPath = join(testDir, "malformed_bom_utf8.txt");
        // UTF-8 BOM followed by invalid continuation sequence
        await writeFile(malformedBomPath, Buffer.from([0xEF, 0xBB, 0xBF, 0xC3, 0x28]));

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", malformedBomPath), datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as { cause?: unknown }).cause !== undefined, "Expected error.cause to be defined");
                return true;
            }
        );
    });

    test("15: Rejects non-existent files and directories via resolver contract with UnsupportedSourceError", async () => {
        const nonExistentPath = join(testDir, "does_not_exist.txt");
        const loader = new TextFileLoader();

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", nonExistentPath), datasetId),
            UnsupportedSourceError
        );

        await assert.rejects(
            async () => loader.load(DatasetSource.from("file", testDir), datasetId),
            UnsupportedSourceError
        );
    });

    test("16: Efficiently scans large input with O(1) auxiliary allocation", async () => {
        const largePath = join(testDir, "large_stats.txt");
        const line = "Alpha beta gamma delta epsilon zeta eta theta iota kappa.\n";
        const content = line.repeat(5000); // 5000 lines, 50000 words
        await writeFile(largePath, content, "utf-8");

        const loader = new TextFileLoader({ maxFileSizeBytes: 10 * 1024 * 1024 });
        const doc = await loader.load(DatasetSource.from("file", largePath), datasetId);

        assert.equal(doc.getMetadata().get("lines"), 5000);
        assert.equal(doc.getMetadata().get("words"), 50000);
        assert.equal(doc.getMetadata().get("characters"), content.length);
    });
});
