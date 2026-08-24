/**
 * Tests for the File Loader infrastructure.
 *
 * Tests are split into two suites:
 * 1. Resolver unit tests — validate LocalFileSourceResolver in isolation.
 * 2. Loader integration tests — validate the full pipeline via LocalFileLoader.
 *
 * Fixtures are created in os.tmpdir() and cleaned up after each test.
 * Imports from compiled dist via ../dist/index.js (NodeNext ESM convention).
 */
import { test, suite, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
    LocalFileLoader,
    LocalFileSourceResolver,
    DatasetSource,
    DatasetId,
    DocumentType,
    UnsupportedSourceError,
    InvalidDocumentError,
    BaseFileLoader,
    MimeType,
    URI,
} from "../dist/index.js";
import type { SourceResolver } from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write text content to a file in the given temp directory. */
async function writeTempFile(
    dir: string,
    filename: string,
    content: string,
): Promise<string> {
    const p = join(dir, filename);
    await writeFile(p, content, "utf-8");
    return p;
}

/** Compute the expected SHA-256 hex digest of a UTF-8 string. */
function sha256hex(text: string): string {
    return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

// ---------------------------------------------------------------------------
// Suite 1 — Resolver Unit Tests
// ---------------------------------------------------------------------------

suite("LocalFileSourceResolver", () => {
    let tmpDir: string;
    let txtPath: string;
    let subDir: string;

    before(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "recon-resolver-"));
        txtPath = await writeTempFile(tmpDir, "hello.txt", "hello world");
        subDir = join(tmpDir, "subdir");
        await mkdir(subDir);
    });

    after(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    test("R1: valid file → ResolvedSource with correct path and file URI", async () => {
        const resolver = new LocalFileSourceResolver();
        const source = DatasetSource.from("file", txtPath);
        const resolved = await resolver.resolve(source);

        assert.equal(resolved.pathOrLocation, txtPath);
        assert.ok(resolved.uri.getValue().startsWith("file:///"), "URI must start with file:///");
        assert.equal(resolved.uri.getValue(), pathToFileURL(txtPath).href);
    });

    test("R2: URI contains no raw backslashes or spaces (Windows-compatible)", async () => {
        const resolver = new LocalFileSourceResolver();
        const source = DatasetSource.from("file", txtPath);
        const resolved = await resolver.resolve(source);

        const uriValue = resolved.uri.getValue();
        assert.ok(!uriValue.includes("\\"), `URI must not contain backslashes: ${uriValue}`);
        // Any spaces in path must be encoded as %20
        const rawSpaces = uriValue.split("%20").length - 1;
        const pathPart = uriValue.replace(/^file:\/\//, "");
        assert.ok(!pathPart.includes(" "), `URI path must have spaces percent-encoded: ${uriValue}`);
        void rawSpaces; // acknowledged — spaces in tmpdir would be encoded
    });

    test("R3: nonexistent path → UnsupportedSourceError", async () => {
        const resolver = new LocalFileSourceResolver();
        const source = DatasetSource.from("file", join(tmpDir, "does-not-exist.txt"));
        await assert.rejects(
            () => resolver.resolve(source),
            UnsupportedSourceError,
        );
    });

    test("R4: directory → UnsupportedSourceError", async () => {
        const resolver = new LocalFileSourceResolver();
        const source = DatasetSource.from("file", subDir);
        await assert.rejects(
            () => resolver.resolve(source),
            UnsupportedSourceError,
        );
    });

    test("R5: wrong source type ('s3') → UnsupportedSourceError before any I/O", async () => {
        const resolver = new LocalFileSourceResolver();
        // path doesn't exist — but error should fire before stat() reaches it
        const source = DatasetSource.from("s3", "s3://bucket/key");
        await assert.rejects(
            () => resolver.resolve(source),
            UnsupportedSourceError,
        );
    });

    test("R6: resolver does not set mediaType (returns undefined)", async () => {
        const resolver = new LocalFileSourceResolver();
        const source = DatasetSource.from("file", txtPath);
        const resolved = await resolver.resolve(source);

        assert.equal(resolved.mediaType, undefined, "mediaType should be undefined (delegated to loader)");
    });
});

// ---------------------------------------------------------------------------
// Suite 2 — Loader Integration Tests
// ---------------------------------------------------------------------------

suite("LocalFileLoader", () => {
    let tmpDir: string;
    let loader: LocalFileLoader;

    before(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "recon-loader-"));
        loader = new LocalFileLoader();
    });

    after(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    // --- 1. Extension / MIME / DocumentType coverage ---

    test("1: load .txt → DocumentType.TEXT, text/plain MIME, correct content", async () => {
        const filePath = await writeTempFile(tmpDir, "notes.txt", "Hello, World!");
        const source = DatasetSource.from("file", filePath);
        const dsId = DatasetId.from("ds_test");

        const doc = await loader.load(source, dsId);

        assert.equal(doc.getType(), DocumentType.TEXT);
        assert.equal(doc.getMetadata().get<string>("mimeType"), "text/plain");
        assert.equal(doc.getContent(), "Hello, World!");
        assert.ok(doc.getId().getValue().length > 0, "DocumentId must not be empty");
    });

    test("2: load .md → DocumentType.MARKDOWN, text/markdown MIME", async () => {
        const filePath = await writeTempFile(tmpDir, "readme.md", "# Title\nBody");
        const source = DatasetSource.from("file", filePath);

        const doc = await loader.load(source, DatasetId.from("ds_test"));

        assert.equal(doc.getType(), DocumentType.MARKDOWN);
        assert.equal(doc.getMetadata().get<string>("mimeType"), "text/markdown");
    });

    test("3: load .markdown extension → same as .md", async () => {
        const filePath = await writeTempFile(tmpDir, "doc.markdown", "# Doc");
        const source = DatasetSource.from("file", filePath);

        const doc = await loader.load(source, DatasetId.from("ds_test"));

        assert.equal(doc.getType(), DocumentType.MARKDOWN);
        assert.equal(doc.getMetadata().get<string>("mimeType"), "text/markdown");
    });

    test("4: load .json → DocumentType.JSON, application/json MIME", async () => {
        const filePath = await writeTempFile(tmpDir, "data.json", '{"key":"value"}');
        const source = DatasetSource.from("file", filePath);

        const doc = await loader.load(source, DatasetId.from("ds_test"));

        assert.equal(doc.getType(), DocumentType.JSON);
        assert.equal(doc.getMetadata().get<string>("mimeType"), "application/json");
    });

    // --- 2. Fingerprint / identity determinism ---

    test("5: known SHA-256 digest matches expected hex", async () => {
        const content = "deterministic content";
        const expectedHex = sha256hex(content);
        const filePath = await writeTempFile(tmpDir, "known.txt", content);
        const source = DatasetSource.from("file", filePath);

        const doc = await loader.load(source, DatasetId.from("ds_test"));

        const fp = doc.getFingerprint();
        assert.ok(fp !== null, "fingerprint must not be null");
        assert.equal(fp.getChecksum(), expectedHex);
        assert.equal(doc.getId().getValue(), expectedHex);
    });

    test("6: same bytes → same DocumentId and fingerprint on two loads", async () => {
        const filePath = await writeTempFile(tmpDir, "same1.txt", "identical bytes");
        const filePath2 = await writeTempFile(tmpDir, "same2.txt", "identical bytes");
        const source1 = DatasetSource.from("file", filePath);
        const source2 = DatasetSource.from("file", filePath2);
        const dsId = DatasetId.from("ds_test");

        const doc1 = await loader.load(source1, dsId);
        const doc2 = await loader.load(source2, dsId);

        assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
        const fp1 = doc1.getFingerprint();
        const fp2 = doc2.getFingerprint();
        assert.ok(fp1 !== null && fp2 !== null, "fingerprints must not be null");
        assert.equal(fp1.getChecksum(), fp2.getChecksum());
    });

    test("7: different bytes → different DocumentId and fingerprint", async () => {
        const filePath1 = await writeTempFile(tmpDir, "diff1.txt", "content alpha");
        const filePath2 = await writeTempFile(tmpDir, "diff2.txt", "content beta!");
        const source1 = DatasetSource.from("file", filePath1);
        const source2 = DatasetSource.from("file", filePath2);
        const dsId = DatasetId.from("ds_test");

        const doc1 = await loader.load(source1, dsId);
        const doc2 = await loader.load(source2, dsId);

        assert.notEqual(doc1.getId().getValue(), doc2.getId().getValue());
        const fp1 = doc1.getFingerprint();
        const fp2 = doc2.getFingerprint();
        assert.ok(fp1 !== null && fp2 !== null, "fingerprints must not be null");
        assert.notEqual(fp1.getChecksum(), fp2.getChecksum());
    });

    test("8: DatasetId is correctly propagated to the Document", async () => {
        const filePath = await writeTempFile(tmpDir, "ds_prop.txt", "some content");
        const source = DatasetSource.from("file", filePath);
        const dsId = DatasetId.from("ds_propagation_test");

        const doc = await loader.load(source, dsId);

        assert.equal(doc.getDatasetId().getValue(), dsId.getValue());
    });

    // --- 3. Content correctness ---

    test("9: Unicode content is preserved exactly (multi-script)", async () => {
        const content = "日本語 हिंदी é ü 中文";
        const filePath = await writeTempFile(tmpDir, "unicode.txt", content);
        const source = DatasetSource.from("file", filePath);

        const doc = await loader.load(source, DatasetId.from("ds_test"));

        assert.equal(doc.getContent(), content);
    });

    test("10: strict invalid UTF-8 rejection (no silent replacement)", async () => {
        // Write raw bytes that are invalid UTF-8 (0xFF byte is never valid in UTF-8)
        const invalidBytes = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe]);
        const filePath = join(tmpDir, "invalid_utf8.txt");
        await writeFile(filePath, invalidBytes);
        const source = DatasetSource.from("file", filePath);

        await assert.rejects(
            () => loader.load(source, DatasetId.from("ds_test")),
            InvalidDocumentError,
        );
    });

    // --- 4. Metadata correctness ---

    test("11: metadata fields are populated correctly", async () => {
        const content = "metadata test";
        const filePath = await writeTempFile(tmpDir, "meta_check.txt", content);
        const source = DatasetSource.from("file", filePath);

        const doc = await loader.load(source, DatasetId.from("ds_test"));
        const meta = doc.getMetadata();

        assert.equal(meta.get<string>("filename"), "meta_check.txt");
        assert.equal(meta.get<string>("extension"), "txt");
        assert.equal(meta.get<string>("mimeType"), "text/plain");
        assert.ok(
            (meta.get<string>("sourceUri") ?? "").startsWith("file:///"),
            `sourceUri must be a file URI: ${meta.get("sourceUri")}`,
        );
        assert.equal(meta.get<string>("sourcePath"), filePath);
        assert.equal(meta.get<number>("sizeBytes"), Buffer.from(content, "utf-8").byteLength);
    });

    test("12: MIME type mapping is correct for all supported extensions", async () => {
        const cases = [
            { ext: "txt", expected: "text/plain" },
            { ext: "md", expected: "text/markdown" },
            { ext: "markdown", expected: "text/markdown" },
            { ext: "json", expected: "application/json" },
        ];
        for (const { ext, expected } of cases) {
            const filePath = await writeTempFile(tmpDir, `type_check.${ext}`, "x");
            const source = DatasetSource.from("file", filePath);
            const doc = await loader.load(source, DatasetId.from("ds_test"));
            assert.equal(
                doc.getMetadata().get<string>("mimeType"),
                expected,
                `Expected ${expected} for .${ext}`,
            );
        }
    });

    // --- 5. Error cases ---

    test("13: unsupported extension (.pdf) → UnsupportedSourceError", async () => {
        const filePath = join(tmpDir, "report.pdf");
        await writeFile(filePath, Buffer.from("%PDF-1.4 content", "utf-8"))
        const source = DatasetSource.from("file", filePath);

        await assert.rejects(
            () => loader.load(source, DatasetId.from("ds_test")),
            UnsupportedSourceError,
        );
    });

    test("14: unsupported source type ('s3') → UnsupportedSourceError", async () => {
        const source = DatasetSource.from("s3", "s3://my-bucket/key.txt");

        await assert.rejects(
            () => loader.load(source, DatasetId.from("ds_test")),
            UnsupportedSourceError,
        );
    });

    test("15: missing file → UnsupportedSourceError", async () => {
        const source = DatasetSource.from("file", join(tmpDir, "ghost.txt"));

        await assert.rejects(
            () => loader.load(source, DatasetId.from("ds_test")),
            UnsupportedSourceError,
        );
    });

    test("16: directory passed as source → UnsupportedSourceError", async () => {
        const source = DatasetSource.from("file", tmpDir);

        await assert.rejects(
            () => loader.load(source, DatasetId.from("ds_test")),
            UnsupportedSourceError,
        );
    });

    // --- 6. Remediation & Stub cases ---

    test("17: StubResolver - mediaType is preferred when provided", async () => {
        const filePath = await writeTempFile(tmpDir, "stub.json", "{}");
        const dsId = DatasetId.from("ds_test");

        class StubLoader extends BaseFileLoader {
            protected getSupportedExtensions() { return new Set(["json"]); }
            protected getMimeType() { return MimeType.from("application/json"); }
            protected getDocumentType() { return DocumentType.JSON; }
        }

        const resolver: SourceResolver = {
            async resolve() {
                return {
                    uri: URI.from("file:///stub.json"),
                    pathOrLocation: filePath,
                    mediaType: "application/vnd.custom+json"
                };
            }
        };

        const stubLoader = new StubLoader(resolver);
        const doc = await stubLoader.load(DatasetSource.from("file", filePath), dsId);

        assert.equal(doc.getMetadata().get<string>("mimeType"), "application/vnd.custom+json");
    });

    test("18: File size guard - rejects file exceeding limit", async () => {
        const filePath = await writeTempFile(tmpDir, "large.txt", "123456789012345"); // 15 bytes
        const tinyLoader = new LocalFileLoader({ maxFileSizeBytes: 10 });
        const source = DatasetSource.from("file", filePath);

        await assert.rejects(
            () => tinyLoader.load(source, DatasetId.from("ds_test")),
            (err: any) => {
                assert.ok(err instanceof UnsupportedSourceError);
                assert.ok(err.message.includes("too large"));
                return true;
            }
        );
    });

    test("19: File size guard - accepts file within limit", async () => {
        const filePath = await writeTempFile(tmpDir, "small.txt", "12345"); // 5 bytes
        const tinyLoader = new LocalFileLoader({ maxFileSizeBytes: 10 });
        const source = DatasetSource.from("file", filePath);

        const doc = await tinyLoader.load(source, DatasetId.from("ds_test"));
        assert.equal(doc.getContent(), "12345");
    });

    test("20: Error messages are clean (no double wrap)", async () => {
        const filePath = join(tmpDir, "bad.pdf");
        await writeFile(filePath, "PDF");
        const source = DatasetSource.from("file", filePath);

        try {
            await loader.load(source, DatasetId.from("ds_test"));
            assert.fail("Should throw");
        } catch (err: any) {
            assert.ok(err instanceof UnsupportedSourceError);
            assert.ok(!err.message.includes("Unsupported dataset source:"), "Should not contain double wrap");
            assert.ok(err.message.startsWith("Unsupported file extension"), "Should start directly with message");
        }
    });

    test("21: Filesystem error cause is preserved", async () => {
        const source = DatasetSource.from("file", join(tmpDir, "ghost2.txt"));

        try {
            await loader.load(source, DatasetId.from("ds_test"));
            assert.fail("Should throw");
        } catch (err: any) {
            assert.ok(err instanceof UnsupportedSourceError);
            assert.ok(err.cause, "cause should be present");
            assert.equal((err.cause as NodeJS.ErrnoException).code, "ENOENT");
        }
    });

    test("22: Extension is derived from resolved path, not original source URI", async () => {
        const filePath = await writeTempFile(tmpDir, "real.json", "{}");
        const dsId = DatasetId.from("ds_test");

        class StubLoader extends BaseFileLoader {
            protected getSupportedExtensions() { return new Set(["json"]); }
            protected getMimeType() { return MimeType.from("application/json"); }
            protected getDocumentType() { return DocumentType.JSON; }
        }

        const resolver: SourceResolver = {
            async resolve() {
                return {
                    uri: URI.from("file:///some/fake/path.txt"), // extension in URI is .txt
                    pathOrLocation: filePath,                    // resolved path is .json
                };
            }
        };

        const stubLoader = new StubLoader(resolver);
        // Original source also implies .txt: DatasetSource.from("file", "/virtual/fake.txt")
        const source = DatasetSource.from("file", "/virtual/fake.txt");
        const doc = await stubLoader.load(source, dsId);

        // It should load based on the resolved path (.json)
        assert.equal(doc.getType(), DocumentType.JSON);
        assert.equal(doc.getMetadata().get<string>("extension"), "json");
    });
});
