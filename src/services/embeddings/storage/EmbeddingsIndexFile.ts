/**
 * EmbeddingsIndexFile - reads/writes the portable embedding snapshot to a
 * vault-relative path through Obsidian's `DataAdapter`.
 *
 * Living in the vault (default `.systemsculpt/embeddings/index.json`, alongside
 * `.systemsculpt/diagnostics`) is what lets Obsidian Sync/backup capture and
 * restore the index — unlike the per-device IndexedDB store.
 *
 * Uses only the Obsidian `DataAdapter` (read/write/exists/mkdir), including
 * adapters without a Node base path; no `node:fs`, so this stays within the
 * no-eager-node-import boundary the embeddings tree relies on.
 */

import type { DataAdapter } from "obsidian";
import type { SerializedEmbeddingsIndex } from "./EmbeddingsIndexSerialization";

const DEFAULT_DIR = ".systemsculpt/embeddings";
const DEFAULT_FILE_NAME = "index.json";

export interface EmbeddingsIndexFileOptions {
  dir?: string;
  fileName?: string;
}

export class EmbeddingsIndexFile {
  private readonly dir: string;
  private readonly filePath: string;
  /** Last good snapshot parked here while a replace is in flight. */
  private readonly previousPath: string;

  constructor(
    private readonly adapter: DataAdapter,
    options: EmbeddingsIndexFileOptions = {},
  ) {
    this.dir = options.dir ?? DEFAULT_DIR;
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.filePath = `${this.dir}/${fileName}`;
    this.previousPath = `${this.filePath}.previous`;
  }

  public getPath(): string {
    return this.filePath;
  }

  public async exists(): Promise<boolean> {
    try {
      return await this.adapter.exists(this.filePath);
    } catch {
      return false;
    }
  }

  /**
   * Read and JSON-parse the snapshot. Falls back to the `.previous` checkpoint
   * that an interrupted replace leaves behind. Returns null when neither is
   * present or parseable (a partially-synced or hand-edited file must never
   * crash startup).
   */
  public async read(): Promise<SerializedEmbeddingsIndex | null> {
    return (await this.readCandidate(this.filePath)) ?? this.readCandidate(this.previousPath);
  }

  private async readCandidate(path: string): Promise<SerializedEmbeddingsIndex | null> {
    try {
      if (!(await this.adapter.exists(path))) return null;
      const parsed = JSON.parse(await this.adapter.read(path)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as SerializedEmbeddingsIndex
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Write the snapshot, creating the directory if needed.
   */
  public async write(index: SerializedEmbeddingsIndex): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) {
      await this.adapter.mkdir(this.dir);
    }
    const serialized = JSON.stringify(index);
    const tempPath = `${this.filePath}.next`;
    if (typeof this.adapter.rename !== "function") {
      await this.adapter.write(this.filePath, serialized);
      return;
    }
    const backupPath = this.previousPath;
    try {
      await this.adapter.write(tempPath, serialized);
      await this.adapter.rename(tempPath, this.filePath);
    } catch (replaceError) {
      let movedPrevious = false;
      try {
        if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
        if (await this.adapter.exists(this.filePath)) {
          await this.adapter.rename(this.filePath, backupPath);
          movedPrevious = true;
        }
        await this.adapter.rename(tempPath, this.filePath);
        if (movedPrevious && await this.adapter.exists(backupPath)) {
          await this.adapter.remove(backupPath);
        }
      } catch {
        // Rollback is best effort: if it fails, the last good snapshot still
        // sits at `.previous`, which read() falls back to. Never let a
        // rollback failure replace the original error or skip temp cleanup.
        if (movedPrevious) {
          try {
            if (!(await this.adapter.exists(this.filePath))) {
              await this.adapter.rename(backupPath, this.filePath);
            }
          } catch { /* the .previous checkpoint remains readable */ }
        }
        try {
          if (await this.adapter.exists(tempPath)) await this.adapter.remove(tempPath);
        } catch { /* temporary cleanup is best effort */ }
        throw replaceError;
      }
    }
  }

  public async remove(): Promise<void> {
    if (await this.adapter.exists(this.filePath)) await this.adapter.remove(this.filePath);
  }
}
