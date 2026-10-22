import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
    WebUrlLoader,
    HttpSourceResolver,
    DatasetSource,
    DatasetId,
    DocumentType,
    UnsupportedSourceError,
    InvalidDocumentError,
} from "../dist/index.js";

test("WebUrlLoader & HttpSourceResolver", async (t) => {
    let server: http.Server;
    let baseUrl: string;
    let lastReceivedHeaders: http.IncomingHttpHeaders = {};

    await new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
            lastReceivedHeaders = req.headers;
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

            if (url.pathname === "/simple-html") {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    ETag: '"tag-123"',
                    "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT",
                });
                res.end("<html><body><h1>Hello from WebUrlLoader</h1></body></html>");
                return;
            }

            if (url.pathname === "/redirect-start") {
                res.writeHead(302, { Location: "/redirect-end" });
                res.end();
                return;
            }

            if (url.pathname === "/redirect-end") {
                res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Redirected target content");
                return;
            }

            if (url.pathname === "/json-data") {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ status: "ok", count: 42 }));
                return;
            }

            if (url.pathname === "/not-found") {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
                return;
            }

            if (url.pathname === "/server-error") {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal Server Error");
                return;
            }

            if (url.pathname === "/slow") {
                setTimeout(() => {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("Slow response");
                }, 400);
                return;
            }

            if (url.pathname === "/oversized") {
                const largePayload = "X".repeat(2048);
                res.writeHead(200, {
                    "Content-Type": "text/plain",
                    "Content-Length": String(largePayload.length),
                });
                res.end(largePayload);
                return;
            }

            if (url.pathname === "/invalid-utf8") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x80]));
                return;
            }

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Default response");
        });

        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });

    t.after(() => {
        server.close();
    });

    const datasetId = DatasetId.from("test_dataset_web");
    const loader = new WebUrlLoader();

    await t.test("1: Loads HTML document from URL with headers and metadata", async () => {
        const source = DatasetSource.from("url", `${baseUrl}/simple-html`);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getType(), DocumentType.HTML);
        assert.equal(doc.getMetadata().get("statusCode"), 200);
        assert.equal(doc.getMetadata().get("mimeType"), "text/html");
        assert.equal(doc.getMetadata().get("etag"), '"tag-123"');
        assert.equal(doc.getMetadata().get("lastModified"), "Wed, 21 Oct 2026 07:28:00 GMT");
        assert.equal(doc.getMetadata().get("canonicalUrl"), `${baseUrl}/simple-html`);
        assert.ok(doc.getContent().includes("Hello from WebUrlLoader"));
    });

    await t.test("2: Loads directly from string URL with default datasetId", async () => {
        const doc = await loader.load(`${baseUrl}/simple-html`);
        assert.equal(doc.getDatasetId().getValue(), "default_web_dataset");
        assert.ok(doc.getContent().includes("Hello from WebUrlLoader"));
    });

    await t.test("3: Follows HTTP redirects and records canonical URL", async () => {
        const source = DatasetSource.from("url", `${baseUrl}/redirect-start`);
        const doc = await loader.load(source, datasetId);

        assert.equal(doc.getMetadata().get("canonicalUrl"), `${baseUrl}/redirect-end`);
        assert.equal(doc.getContent(), "Redirected target content");
    });

    await t.test("4: Sends custom User-Agent and request headers", async () => {
        const customLoader = new WebUrlLoader({
            userAgent: "Custom-Agent/2.0",
            headers: { "X-Test-Header": "TestValue123" },
        });

        await customLoader.load(`${baseUrl}/simple-html`);
        assert.equal(lastReceivedHeaders["user-agent"], "Custom-Agent/2.0");
        assert.equal(lastReceivedHeaders["x-test-header"], "TestValue123");
    });

    await t.test("5: Correctly maps application/json MIME type to DocumentType.JSON", async () => {
        const doc = await loader.load(`${baseUrl}/json-data`);
        assert.equal(doc.getType(), DocumentType.JSON);
        assert.equal(doc.getMetadata().get("mimeType"), "application/json");
        const parsed = JSON.parse(doc.getContent());
        assert.equal(parsed.count, 42);
    });

    await t.test("6: Rejects 404 Not Found with InvalidDocumentError", async () => {
        await assert.rejects(
            async () => loader.load(`${baseUrl}/not-found`),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as Error).message.includes("404: Not Found"));
                return true;
            },
        );
    });

    await t.test("7: Rejects 500 Server Error with InvalidDocumentError", async () => {
        await assert.rejects(
            async () => loader.load(`${baseUrl}/server-error`),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as Error).message.includes("status 500"));
                return true;
            },
        );
    });

    await t.test("8: Enforces request timeoutMs with InvalidDocumentError", async () => {
        const fastTimeoutLoader = new WebUrlLoader({ timeoutMs: 100 });
        await assert.rejects(
            async () => fastTimeoutLoader.load(`${baseUrl}/slow`),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as Error).message.includes("Network timeout"));
                return true;
            },
        );
    });

    await t.test("9: Enforces maxFileSizeBytes guard on oversized response", async () => {
        const smallSizeLoader = new WebUrlLoader({ maxFileSizeBytes: 500 });
        await assert.rejects(
            async () => smallSizeLoader.load(`${baseUrl}/oversized`),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                assert.ok((err as Error).message.includes("is too large to load"));
                return true;
            },
        );
    });

    await t.test("10: Rejects non-HTTP source scheme with UnsupportedSourceError", async () => {
        await assert.rejects(
            async () => loader.load("file:///etc/passwd"),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            },
        );

        await assert.rejects(
            async () => loader.load(DatasetSource.from("s3", "s3://my-bucket/data.txt")),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedSourceError);
                return true;
            },
        );
    });

    await t.test("11: Rejects invalid UTF-8 byte sequences with cause preservation", async () => {
        await assert.rejects(
            async () => loader.load(`${baseUrl}/invalid-utf8`),
            (err: unknown) => {
                assert.ok(err instanceof InvalidDocumentError);
                assert.ok((err as Error).message.includes("invalid UTF-8 byte sequences"));
                assert.ok((err as InvalidDocumentError).cause !== undefined);
                return true;
            },
        );
    });

    await t.test("12: Computes deterministic DocumentId from response content bytes", async () => {
        const doc1 = await loader.load(`${baseUrl}/simple-html`);
        const doc2 = await loader.load(`${baseUrl}/simple-html`);

        assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
        assert.equal(doc1.getFingerprint().getChecksum(), doc2.getFingerprint().getChecksum());
    });

    await t.test("13: HttpSourceResolver supports check and URL parsing", async () => {
        const resolver = new HttpSourceResolver();
        assert.equal(resolver.supports("https://api.example.com/v1"), true);
        assert.equal(resolver.supports("http://localhost:8080/path"), true);
        assert.equal(resolver.supports("file:///var/log"), false);
        assert.equal(resolver.supports("ftp://ftp.example.com"), false);

        const resolved = await resolver.resolve("https://example.com:443/docs?q=1");
        assert.equal(resolved.scheme, "https");
        assert.equal(resolved.pathOrLocation, "https://example.com:443/docs?q=1");
        assert.equal(resolved.metadata?.host, "example.com");
    });
});
