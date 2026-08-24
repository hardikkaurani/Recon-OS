import { InvalidDatasetError } from "../errors/DatasetError.js";

/**
 * Version identifier (e.g., '1.0.0', 'v1.4.2').
 * Immutable value object protecting version formatting and equality invariants.
 */
export class Version {
  private readonly value: string;
  private readonly major: number;
  private readonly minor: number;
  private readonly patch: number;
  private readonly prerelease: string | null;
  private readonly buildMetadata: string | null;

  constructor(value: string) {
    if (!value || typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidDatasetError("Version must be a non-empty string");
    }
    const trimmed = value.trim();
    const match = /^([vV])?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/.exec(
      trimmed
    );
    if (!match) {
      throw new InvalidDatasetError(`Invalid version format: "${trimmed}"`);
    }

    this.value = trimmed;
    this.major = parseInt(match[2] ?? "0", 10);
    this.minor = parseInt(match[3] ?? "0", 10);
    this.patch = parseInt(match[4] ?? "0", 10);
    this.prerelease = match[5] ?? null;
    this.buildMetadata = match[6] ?? null;
  }

  public getValue(): string {
    return this.value;
  }

  public getMajor(): number {
    return this.major;
  }

  public getMinor(): number {
    return this.minor;
  }

  public getPatch(): number {
    return this.patch;
  }

  public getPrerelease(): string | null {
    return this.prerelease;
  }

  public getBuildMetadata(): string | null {
    return this.buildMetadata;
  }

  public equals(other: Version): boolean {
    return Boolean(other && this.compare(other) === 0);
  }

  /**
   * Compares this version with another version according to SemVer 2.0 precedence rules.
   * Note: Build metadata (+...) is ignored when determining version precedence.
   * @returns < 0 if this < other, 0 if equal precedence, > 0 if this > other
   */
  public compare(other: Version): number {
    if (!other) return 1;
    if (this.major !== other.major) return this.major - other.major;
    if (this.minor !== other.minor) return this.minor - other.minor;
    if (this.patch !== other.patch) return this.patch - other.patch;

    // A normal version has higher precedence than a pre-release version
    if (this.prerelease === null && other.prerelease !== null) return 1;
    if (this.prerelease !== null && other.prerelease === null) return -1;
    if (this.prerelease !== null && other.prerelease !== null) {
      return this.comparePrerelease(this.prerelease, other.prerelease);
    }
    return 0;
  }

  private comparePrerelease(aStr: string, bStr: string): number {
    const aParts = aStr.split(".");
    const bParts = bStr.split(".");
    const minLen = Math.min(aParts.length, bParts.length);

    for (let i = 0; i < minLen; i++) {
      const aPart = aParts[i];
      const bPart = bParts[i];

      const aIsNum = /^\d+$/.test(aPart);
      const bIsNum = /^\d+$/.test(bPart);

      if (aIsNum && bIsNum) {
        const numA = parseInt(aPart, 10);
        const numB = parseInt(bPart, 10);
        if (numA !== numB) {
          return numA - numB;
        }
      } else if (aIsNum && !bIsNum) {
        // Numeric identifiers always have lower precedence than non-numeric identifiers
        return -1;
      } else if (!aIsNum && bIsNum) {
        return 1;
      } else {
        const lexComp = aPart.localeCompare(bPart);
        if (lexComp !== 0) {
          return lexComp;
        }
      }
    }

    // A larger set of pre-release fields has a higher precedence than a smaller set
    return aParts.length - bParts.length;
  }

  public isGreaterThan(other: Version): boolean {
    return this.compare(other) > 0;
  }

  public isLessThan(other: Version): boolean {
    return this.compare(other) < 0;
  }

  /**
   * Returns a new Version incremented by major version.
   */
  public incrementMajor(): Version {
    const hasVPrefix = /^v/i.test(this.value);
    const prefix = hasVPrefix ? this.value[0] : "";
    return new Version(`${prefix}${this.major + 1}.0.0`);
  }

  /**
   * Returns a new Version incremented by minor version.
   */
  public incrementMinor(): Version {
    const hasVPrefix = /^v/i.test(this.value);
    const prefix = hasVPrefix ? this.value[0] : "";
    return new Version(`${prefix}${this.major}.${this.minor + 1}.0`);
  }

  /**
   * Returns a new Version incremented by patch version.
   */
  public incrementPatch(): Version {
    const hasVPrefix = /^v/i.test(this.value);
    const prefix = hasVPrefix ? this.value[0] : "";
    return new Version(`${prefix}${this.major}.${this.minor}.${this.patch + 1}`);
  }

  /**
   * Returns a new Version incremented by release type.
   */
  public increment(releaseType: "major" | "minor" | "patch"): Version {
    switch (releaseType) {
      case "major":
        return this.incrementMajor();
      case "minor":
        return this.incrementMinor();
      case "patch":
        return this.incrementPatch();
      default:
        throw new InvalidDatasetError(`Invalid release type: "${releaseType}"`);
    }
  }

  public toString(): string {
    return this.value;
  }

  public static from(value: string): Version {
    return new Version(value);
  }

  public static initial(): Version {
    return new Version("1.0.0");
  }
}
