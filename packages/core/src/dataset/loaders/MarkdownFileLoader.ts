import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";

import { BaseFileLoader } from "./BaseFileLoader.js";
import { LocalFileSourceResolver } from "../resolvers/LocalFileSourceResolver.js";
import { MimeType } from "../value-objects/MimeType.js";
import { DocumentType } from "../enums/DocumentType.js";
import { DatasetId } from "../value-objects/DatasetId.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { DocumentId } from "../value-objects/DocumentId.js";
import { DocumentName } from "../value-objects/DocumentName.js";
import { DocumentFingerprint } from "../value-objects/DocumentFingerprint.js";
import { DocumentMetadata } from "../value-objects/DocumentMetadata.js";
import { Document } from "../entities/Document.js";
import { UnsupportedSourceError } from "../errors/DatasetError.js";

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown"]);

/**
 * Representation of an extracted Markdown section heading.
 */
export interface MarkdownHeading {
  level: number;
  title: string;
  line: number;
}

/**
 * Loads local Markdown files (.md, .markdown) into Recon-OS {@link Document} entities.
 *
 * Implements YAML and JSON frontmatter extraction, header-aware hierarchy parsing (H1-H6)
 * excluding code blocks, and populates document structure statistics in {@link DocumentMetadata}.
 */
export class MarkdownFileLoader extends BaseFileLoader {
  /**
   * Creates a new `MarkdownFileLoader`.
   *
   * @param options.maxFileSizeBytes - Maximum file size in bytes before load is rejected.
   *   Defaults to 10 MiB.
   */
  constructor({ maxFileSizeBytes }: { maxFileSizeBytes?: number } = {}) {
    super(new LocalFileSourceResolver(), { maxFileSizeBytes });
  }

  protected getSupportedExtensions(): ReadonlySet<string> {
    return SUPPORTED_EXTENSIONS;
  }

  protected getMimeType(_ext: string): MimeType {
    return MimeType.from("text/markdown");
  }

  protected getDocumentType(_ext: string): DocumentType {
    return DocumentType.MARKDOWN;
  }

  /**
   * Loads a Markdown file, parses frontmatter and heading hierarchy, and constructs a Document.
   */
  public override async load(source: DatasetSource, datasetId: DatasetId): Promise<Document> {
    const resolved = await this.resolver.resolve(source);
    if (resolved.exists === false) {
      throw new UnsupportedSourceError(
        `Local file source "${resolved.pathOrLocation}" does not exist`,
      );
    }
    if (resolved.isDirectory === true) {
      throw new UnsupportedSourceError(
        `Local file source "${resolved.pathOrLocation}" is a directory, not a file`,
      );
    }

    const ext = this.extractExtension(resolved.pathOrLocation);
    this.assertSupportedExtension(ext, resolved.pathOrLocation);

    await this.assertFileSizeWithinLimit(resolved.pathOrLocation);

    const rawBuffer = await readFile(resolved.pathOrLocation);

    // Deterministic SHA-256 fingerprint from raw file bytes
    const sha256hex = createHash("sha256").update(rawBuffer).digest("hex");
    const fingerprint = DocumentFingerprint.from(sha256hex, "SHA-256");

    // Strict UTF-8 decode
    const content = this.decodeUtf8(rawBuffer, resolved.pathOrLocation);

    // Frontmatter and heading extraction
    const { frontmatter, frontmatterError } = this.parseFrontmatter(content);
    const headings = this.extractHeadings(content);

    const lines = content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
    const words =
      content.trim().length === 0 ? 0 : content.trim().split(/\s+/).filter(Boolean).length;
    const characters = content.length;

    // Derive primary title: frontmatter title -> first H1 -> first heading -> filename
    let title: string | undefined;
    if (typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0) {
      title = frontmatter.title.trim();
    } else {
      const h1 = headings.find((h) => h.level === 1);
      if (h1) {
        title = h1.title;
      } else if (headings.length > 0) {
        title = headings[0].title;
      } else {
        title = basename(resolved.pathOrLocation);
      }
    }

    const mimeValue =
      resolved.mediaType && resolved.mediaType !== "application/octet-stream"
        ? resolved.mediaType
        : this.getMimeType(ext).getValue();
    const mime = MimeType.from(mimeValue);

    const filename = basename(resolved.pathOrLocation);
    const sizeBytes = rawBuffer.byteLength;

    const metadataMap: Record<string, unknown> = {
      filename,
      extension: ext,
      mimeType: mime.getValue(),
      sourceUri: resolved.uri.getValue(),
      sourcePath: resolved.pathOrLocation,
      sizeBytes,
      lines,
      words,
      characters,
      title,
      headings,
      sectionsCount: headings.length,
      frontmatter,
    };

    if (frontmatterError) {
      metadataMap.frontmatterError = frontmatterError;
    }

    // Lift standard frontmatter properties to top-level metadata if present
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!(key in metadataMap) && value !== undefined) {
        metadataMap[key] = value;
      }
    }

    const metadata = DocumentMetadata.from(metadataMap);
    const id = DocumentId.from(sha256hex);
    const name = DocumentName.from(filename);

    return new Document({
      id,
      datasetId,
      name,
      type: DocumentType.MARKDOWN,
      content,
      fingerprint,
      metadata,
    });
  }

  /**
   * Parses YAML or JSON frontmatter blocks from Markdown text.
   */
  protected parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    frontmatterError?: string;
  } {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("---")) {
      // YAML frontmatter delimited by ---
      const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) {
        return {
          frontmatter: {},
          frontmatterError: "Unclosed YAML frontmatter delimiter (expected closing '---')",
        };
      }
      try {
        const parsed = this.parseSimpleYaml(match[1]);
        return { frontmatter: parsed };
      } catch (err) {
        return {
          frontmatter: {},
          frontmatterError: `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (trimmed.startsWith(";;;")) {
      // Alternate delimiter ;;;
      const match = trimmed.match(/^;;;\r?\n([\s\S]*?)\r?\n;;;(?:\r?\n|$)/);
      if (!match) {
        return {
          frontmatter: {},
          frontmatterError: "Unclosed frontmatter delimiter (expected closing ';;;')",
        };
      }
      try {
        const parsed = JSON.parse(match[1].trim());
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return { frontmatter: parsed as Record<string, unknown> };
        }
        return { frontmatter: { data: parsed } };
      } catch (err) {
        return {
          frontmatter: {},
          frontmatterError: `Failed to parse JSON frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { frontmatter: {} };
  }

  /**
   * Minimal pure TypeScript YAML parser for frontmatter key-values, lists, and primitives.
   */
  private parseSimpleYaml(yamlText: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yamlText.split(/\r?\n/);
    let currentKey: string | null = null;
    let currentList: unknown[] | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }

      // List item under an ongoing list: "- item"
      if (line.startsWith("- ") && currentKey && currentList) {
        const itemVal = this.parseYamlValue(line.slice(2).trim());
        currentList.push(itemVal);
        continue;
      }

      // Key-value pair: "key: value" or "key:"
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        if (currentKey && currentList) {
          result[currentKey] = currentList;
          currentKey = null;
          currentList = null;
        }

        const key = line.slice(0, colonIdx).trim();
        const rawVal = line.slice(colonIdx + 1).trim();

        if (rawVal.length === 0) {
          // Possible list starts on next lines
          currentKey = key;
          currentList = [];
        } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
          // Inline array: [a, b, c]
          const items = rawVal
            .slice(1, -1)
            .split(",")
            .map((s) => this.parseYamlValue(s.trim()))
            .filter((v) => v !== "");
          result[key] = items;
        } else {
          result[key] = this.parseYamlValue(rawVal);
        }
      }
    }

    if (currentKey && currentList) {
      result[currentKey] = currentList;
    }

    return result;
  }

  /**
   * Parses primitive YAML values (boolean, number, quoted string, null).
   */
  private parseYamlValue(val: string): unknown {
    if (val === "true" || val === "True") return true;
    if (val === "false" || val === "False") return false;
    if (val === "null" || val === "~" || val === "") return null;
    if (!isNaN(Number(val)) && !val.startsWith("0x")) {
      return Number(val);
    }
    // Strip matching quotes if wrapped
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }
    return val;
  }

  /**
   * Extracts heading hierarchy (H1-H6) strictly outside fenced code blocks.
   */
  protected extractHeadings(content: string): MarkdownHeading[] {
    const headings: MarkdownHeading[] = [];
    const lines = content.split(/\r?\n/);

    let inCodeBlock = false;
    let fenceChar = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check for code fence start/end (``` or ~~~)
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        const currentFence = trimmed.slice(0, 3);
        if (!inCodeBlock) {
          inCodeBlock = true;
          fenceChar = currentFence;
        } else if (fenceChar === currentFence) {
          inCodeBlock = false;
          fenceChar = "";
        }
        continue;
      }

      if (inCodeBlock) {
        continue;
      }

      // ATX headings: # through ######
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        let title = match[2].trim();
        // Strip optional closing hashes (# Heading #)
        title = title.replace(/\s+#+$/, "").trim();
        headings.push({
          level,
          title,
          line: i + 1,
        });
      }
    }

    return headings;
  }
}
