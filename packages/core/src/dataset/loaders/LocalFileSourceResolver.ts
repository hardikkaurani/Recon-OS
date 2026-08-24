import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { URI } from "../value-objects/URI.js";
import { UnsupportedSourceError } from "../errors/DatasetError.js";
import { ResolvedSource, SourceResolver } from "../interfaces/SourceResolver.js";

/**
 * Resolves local filesystem sources into {@link ResolvedSource} descriptors
 * that downstream loaders can consume.
 *
 * Responsibilities:
 * - Validate that the source type is `"file"`.
 * - Verify the path exists and is a regular file (not a directory).
 * - Produce a platform-correct `file:///` URI via {@link pathToFileURL}.
 * - Translate low-level filesystem errors into {@link UnsupportedSourceError}.
 *
 * This resolver does **not** know which document formats any downstream loader
 * supports, and does **not** set `mediaType`. Format mapping is the exclusive
 * responsibility of the loader.
 *
 * This resolver does **not** read or parse file content.
 */
export class LocalFileSourceResolver implements SourceResolver {
    /**
     * Resolves a `DatasetSource` or `URI` to a {@link ResolvedSource}.
     *
     * @param source - Must be a `DatasetSource` with `type === "file"`, or a
     *   `URI` whose value is a local filesystem path.
     * @returns A promise resolving to a {@link ResolvedSource} with the absolute
     *   path and a platform-correct file URI. `mediaType` is always `undefined` —
     *   format classification is deferred to the loader.
     * @throws {UnsupportedSourceError} if the source type is not `"file"`, the
     *   path does not exist, is a directory, or cannot be accessed.
     */
    public async resolve(source: DatasetSource | URI): Promise<ResolvedSource> {
        const rawPath = this.extractPath(source);
        const absolutePath = resolvePath(rawPath);

        await this.validatePath(absolutePath);

        // pathToFileURL handles Windows drive letters (C:\) and path separators
        // correctly, producing well-formed file:///C:/... URIs. Never concatenate
        // "file://" + path manually.
        const fileUrl = pathToFileURL(absolutePath).href;
        const uri = URI.from(fileUrl);

        return {
            uri,
            pathOrLocation: absolutePath,
            // mediaType is intentionally undefined: format mapping belongs to
            // the loader, not the resolver.
        };
    }

    /**
     * Extracts the raw filesystem path from a `DatasetSource` or `URI`.
     *
     * @throws {UnsupportedSourceError} if the source type is not `"file"`.
     */
    private extractPath(source: DatasetSource | URI): string {
        if (source instanceof URI) {
            return source.getValue();
        }

        const type = source.getType();
        if (type !== "file") {
            throw new UnsupportedSourceError(
                `LocalFileSourceResolver only handles "file" sources, got "${type}"`,
            );
        }

        return source.getUri();
    }

    /**
     * Validates that the path exists, is readable, and is a regular file.
     *
     * The original filesystem error is preserved as the `cause` of the thrown
     * {@link UnsupportedSourceError} so callers retain full debugging information.
     *
     * @throws {UnsupportedSourceError} for ENOENT, EACCES, EISDIR, or unexpected
     *   stat errors.
     */
    private async validatePath(absolutePath: string): Promise<void> {
        let stats;
        try {
            stats = await stat(absolutePath);
        } catch (err) {
            const code = (err as { code?: string }).code;
            const reason =
                code === "ENOENT"
                    ? "does not exist"
                    : code === "EACCES"
                        ? "is not accessible (permission denied)"
                        : `could not be accessed (${code ?? "unknown error"})`;

            throw new UnsupportedSourceError(
                `Local file source "${absolutePath}" ${reason}`,
                { cause: err },
            );
        }

        if (!stats.isFile()) {
            throw new UnsupportedSourceError(
                `Local file source "${absolutePath}" is a directory, not a file`,
            );
        }
    }
}
