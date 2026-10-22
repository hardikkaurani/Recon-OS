import { SourceResolver, ResolvedSource } from "../interfaces/SourceResolver.js";
import { DatasetSource } from "../value-objects/DatasetSource.js";
import { URI } from "../value-objects/URI.js";
import { UnsupportedSourceError } from "../errors/DatasetError.js";

/**
 * Resolves remote HTTP and HTTPS URLs into ResolvedSource descriptors.
 */
export class HttpSourceResolver implements SourceResolver {
    public supports(source: DatasetSource | URI | string): boolean {
        const rawUri = this.extractRawUri(source);
        if (!rawUri) return false;
        return /^https?:\/\//i.test(rawUri);
    }

    public async resolve(source: DatasetSource | URI | string): Promise<ResolvedSource> {
        if (!this.supports(source)) {
            const rawUri = this.extractRawUri(source);
            throw new UnsupportedSourceError(
                `Unsupported HTTP source URI: "${rawUri}". Expected an http:// or https:// URL.`,
            );
        }

        const rawUri = this.extractRawUri(source);
        let parsed: URL;
        try {
            parsed = new URL(rawUri);
        } catch (cause) {
            throw new UnsupportedSourceError(`Invalid HTTP URL: "${rawUri}"`, { cause });
        }

        const scheme = parsed.protocol.replace(":", "").toLowerCase();
        const uri = URI.from(rawUri);

        return {
            uri,
            pathOrLocation: rawUri,
            scheme,
            metadata: {
                host: parsed.host,
                hostname: parsed.hostname,
                port: parsed.port,
                pathname: parsed.pathname,
                search: parsed.search,
            },
        };
    }

    private extractRawUri(source: DatasetSource | URI | string): string {
        if (typeof source === "string") return source.trim();
        if (source instanceof URI) return source.getValue();
        if (source && typeof source.getUri === "function") return source.getUri();
        return "";
    }
}
