import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SourceResolver, ResolvedSource } from "../interfaces/SourceResolver.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { URI } from "../value-objects/URI.js";
import { UnsupportedSourceError } from "../errors/DatasetError.js";

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
    ".markdown": "text/markdown",
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
      throw new UnsupportedSourceError(`Unsupported local file source URI: "${rawUri}"`);
    }

    const rawUri = this.extractRawUri(source);
    const normalizedPath = this.normalizeFilePath(rawUri);
    const absPath = path.resolve(normalizedPath);

    let exists = false;
    let isDirectory = false;
    let size = 0;

    try {
      const stats = await fs.stat(absPath);
      if (stats.isDirectory()) {
        throw new UnsupportedSourceError(`Local file source "${absPath}" is a directory, not a file`);
      }
      exists = true;
      isDirectory = false;
      size = stats.size;
    } catch (err) {
      if (err instanceof UnsupportedSourceError) throw err;
      const code = (err as { code?: string }).code;
      const reason =
        code === "ENOENT"
          ? "does not exist"
          : code === "EACCES"
            ? "is not accessible (permission denied)"
            : `could not be accessed (${code ?? "unknown error"})`;
      throw new UnsupportedSourceError(`Local file source "${absPath}" ${reason}`, { cause: err });
    }

    const ext = path.extname(absPath).toLowerCase();
    const mediaType = LocalFileSourceResolver.EXTENSION_MEDIA_TYPES[ext];
    const fileUrl = pathToFileURL(absPath).href;

    return {
      uri: URI.from(fileUrl),
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
      try {
        return fileURLToPath(rawUri);
      } catch {
        // Fallback for non-standard file URIs
      }
    }
    return rawUri;
  }
}
