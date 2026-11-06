import type { App } from 'obsidian';

const mutations = new WeakMap<object, Promise<void>>();

/**
 * Serialize first-party file-tool preparation AND commit across instances sharing
 * an adapter. The vault-wide queue also covers alias/portable targets resolved
 * during preparation and multi-file batches without nested-lock deadlocks.
 * This is not CAS against external processes, sync, or other adapter writers.
 * Indexed edits retain Vault.process's host-owned compare-and-write guard.
 */
export function withVaultFileMutation<T>(app: App, operation: () => Promise<T>): Promise<T> {
  const owner = app.vault.adapter ?? app.vault;
  const pending = (mutations.get(owner) ?? Promise.resolve()).then(operation);
  const settled = pending.then(() => undefined, () => undefined);
  mutations.set(owner, settled);
  void settled.then(() => {
    if (mutations.get(owner) === settled) mutations.delete(owner);
  });
  return pending;
}
