import { test, suite, before } from "node:test";
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
import { PdfFileLoader } from "../dist/dataset/loaders/PdfFileLoader.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const DS_ID = DatasetId.from("ds_test");

suite("PdfFileLoader", () => {
    let loader: PdfFileLoader;

    before(() => {
        loader = new PdfFileLoader();
    });

    // ─── Basic loading ──────────────────────────────────────────────────────

    test("1: single-page PDF loads as DocumentType.PDF with application/pdf MIME", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "simple.pdf"));
        const doc = await loader.load(source, DS_ID);

        assert.equal(doc.getType(), DocumentType.PDF);
        assert.equal(doc.getMetadata().get<string>("mimeType"), "application/pdf");
        assert.ok(doc.getContent().includes("Hello World"), "extracted text should contain 'Hello World'");
        assert.ok(doc.getId().getValue().length > 0, "DocumentId should be non-empty");
    });

    test("2: document identity is deterministic for the same file", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "simple.pdf"));

        const doc1 = await loader.load(source, DS_ID);
        const doc2 = await loader.load(source, DS_ID);

        assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
        assert.equal(doc1.getFingerprint()?.getChecksum(), doc2.getFingerprint()?.getChecksum());
    });

    // ─── Multi-page PDFs ────────────────────────────────────────────────────

    test("3: multi-page PDF text is concatenated in page order", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "multi-page.pdf"));
        const doc = await loader.load(source, DS_ID);
        const content = doc.getContent();

        assert.ok(content.includes("Page 1"), "content should include 'Page 1'");
        assert.ok(content.includes("Page 2"), "content should include 'Page 2'");
        assert.ok(
            content.indexOf("Page 1") < content.indexOf("Page 2"),
            "page ordering should be preserved",
        );
    });

    // ─── Metadata ───────────────────────────────────────────────────────────

    test("4: totalPages reflects actual page count", async () => {
        const singleSource = DatasetSource.from("file", join(FIXTURES, "simple.pdf"));
        const singleDoc = await loader.load(singleSource, DS_ID);
        assert.equal(singleDoc.getMetadata().get<number>("totalPages"), 1);

        const multiSource = DatasetSource.from("file", join(FIXTURES, "multi-page.pdf"));
        const multiDoc = await loader.load(multiSource, DS_ID);
        assert.equal(multiDoc.getMetadata().get<number>("totalPages"), 2);
    });

    test("5: pageNumber is absent — the Document represents the whole PDF, not a single page", async () => {
        // Storing pageNumber: 1 for a whole-PDF Document would be semantically
        // incorrect. Verify it is intentionally not set.
        const source = DatasetSource.from("file", join(FIXTURES, "simple.pdf"));
        const doc = await loader.load(source, DS_ID);
        const meta = doc.getMetadata();

        assert.equal(meta.get<number>("pageNumber"), undefined,
            "pageNumber must be absent; the Document represents the entire PDF");
        assert.equal(typeof meta.get<number>("totalPages"), "number",
            "totalPages must be present to describe the source artifact");
    });

    test("6: PDF title is extracted when present in document metadata", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "titled.pdf"));
        const doc = await loader.load(source, DS_ID);
        assert.equal(doc.getMetadata().get<string>("title"), "Test PDF Title");
    });

    test("7: missing PDF title is absent from metadata (not an empty string)", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "simple.pdf"));
        const doc = await loader.load(source, DS_ID);
        // Must be undefined, not "" — empty strings are not valid titles.
        assert.equal(doc.getMetadata().get<string>("title"), undefined);
    });

    test("8: filename, extension, sourcePath, sourceUri and sizeBytes are in metadata", async () => {
        const filePath = join(FIXTURES, "simple.pdf");
        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, DS_ID);
        const meta = doc.getMetadata();

        assert.equal(meta.get<string>("filename"), "simple.pdf");
        assert.equal(meta.get<string>("extension"), "pdf");
        assert.equal(meta.get<string>("sourcePath"), filePath);
        assert.ok(meta.get<string>("sourceUri")?.startsWith("file:///"));
        assert.equal(typeof meta.get<number>("sizeBytes"), "number");
    });

    // ─── Error handling ─────────────────────────────────────────────────────

    test("9: missing file throws UnsupportedSourceError", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "does-not-exist.pdf"));
        await assert.rejects(
            () => loader.load(source, DS_ID),
            UnsupportedSourceError,
        );
    });

    test("10: unsupported source type throws UnsupportedSourceError", async () => {
        const source = DatasetSource.from("s3", "s3://bucket/test.pdf");
        await assert.rejects(
            () => loader.load(source, DS_ID),
            UnsupportedSourceError,
        );
    });

    test("11: directory source throws UnsupportedSourceError", async () => {
        const source = DatasetSource.from("file", FIXTURES);
        await assert.rejects(
            () => loader.load(source, DS_ID),
            UnsupportedSourceError,
        );
    });

    test("12: non-PDF file extension throws UnsupportedSourceError", async () => {
        // A .txt file resolved by this loader should be rejected on extension.
        // Create a minimal temp file with a non-PDF extension.
        const tmpDir = await mkdtemp(join(tmpdir(), "recon-pdf-test-"));
        const txtPath = join(tmpDir, "document.txt");
        try {
            await writeFile(txtPath, "hello");
            const source = DatasetSource.from("file", txtPath);
            await assert.rejects(
                () => loader.load(source, DS_ID),
                UnsupportedSourceError,
            );
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    test("13: corrupted PDF throws InvalidDocumentError", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "corrupted.pdf"));
        await assert.rejects(
            () => loader.load(source, DS_ID),
            InvalidDocumentError,
        );
    });

    test("14: encrypted PDF throws InvalidDocumentError", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "encrypted.pdf"));
        await assert.rejects(
            () => loader.load(source, DS_ID),
            InvalidDocumentError,
        );
    });

    test("15: InvalidDocumentError preserves the original parser error as cause", async () => {
        const source = DatasetSource.from("file", join(FIXTURES, "corrupted.pdf"));
        let caught: unknown;
        try {
            await loader.load(source, DS_ID);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught instanceof InvalidDocumentError, "should throw InvalidDocumentError");
        // cause must be set so callers can inspect the underlying library error.
        assert.ok(
            (caught as { cause?: unknown }).cause !== undefined,
            "InvalidDocumentError must carry the original parser error as cause",
        );
    });

    test("16: oversized PDF is rejected before buffer allocation (file-size guard)", async () => {
        // Create a tiny loader with a 1-byte limit to exercise the guard path
        // without needing a genuinely large file.
        const tinyLoader = new PdfFileLoader({ maxFileSizeBytes: 1 });
        const source = DatasetSource.from("file", join(FIXTURES, "simple.pdf"));
        await assert.rejects(
            () => tinyLoader.load(source, DS_ID),
            UnsupportedSourceError,
        );
    });
});
