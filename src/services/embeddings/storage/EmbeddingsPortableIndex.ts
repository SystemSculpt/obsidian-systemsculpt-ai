/**
 * EmbeddingsPortableIndex - the restore/snapshot decision logic that ties the
 * IndexedDB store to the vault-relative snapshot file.
 *
 * Kept dependency-light (small interfaces, no IndexedDB/Obsidian imports) so the
 * decisions — "restore only into an empty store", "never write an empty
 * snapshot" — are unit-testable with fakes and the EmbeddingsManager wiring stays
 * a thin call.
 */

import type { SerializedEmbeddingsIndex } from "./EmbeddingsIndexSerialization";

export interface PortableIndexStore {
  countVectors(): Promise<number>;
  exportAll(): Promise<SerializedEmbeddingsIndex>;
  importAll(index: SerializedEmbeddingsIndex): Promise<{ imported: number }>;
}

export interface PortableIndexFile {
  read(): Promise<SerializedEmbeddingsIndex | null>;
  write(index: SerializedEmbeddingsIndex): Promise<void>;
}

export interface RestoreResult {
  restored: boolean;
  imported: number;
  reason: "restored" | "store-not-empty" | "no-snapshot" | "empty-snapshot";
}

export interface WriteResult {
  written: boolean;
  count: number;
}

/**
 * Restore the index from the vault snapshot, but only when the local store is
 * empty (a fresh device / wiped IndexedDB). A populated store always wins so we
 * never clobber newer local vectors with a stale snapshot — mirroring the
 * existing legacy-DB import guard.
 */
export async function restoreEmbeddingsIndexIfEmpty(deps: {
  store: PortableIndexStore;
  file: PortableIndexFile;
}): Promise<RestoreResult> {
  const { store, file } = deps;

  const count = await store.countVectors();
  if (count > 0) {
    return { restored: false, imported: 0, reason: "store-not-empty" };
  }

  const snapshot = await file.read();
  if (!snapshot) {
    return { restored: false, imported: 0, reason: "no-snapshot" };
  }

  const { imported } = await store.importAll(snapshot);
  if (imported > 0) {
    return { restored: true, imported, reason: "restored" };
  }
  return { restored: false, imported: 0, reason: "empty-snapshot" };
}

/**
 * Write the current store to the vault snapshot. Skips an empty index so we
 * don't overwrite a good snapshot with nothing (e.g. before the first embed).
 */
export async function writeEmbeddingsIndexSnapshot(deps: {
  store: PortableIndexStore;
  file: PortableIndexFile;
}): Promise<WriteResult> {
  const { store, file } = deps;

  const index = await store.exportAll();
  if (index.vectorCount === 0) {
    return { written: false, count: 0 };
  }

  await file.write(index);
  return { written: true, count: index.vectorCount };
}
