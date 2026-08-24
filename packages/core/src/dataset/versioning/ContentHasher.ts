import createHash from "node:crypto";
import { Readable } from "node:stream";
import { Checksum } from "../value-objects/Checksum.js";
import { Dataset } from "../entities/Dataset.js";
import { Document } from "../entities/Document.js";

/**
 * ContentHasher provides deterministic content-addressable checksum hashing
 * using SHA-256 cryptographic digests.
 */
export class ContentHasher {
  /**
   * Hashes a raw string payload deterministically using SHA-256.
   */
  public static hashString(content: string, algorithm: string = "sha256"): Checksum {
    const hash = createHash.createHash(algorithm);
    hash.update(content, "utf8");
    return Checksum.from(hash.digest("hex"), algorithm);
  }

  /**
   * Hashes a Buffer payload deterministically using SHA-256.
   */
  public static hashBuffer(buffer: Buffer, algorithm: string = "sha256"): Checksum {
    const hash = createHash.createHash(algorithm);
    hash.update(buffer);
    return Checksum.from(hash.digest("hex"), algorithm);
  }

  /**
   * Hashes a stream safely without accumulating entire payload in memory.
   */
  public static async hashStream(stream: Readable, algorithm: string = "sha256"): Promise<Checksum> {
    return new Promise<Checksum>((resolve, reject) => {
      const hash = createHash.createHash(algorithm);
      stream.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      stream.on("end", () => {
        resolve(Checksum.from(hash.digest("hex"), algorithm));
      });
      stream.on("error", (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Hashes a dataset and its documents in a deterministic, sorted order.
   */
  public static hashDataset(
    dataset: Dataset,
    documents: Iterable<Document> = [],
    algorithm: string = "sha256"
  ): Checksum {
    const hash = createHash.createHash(algorithm);

    // Hash dataset identity & core attributes
    hash.update(`id:${dataset.getId().getValue()};`);
    hash.update(`name:${dataset.getName().getValue()};`);
    hash.update(`version:${dataset.getVersion().getValue()};`);

    // Sort documents deterministically by Document ID
    const sortedDocs = Array.from(documents).sort((a, b) =>
      a.getId().getValue().localeCompare(b.getId().getValue())
    );

    for (const doc of sortedDocs) {
      hash.update(`doc:${doc.getId().getValue()};`);
      hash.update(`name:${doc.getName().getValue()};`);
      hash.update(`type:${doc.getType()};`);
      const fp = doc.getFingerprint() ? doc.getFingerprint()!.getChecksum() : doc.getContent();
      hash.update(`content:${fp};`);
    }

    return Checksum.from(hash.digest("hex"), algorithm);
  }
}
