import fs from "node:fs/promises";
import path from "node:path";
import { SourceResolver, ResolvedSource } from "../interfaces/SourceResolver.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { URI } from "../value-objects/URI.js";
import { InvalidDatasetError } from "../errors/DatasetError.js";

/**
 * LocalFileSourceResolver resolves local file paths and file:// URIs into ResolvedSource descriptors.
 */
export class LocalFileSourceResolver implements SourceResolver {
  private static readonly EXTENSION_MEDIA_TYPES: Record<string, string> = {
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".ndjson": "application/x-ndjson",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".md": "text/markdown",
    ".xml": "application/xml",
    ".html": "text/html",
    ".parquet": "application/vnd.apache.parquet",
  };

  public supports(source: DatasetSource | URI | string): boolean {
    const rawUri = this.extractRawUri(source);
    if (!rawUri) return false;

    // Reject non-local network schemes
    if (/^(https?|s3|gs|azure|ftp):\/\//i.test(rawUri)) {
      return false;
    }

    return true;
  }

  public async resolve(source: DatasetSource | URI | string): Promise<ResolvedSource> {
    if (!this.supports(source)) {
      const rawUri = this.extractRawUri(source);
      throw new InvalidDatasetError(`Unsupported local file source URI: "${rawUri}"`);
    }

    const rawUri = this.extractRawUri(source);
    const normalizedPath = this.normalizeFilePath(rawUri);
    const absPath = path.resolve(normalizedPath);

    let exists = false;
    let isDirectory = false;
    let size = 0;

    try {
      const stats = await fs.stat(absPath);
      exists = true;
      isDirectory = stats.isDirectory();
      size = stats.size;
    } catch {
      exists = false;
      isDirectory = false;
      size = 0;
    }

    const ext = path.extname(absPath).toLowerCase();
    const mediaType = LocalFileSourceResolver.EXTENSION_MEDIA_TYPES[ext] ?? "application/octet-stream";

    return {
      uri: URI.from(absPath),
      pathOrLocation: absPath,
      mediaType,
      scheme: "file",
      exists,
      isDirectory,
      size,
      metadata: {
        extension: ext,
        absolutePath: absPath,
      },
    };
  }

  private extractRawUri(source: DatasetSource | URI | string): string {
    if (typeof source === "string") return source.trim();
    if (source instanceof URI) return source.getValue();
    if (source && typeof source.getUri === "function") return source.getUri();
    return "";
  }

  private normalizeFilePath(rawUri: string): string {
    if (rawUri.startsWith("file://")) {
      let fileUrlPath = rawUri.slice(7);
      // Windows URI file:///C:/path handling
      if (/^\/[a-zA-Z]:/.test(fileUrlPath)) {
        fileUrlPath = fileUrlPath.slice(1);
      }
      return decodeURIComponent(fileUrlPath);
    }
    return rawUri;
  }
}
