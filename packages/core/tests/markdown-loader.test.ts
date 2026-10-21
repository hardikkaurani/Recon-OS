import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MarkdownFileLoader,
  DatasetSource,
  DatasetId,
  DocumentType,
  UnsupportedSourceError,
  InvalidDocumentError,
} from "../dist/index.js";

describe("MarkdownFileLoader", () => {
  let tempDir: string;
  const loader = new MarkdownFileLoader();
  const datasetId = DatasetId.from("ds_markdown_test");

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "recon-os-md-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("1: load .md file -> DocumentType.MARKDOWN, text/markdown MIME, content intact", async () => {
    const filePath = join(tempDir, "sample.md");
    const content = "# Sample Title\n\nThis is a test paragraph with **bold** text.";
    await writeFile(filePath, content, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    assert.equal(doc.getType(), DocumentType.MARKDOWN);
    assert.equal(doc.getMetadata().get("mimeType"), "text/markdown");
    assert.equal(doc.getMetadata().get("extension"), "md");
    assert.equal(doc.getMetadata().get("filename"), "sample.md");
    assert.equal(doc.getContent(), content);
    assert.equal(doc.getName().getValue(), "sample.md");
  });

  test("2: load .markdown extension -> same as .md", async () => {
    const filePath = join(tempDir, "long-ext.markdown");
    const content = "## Subheading\n\nContent for long extension.";
    await writeFile(filePath, content, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    assert.equal(doc.getType(), DocumentType.MARKDOWN);
    assert.equal(doc.getMetadata().get("mimeType"), "text/markdown");
    assert.equal(doc.getMetadata().get("extension"), "markdown");
    assert.equal(doc.getContent(), content);
  });

  test("3: extract YAML frontmatter -> maps title, tags, author, date, draft to DocumentMetadata", async () => {
    const filePath = join(tempDir, "frontmatter.md");
    const mdText = `---
title: Guide to RAG Architectures
author: Jane Doe
draft: false
rating: 9.5
tags: [rag, vector-db, ai]
---

# Introduction

Here is the intro.
`;
    await writeFile(filePath, mdText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    const meta = doc.getMetadata();
    assert.equal(meta.get("title"), "Guide to RAG Architectures");
    assert.equal(meta.get("author"), "Jane Doe");
    assert.equal(meta.get("draft"), false);
    assert.equal(meta.get("rating"), 9.5);
    assert.deepEqual(meta.get("tags"), ["rag", "vector-db", "ai"]);

    const fm = meta.get<Record<string, unknown>>("frontmatter");
    assert.ok(fm);
    assert.equal(fm.title, "Guide to RAG Architectures");
  });

  test("4: extract JSON frontmatter (;;; delimiter) -> parses JSON into DocumentMetadata", async () => {
    const filePath = join(tempDir, "json-fm.md");
    const mdText = `;;;
{
  "title": "JSON Frontmatter Document",
  "version": 2,
  "public": true
}
;;;

# Heading in Body
`;
    await writeFile(filePath, mdText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    const meta = doc.getMetadata();
    assert.equal(meta.get("title"), "JSON Frontmatter Document");
    assert.equal(meta.get("version"), 2);
    assert.equal(meta.get("public"), true);
  });

  test("5: unclosed YAML frontmatter -> graceful fallback with frontmatterError metadata, content preserved", async () => {
    const filePath = join(tempDir, "unclosed-fm.md");
    const mdText = `---
title: Unclosed Delimiter
tags: test

# Heading 1
This frontmatter never closed.
`;
    await writeFile(filePath, mdText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    assert.equal(doc.getType(), DocumentType.MARKDOWN);
    assert.equal(doc.getContent(), mdText);
    assert.ok(doc.getMetadata().has("frontmatterError"));
  });

  test("6: header-aware parser -> extracts H1, H2, H3 hierarchy with line numbers and counts", async () => {
    const filePath = join(tempDir, "sections.md");
    const mdText = `# Main Section
Paragraph 1.

## Subsection 1.1
Content A.

### Sub-subsection
Deep content.

## Subsection 1.2
Content B.
`;
    await writeFile(filePath, mdText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    const meta = doc.getMetadata();
    const headings = meta.get<Array<{ level: number; title: string; line: number }>>("headings")!;

    assert.equal(headings.length, 4);
    assert.equal(meta.get("sectionsCount"), 4);

    assert.deepEqual(headings[0], { level: 1, title: "Main Section", line: 1 });
    assert.deepEqual(headings[1], { level: 2, title: "Subsection 1.1", line: 4 });
    assert.deepEqual(headings[2], { level: 3, title: "Sub-subsection", line: 7 });
    assert.deepEqual(headings[3], { level: 2, title: "Subsection 1.2", line: 10 });
  });

  test("7: code fence protection -> headings inside ``` or ~~~ fences are strictly ignored", async () => {
    const filePath = join(tempDir, "code-fences.md");
    const mdText = `# Valid Heading 1

\`\`\`markdown
# Fake Heading In Backticks
## Another Fake Heading
\`\`\`

## Valid Heading 2

~~~
# Fake Heading In Tildes
~~~

### Valid Heading 3
`;
    await writeFile(filePath, mdText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    const headings = doc.getMetadata().get<Array<{ level: number; title: string }>>("headings")!;
    assert.equal(headings.length, 3);
    assert.equal(headings[0].title, "Valid Heading 1");
    assert.equal(headings[1].title, "Valid Heading 2");
    assert.equal(headings[2].title, "Valid Heading 3");
  });

  test("8: content preservation -> tables, blockquotes, links, code blocks retained byte-for-byte", async () => {
    const filePath = join(tempDir, "rich-content.md");
    const mdText = `# Title

> This is a blockquote with [a link](https://example.com).

| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |

\`\`\`ts
const x: number = 42;
\`\`\`
`;
    await writeFile(filePath, mdText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc = await loader.load(source, datasetId);

    assert.equal(doc.getContent(), mdText);
    assert.equal(doc.getMetadata().get("lines"), 12);
    assert.ok((doc.getMetadata().get<number>("words") ?? 0) > 10);
  });

  test("9: deterministic identity -> same file produces identical SHA-256 DocumentId and fingerprint", async () => {
    const filePath = join(tempDir, "deterministic.md");
    await writeFile(filePath, "# Stable Content\n\nDeterministic SHA-256 test.", "utf-8");

    const source = DatasetSource.from("file", filePath);
    const doc1 = await loader.load(source, datasetId);
    const doc2 = await loader.load(source, datasetId);

    assert.equal(doc1.getId().getValue(), doc2.getId().getValue());
    assert.equal(doc1.getFingerprint().getChecksum(), doc2.getFingerprint().getChecksum());
    assert.equal(doc1.getFingerprint().getAlgorithm(), "SHA-256");
  });

  test("10: file-size guard -> rejects files exceeding maxFileSizeBytes before reading", async () => {
    const strictLoader = new MarkdownFileLoader({ maxFileSizeBytes: 50 });
    const filePath = join(tempDir, "oversized.md");
    const largeText = "# Title\n" + "A".repeat(100);
    await writeFile(filePath, largeText, "utf-8");

    const source = DatasetSource.from("file", filePath);
    await assert.rejects(
      async () => strictLoader.load(source, datasetId),
      (err) =>
        err instanceof UnsupportedSourceError && err.message.includes("is too large to load"),
    );
  });

  test("11: missing file error -> UnsupportedSourceError", async () => {
    const source = DatasetSource.from("file", join(tempDir, "nonexistent.md"));
    await assert.rejects(
      async () => loader.load(source, datasetId),
      (err) => err instanceof UnsupportedSourceError && err.message.includes("does not exist"),
    );
  });

  test("12: directory passed as source -> UnsupportedSourceError", async () => {
    const source = DatasetSource.from("file", tempDir);
    await assert.rejects(
      async () => loader.load(source, datasetId),
      (err) => err instanceof UnsupportedSourceError && err.message.includes("is a directory"),
    );
  });

  test("13: unsupported extension (.txt, .json) -> UnsupportedSourceError", async () => {
    const txtPath = join(tempDir, "file.txt");
    await writeFile(txtPath, "Text file", "utf-8");

    const source = DatasetSource.from("file", txtPath);
    await assert.rejects(
      async () => loader.load(source, datasetId),
      (err) =>
        err instanceof UnsupportedSourceError && err.message.includes("Unsupported file extension"),
    );
  });

  test("14: invalid UTF-8 bytes -> InvalidDocumentError", async () => {
    const filePath = join(tempDir, "invalid-utf8.md");
    // 0xFF 0xFE invalid UTF-8 byte sequence
    await writeFile(filePath, Buffer.from([0xff, 0xfe, 0x31, 0x32]));

    const source = DatasetSource.from("file", filePath);
    await assert.rejects(
      async () => loader.load(source, datasetId),
      (err) => err instanceof InvalidDocumentError && err.message.includes("UTF-8"),
    );
  });

  test("15: title derivation hierarchy -> frontmatter title preferred over H1 over first heading over filename", async () => {
    // Case A: Frontmatter title present
    const fmA = join(tempDir, "titleA.md");
    await writeFile(fmA, "---\ntitle: FM Title\n---\n# H1 Title", "utf-8");
    const docA = await loader.load(DatasetSource.from("file", fmA), datasetId);
    assert.equal(docA.getMetadata().get("title"), "FM Title");

    // Case B: No frontmatter title, H1 present
    const fmB = join(tempDir, "titleB.md");
    await writeFile(fmB, "# H1 Heading\n## H2 Subheading", "utf-8");
    const docB = await loader.load(DatasetSource.from("file", fmB), datasetId);
    assert.equal(docB.getMetadata().get("title"), "H1 Heading");

    // Case C: No H1, but H2 present
    const fmC = join(tempDir, "titleC.md");
    await writeFile(fmC, "## First H2 Heading", "utf-8");
    const docC = await loader.load(DatasetSource.from("file", fmC), datasetId);
    assert.equal(docC.getMetadata().get("title"), "First H2 Heading");

    // Case D: No headings at all -> defaults to filename
    const fmD = join(tempDir, "plain-doc.md");
    await writeFile(fmD, "Just a paragraph without any headings.", "utf-8");
    const docD = await loader.load(DatasetSource.from("file", fmD), datasetId);
    assert.equal(docD.getMetadata().get("title"), "plain-doc.md");
  });
});
