import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    HtmlFileLoader,
    DatasetSource,
    DatasetId,
    DocumentType,
    UnsupportedSourceError,
    InvalidDocumentError,
} from "../dist/index.js";

test("HtmlFileLoader", async (t) => {
    const testDir = join(tmpdir(), `recon-os-html-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    t.after(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    const datasetId = DatasetId.from("test_dataset_html");
    const loader = new HtmlFileLoader();

    await t.test("1: Loads plain HTML file, extracts clean text, and strips boilerplate", async () => {
        const filePath = join(testDir, "page1.html");
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Sample Document Title</title>
    <meta name="description" content="A comprehensive guide to testing.">
    <meta name="keywords" content="rag, search, retrieval">
    <meta property="og:title" content="Social Title">
    <meta property="og:description" content="Social Description">
    <meta property="og:type" content="article">
    <meta property="og:url" content="https://example.com/article">
    <style>body { font-family: sans-serif; } .hidden { display: none; }</style>
    <script>console.log("malicious or tracker script");</script>
</head>
<body>
    <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
    <header><h1>Welcome to Recon-OS</h1></header>
    <main>
        <p>This is the first paragraph with <b>bold text</b> and <a href="#">a link</a>.</p>
        <p>Second paragraph contains &amp; ampersands and &quot;quotes&quot;.</p>
        <noscript>JavaScript is disabled</noscript>
        <svg><text>SVG graphics</text></svg>
    </main>
    <footer>Copyright 2026 Recon-OS. All rights reserved.</footer>
</body>
</html>
`;
        await writeFile(filePath, html, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getType(), DocumentType.HTML);
        assert.equal(doc.getMetadata().get("extension"), "html");
        assert.equal(doc.getMetadata().get("mimeType"), "text/html");

        // Metadata checks
        assert.equal(doc.getMetadata().get("title"), "Sample Document Title");
        assert.equal(doc.getMetadata().get("description"), "A comprehensive guide to testing.");
        assert.equal(doc.getMetadata().get("keywords"), "rag, search, retrieval");
        assert.equal(doc.getMetadata().get("ogTitle"), "Social Title");
        assert.equal(doc.getMetadata().get("ogDescription"), "Social Description");
        assert.equal(doc.getMetadata().get("ogType"), "article");
        assert.equal(doc.getMetadata().get("ogUrl"), "https://example.com/article");

        const content = doc.getContent();
        // Check clean content
        assert.ok(content.includes("Welcome to Recon-OS"));
        assert.ok(content.includes("This is the first paragraph with bold text and a link."));
        assert.ok(content.includes('Second paragraph contains & ampersands and "quotes".'));

        // Check boilerplate stripped
        assert.ok(!content.includes("console.log"));
        assert.ok(!content.includes("font-family"));
        assert.ok(!content.includes("Home"));
        assert.ok(!content.includes("Copyright 2026"));
        assert.ok(!content.includes("JavaScript is disabled"));
        assert.ok(!content.includes("SVG graphics"));
    });

    await t.test("2: Loads .htm extension file correctly", async () => {
        const filePath = join(testDir, "legacy.htm");
        await writeFile(filePath, "<html><body><h1>Legacy HTM</h1><p>Simple content.</p></body></html>", "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getType(), DocumentType.HTML);
        assert.equal(doc.getMetadata().get("extension"), "htm");
        assert.ok(doc.getContent().includes("Legacy HTM"));
        assert.ok(doc.getContent().includes("Simple content."));
    });

    await t.test("3: Computes accurate text statistics and handles trailing newlines", async () => {
        const filePath = join(testDir, "stats.html");
        const html = "<html><body><p>One two three</p><p>Four five</p></body></html>";
        await writeFile(filePath, html, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getMetadata().get<number>("lines"), 2);
        assert.equal(doc.getMetadata().get<number>("words"), 5);
        assert.ok(doc.getMetadata().get<number>("characters")! > 0);
    });

    await t.test("4: Handles empty HTML file with zero metrics", async () => {
        const filePath = join(testDir, "empty.html");
        await writeFile(filePath, "", "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getContent(), "");
        assert.equal(doc.getMetadata().get<number>("lines"), 0);
        assert.equal(doc.getMetadata().get<number>("words"), 0);
        assert.equal(doc.getMetadata().get<number>("characters"), 0);
    });

    await t.test("5: Decodes HTML entities and numeric codes cleanly", async () => {
        const filePath = join(testDir, "entities.html");
        const html = "<html><body><p>&lt;tag&gt; &amp; &quot;quote&quot; &apos;single&apos; &#65; &#x42;</p></body></html>";
        await writeFile(filePath, html, "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getContent(), "<tag> & \"quote\" 'single' A B");
    });

    await t.test("6: Rejects unsupported file extensions", async () => {
        const filePath = join(testDir, "data.txt");
        await writeFile(filePath, "not html", "utf-8");

        const source = DatasetSource.from("file", filePath);
        await assert.rejects(
            async () => loader.load(source, datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                assert.ok(err.message.includes('Unsupported file extension ".txt"'));
                return true;
            }
        );
    });

    await t.test("7: Rejects missing files", async () => {
        const source = DatasetSource.from("file", join(testDir, "nonexistent.html"));
        await assert.rejects(
            async () => loader.load(source, datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            }
        );
    });

    await t.test("8: Rejects directory as source", async () => {
        const source = DatasetSource.from("file", testDir);
        await assert.rejects(
            async () => loader.load(source, datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            }
        );
    });

    await t.test("9: Enforces file size limits before buffer allocation", async () => {
        const smallLoader = new HtmlFileLoader({ maxFileSizeBytes: 50 });
        const filePath = join(testDir, "oversized.html");
        await writeFile(filePath, "<html><body><p>" + "A".repeat(100) + "</p></body></html>", "utf-8");

        const source = DatasetSource.from("file", filePath);
        await assert.rejects(
            async () => smallLoader.load(source, datasetId),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                assert.ok(err.message.includes("too large"));
                return true;
            }
        );
    });

    await t.test("10: Rejects invalid UTF-8 byte sequences with cause preservation", async () => {
        const filePath = join(testDir, "invalid.html");
        // Write invalid continuation byte
        await writeFile(filePath, Buffer.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e]));

        const source = DatasetSource.from("file", filePath);
        await assert.rejects(
            async () => loader.load(source, datasetId),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok(err.message.includes("contains invalid UTF-8 byte sequences"));
                assert.ok("cause" in err && err.cause !== undefined);
                return true;
            }
        );
    });

    await t.test("11: Computes deterministic DocumentId from raw bytes", async () => {
        const filePath = join(testDir, "deterministic.html");
        await writeFile(filePath, "<html><body><p>Deterministic content</p></body></html>", "utf-8");

        const source = DatasetSource.from("file", filePath);
        const doc1 = await loader.load(source, datasetId);
        const doc2 = await loader.load(source, datasetId);

        assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
        assert.equal(doc1.getFingerprint().getChecksum(), doc2.getFingerprint().getChecksum());
    });
});
