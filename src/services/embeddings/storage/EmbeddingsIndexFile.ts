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

  constructor(
    private readonly adapter: DataAdapter,
    options: EmbeddingsIndexFileOptions = {},
  ) {
    this.dir = options.dir ?? DEFAULT_DIR;
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.filePath = `${this.dir}/${fileName}`;
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
   * Read and JSON-parse the snapshot. Returns null when absent or unparseable
   * (a partially-synced or hand-edited file must never crash startup).
   */
  public async read(): Promise<SerializedEmbeddingsIndex | null> {
    try {
      if (!(await this.adapter.exists(this.filePath))) return null;
      const text = await this.adapter.read(this.filePath);
      return JSON.parse(text) as SerializedEmbeddingsIndex;
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
    await this.adapter.write(this.filePath, JSON.stringify(index));
  }
}
