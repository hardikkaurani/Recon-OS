import { DatasetSource } from "../value-objects/DatasetSource.js";
import { URI } from "../value-objects/URI.js";

export interface ResolvedSource {
  readonly uri: URI;
  readonly pathOrLocation: string;
  readonly mediaType?: string;
  readonly scheme?: string;
  readonly exists?: boolean;
  readonly isDirectory?: boolean;
  readonly size?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Interface for resolving data sources to usable physical paths or locations.
 */
export interface SourceResolver {
  /**
   * Resolves a dataset source or URI to a ResolvedSource descriptor.
   * @param source - The source specification or URI to resolve
   * @returns A promise that resolves to a ResolvedSource
   */
  resolve(source: DatasetSource | URI | string): Promise<ResolvedSource>;

  /**
   * Evaluates whether this resolver supports the specified source or URI.
   * @param source - The source specification or URI to check
   * @returns True if supported, false otherwise
   */
  supports(source: DatasetSource | URI | string): boolean;
}

