import { Document } from "../entities/Document.js";
import { DatasetVersion } from "../entities/DatasetVersion.js";

export type DocumentChangeType = "content" | "metadata" | "name" | "type";

export interface ModifiedDocumentDiff {
  readonly before: Document;
  readonly after: Document;
  readonly changes: readonly DocumentChangeType[];
}

export interface DatasetDiffSummary {
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly totalModified: number;
  readonly totalUnchanged: number;
}

export interface DatasetDiffResult {
  readonly addedDocuments: readonly Document[];
  readonly removedDocuments: readonly Document[];
  readonly modifiedDocuments: readonly ModifiedDocumentDiff[];
  readonly unchangedDocuments: readonly Document[];
  readonly summary: DatasetDiffSummary;
  readonly versionA?: DatasetVersion | null;
  readonly versionB?: DatasetVersion | null;
}

export interface DatasetDiffOptions {
  versionA?: DatasetVersion | null;
  versionB?: DatasetVersion | null;
  /**
   * Optional key selector for document matching across version points.
   * Defaults to matching by DocumentId (doc.getId().getValue()).
   * If DocumentId is content-addressed (derived from content hash), pass a logical key function
   * (e.g., doc => doc.getName().getValue()) to map modifications across content updates.
   */
  getIdentityKey?: (doc: Document) => string;
}

/**
 * DatasetDiffEngine calculates differential diffs between document collections and dataset versions.
 * 
 * Identity Matching Behavior:
 * - By default, documents are matched across versions by DocumentId (`doc.getId().getValue()`).
 * - When DocumentId is a stable logical identifier, property updates (content, name, type, metadata) are classified as `modifiedDocuments`.
 * - When DocumentId is content-addressed (derived from content hash), content edits produce a new DocumentId, classifying the change as 1 removal + 1 addition.
 * - To track modifications across content-addressed updates, pass a custom `getIdentityKey` (e.g., `doc => doc.getName().getValue()`) in `DatasetDiffOptions`.
 */
export class DatasetDiffEngine {
  /**
   * Compares two document collections (and optional dataset versions or options) to compute added, removed, modified, and unchanged documents.
   */
  public static diff(
    beforeDocs: Iterable<Document>,
    afterDocs: Iterable<Document>,
    versionAOrOptions?: DatasetVersion | DatasetDiffOptions | null,
    versionBParam?: DatasetVersion | null
  ): DatasetDiffResult {
    let versionA: DatasetVersion | null = null;
    let versionB: DatasetVersion | null = null;
    let getIdentityKey: (doc: Document) => string = (d) => d.getId().getValue();

    if (versionAOrOptions && typeof versionAOrOptions === "object" && !("getVersion" in versionAOrOptions)) {
      const opts = versionAOrOptions as DatasetDiffOptions;
      versionA = opts.versionA ?? null;
      versionB = opts.versionB ?? null;
      if (opts.getIdentityKey) {
        getIdentityKey = opts.getIdentityKey;
      }
    } else {
      versionA = (versionAOrOptions as DatasetVersion | null) ?? null;
      versionB = versionBParam ?? null;
    }

    const beforeMap = new Map<string, Document>();
    for (const doc of beforeDocs) {
      beforeMap.set(getIdentityKey(doc), doc);
    }

    const afterMap = new Map<string, Document>();
    for (const doc of afterDocs) {
      afterMap.set(getIdentityKey(doc), doc);
    }

    const addedDocuments: Document[] = [];
    const removedDocuments: Document[] = [];
    const modifiedDocuments: ModifiedDocumentDiff[] = [];
    const unchangedDocuments: Document[] = [];

    // Detect added and modified/unchanged documents
    for (const [key, afterDoc] of afterMap.entries()) {
      const beforeDoc = beforeMap.get(key);
      if (!beforeDoc) {
        addedDocuments.push(afterDoc);
      } else {
        const changes = this.detectDocumentChanges(beforeDoc, afterDoc);
        if (changes.length > 0) {
          modifiedDocuments.push({
            before: beforeDoc,
            after: afterDoc,
            changes: Object.freeze(changes),
          });
        } else {
          unchangedDocuments.push(afterDoc);
        }
      }
    }

    // Detect removed documents
    for (const [key, beforeDoc] of beforeMap.entries()) {
      if (!afterMap.has(key)) {
        removedDocuments.push(beforeDoc);
      }
    }

    const summary: DatasetDiffSummary = {
      totalAdded: addedDocuments.length,
      totalRemoved: removedDocuments.length,
      totalModified: modifiedDocuments.length,
      totalUnchanged: unchangedDocuments.length,
    };

    return {
      addedDocuments: Object.freeze(addedDocuments),
      removedDocuments: Object.freeze(removedDocuments),
      modifiedDocuments: Object.freeze(modifiedDocuments),
      unchangedDocuments: Object.freeze(unchangedDocuments),
      summary,
      versionA,
      versionB,
    };
  }

  private static detectDocumentChanges(before: Document, after: Document): DocumentChangeType[] {
    const changes: DocumentChangeType[] = [];

    // Check content fingerprint / content string
    const beforeFp = before.getFingerprint() ? before.getFingerprint()!.getChecksum() : before.getContent();
    const afterFp = after.getFingerprint() ? after.getFingerprint()!.getChecksum() : after.getContent();

    if (beforeFp !== afterFp || before.getContent() !== after.getContent()) {
      changes.push("content");
    }

    if (before.getName().getValue() !== after.getName().getValue()) {
      changes.push("name");
    }

    if (before.getType() !== after.getType()) {
      changes.push("type");
    }

    // Check metadata equality using value object equals()
    if (!before.getMetadata().equals(after.getMetadata())) {
      changes.push("metadata");
    }

    return changes;
  }
}
