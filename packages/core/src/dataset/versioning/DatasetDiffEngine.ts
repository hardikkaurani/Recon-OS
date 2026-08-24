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

/**
 * DatasetDiffEngine calculates differential diffs between document collections and dataset versions.
 */
export class DatasetDiffEngine {
  /**
   * Compares two document collections (and optional dataset versions) to compute added, removed, modified, and unchanged documents.
   */
  public static diff(
    beforeDocs: Iterable<Document>,
    afterDocs: Iterable<Document>,
    versionA?: DatasetVersion | null,
    versionB?: DatasetVersion | null
  ): DatasetDiffResult {
    const beforeMap = new Map<string, Document>();
    for (const doc of beforeDocs) {
      beforeMap.set(doc.getId().getValue(), doc);
    }

    const afterMap = new Map<string, Document>();
    for (const doc of afterDocs) {
      afterMap.set(doc.getId().getValue(), doc);
    }

    const addedDocuments: Document[] = [];
    const removedDocuments: Document[] = [];
    const modifiedDocuments: ModifiedDocumentDiff[] = [];
    const unchangedDocuments: Document[] = [];

    // Detect added and modified/unchanged documents
    for (const [id, afterDoc] of afterMap.entries()) {
      const beforeDoc = beforeMap.get(id);
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
    for (const [id, beforeDoc] of beforeMap.entries()) {
      if (!afterMap.has(id)) {
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
      versionA: versionA ?? null,
      versionB: versionB ?? null,
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
