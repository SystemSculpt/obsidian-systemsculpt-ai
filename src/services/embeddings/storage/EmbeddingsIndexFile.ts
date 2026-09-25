/**
 * EmbeddingsIndexFile - reads/writes the portable embedding snapshot files
 * through Obsidian's `DataAdapter`: the `index.json` manifest (or an older
 * release's single-file index) plus the binary shard files beside it.
 *
 * Living in the vault (default `.systemsculpt/embeddings/`, alongside
 * `.systemsculpt/diagnostics`) is what lets file-level vault sync and backups
 * (iCloud, Dropbox, Syncthing, git) carry the index to another device, unlike
 * the per-device IndexedDB store. Obsidian Sync skips dot-folders, so it does
 * not. Every rewrite is uploaded by those tools, which is why writes are rare.
 *
 * Uses only the Obsidian `DataAdapter` (read/write/exists/mkdir), including
 * adapters without a Node base path; no `node:fs`, so this stays within the
 * no-eager-node-import boundary the embeddings tree relies on.
 */

import type { DataAdapter } from "obsidian";

const DEFAULT_DIR = ".systemsculpt/embeddings";
const DEFAULT_FILE_NAME = "index.json";
const SHARD_DIR_NAME = "shards";
const SHARD_FILE = /^(\d{2,4})\.bin$/;

export interface EmbeddingsIndexFileOptions {
  dir?: string;
  fileName?: string;
}

export class EmbeddingsIndexFile {
  private readonly dir: string;
  private readonly filePath: string;
  /** Last good snapshot parked here while a replace is in flight. */
  private readonly previousPath: string;
  private readonly shardDir: string;

  constructor(
    private readonly adapter: DataAdapter,
    options: EmbeddingsIndexFileOptions = {},
  ) {
    this.dir = options.dir ?? DEFAULT_DIR;
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.filePath = `${this.dir}/${fileName}`;
    this.previousPath = `${this.filePath}.previous`;
    this.shardDir = `${this.dir}/${SHARD_DIR_NAME}`;
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
  public async read(): Promise<Record<string, unknown> | null> {
    return (await this.readCandidate(this.filePath)) ?? this.readCandidate(this.previousPath);
  }

  /** Byte size of `index.json`, or null when it is missing or unreadable. */
  public async size(): Promise<number | null> {
    try {
      const stat = await this.adapter.stat(this.filePath);
      return stat && typeof stat.size === "number" ? stat.size : null;
    } catch {
      return null;
    }
  }

  private async readCandidate(
    path: string,
    options?: { failOnReadError: boolean },
  ): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      if (!(await this.adapter.exists(path))) return null;
      text = await this.adapter.read(path);
    } catch (error) {
      // Startup may fall back to a checkpoint on an unreadable file. A write
      // must not mistake that uncertainty for corrupt bytes and delete it.
      if (options?.failOnReadError) throw error;
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Write `index.json`, creating the directory if needed.
   */
  public async write(value: object): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) {
      await this.adapter.mkdir(this.dir);
    }
    const serialized = JSON.stringify(value);
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
        if (await this.adapter.exists(this.filePath)) {
          if (await this.readCandidate(backupPath, { failOnReadError: true })
            && !(await this.readCandidate(this.filePath, { failOnReadError: true }))) {
            // Never rotate corrupt primary bytes over the only readable snapshot.
            await this.adapter.remove(this.filePath);
          } else {
            if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
            await this.adapter.rename(this.filePath, backupPath);
            movedPrevious = true;
          }
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

  /**
   * An older release could leave its whole index parked at `.previous`. Once
   * the current manifest is in place that copy is only dead weight.
   */
  public async removeRecoveryCopy(): Promise<void> {
    if (await this.adapter.exists(this.previousPath)) await this.adapter.remove(this.previousPath);
  }

  public shardPath(shard: number): string {
    return `${this.shardDir}/${String(shard).padStart(2, "0")}.bin`;
  }

  /** Shard numbers present on disk. */
  public async listShards(): Promise<Set<number>> {
    const shards = new Set<number>();
    try {
      if (!(await this.adapter.exists(this.shardDir))) return shards;
      const listed = await this.adapter.list(this.shardDir);
      for (const path of listed.files) {
        const match = SHARD_FILE.exec(path.slice(path.lastIndexOf("/") + 1));
        if (match) shards.add(Number(match[1]));
      }
    } catch {
      // An unreadable directory is treated as holding no shards.
    }
    return shards;
  }

  /** Size and modification time of one shard file, or null when it is missing. */
  public async shardStat(shard: number): Promise<{ size: number; mtime: number | null } | null> {
    try {
      const stat = await this.adapter.stat(this.shardPath(shard));
      if (!stat || typeof stat.size !== "number") return null;
      return { size: stat.size, mtime: typeof stat.mtime === "number" ? stat.mtime : null };
    } catch {
      return null;
    }
  }

  public async readShard(shard: number): Promise<ArrayBuffer | null> {
    const path = this.shardPath(shard);
    try {
      if (!(await this.adapter.exists(path))) return null;
      return await this.adapter.readBinary(path);
    } catch {
      return null;
    }
  }

  /**
   * Replace one shard. The bytes land in a temporary file first, so a reader
   * sees the previous shard or the next one, never a partial write.
   */
  public async writeShard(shard: number, bytes: ArrayBuffer): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    if (!(await this.adapter.exists(this.shardDir))) await this.adapter.mkdir(this.shardDir);
    const path = this.shardPath(shard);
    const tempPath = `${path}.next`;
    await this.adapter.writeBinary(tempPath, bytes);
    try {
      try {
        await this.adapter.rename(tempPath, path);
      } catch (renameError) {
        // Some adapters refuse to rename over an existing file.
        if (!(await this.adapter.exists(path))) throw renameError;
        await this.adapter.remove(path);
        await this.adapter.rename(tempPath, path);
      }
    } catch (error) {
      try {
        if (await this.adapter.exists(tempPath)) await this.adapter.remove(tempPath);
      } catch { /* temporary cleanup is best effort */ }
      throw error;
    }
  }

  public async removeShard(shard: number): Promise<void> {
    const path = this.shardPath(shard);
    for (const candidate of [`${path}.next`, path]) {
      if (await this.adapter.exists(candidate)) await this.adapter.remove(candidate);
    }
  }

  public async remove(): Promise<void> {
    // Recovery candidates must not resurrect a deliberately removed snapshot.
    for (const path of [this.previousPath, `${this.filePath}.next`, this.filePath]) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
    if (!(await this.adapter.exists(this.shardDir))) return;
    const listed = await this.adapter.list(this.shardDir);
    for (const path of listed.files) {
      if (path.endsWith(".bin") || path.endsWith(".bin.next")) await this.adapter.remove(path);
    }
  }
}
