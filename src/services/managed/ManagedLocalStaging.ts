import type { DataAdapter } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { sha256HexFromArrayBuffer } from "../../utils/sha256";
import { normalizeVaultRelativePath } from "../../utils/vaultPathUtils";
import { throwIfManagedAborted } from "./ManagedAbort";

const MANIFEST_PATTERN = /\/manifest-(\d{6})\.json$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface StagingManifest {
  sequence: number;
  phase: "staging" | "ready";
}

interface StagingEntry<Metadata> {
  name: string;
  bytes: ArrayBuffer;
  metadata: Metadata;
}

interface StagingFormat<Manifest> {
  directory: ".audio-processor-staging" | ".managed-document-staging";
  isManifest(value: unknown, stagingId: string): value is Manifest;
  error(code: "invalid_staging_request" | "staging_corrupt", message?: string): Error;
  digest?: (bytes: ArrayBuffer) => Promise<string>;
}

/**
 * Owns adapter-only staging publication and recovery. Binary files become usable
 * only through a ready immutable manifest, and every consumption verifies them.
 * Publication is logical crash recovery, not a physical filesystem flush.
 */
export class ManagedLocalStaging<Manifest extends StagingManifest> {
  private readonly adapter: DataAdapter;
  private readonly root: string;
  private readonly digest: (bytes: ArrayBuffer) => Promise<string>;

  constructor(plugin: SystemSculptPlugin, private readonly format: StagingFormat<Manifest>) {
    const configDirectory = this.requireDirectory(plugin?.app?.vault?.configDir);
    if (plugin?.manifest?.id !== "systemsculpt-ai") throw format.error("invalid_staging_request");
    const pluginDirectory = `${configDirectory}/plugins/systemsculpt-ai`;
    if (plugin.manifest.dir !== undefined && this.requireDirectory(plugin.manifest.dir) !== pluginDirectory) {
      throw format.error("invalid_staging_request", "Plugin manifest directory does not match the installed plugin location.");
    }
    this.adapter = plugin.app.vault.adapter;
    this.root = `${pluginDirectory}/${format.directory}`;
    this.digest = format.digest ?? sha256HexFromArrayBuffer;
  }

  async stage<Metadata>(
    stagingId: string,
    entries: AsyncIterable<StagingEntry<Metadata>>,
    manifest: (sequence: number, phase: "staging" | "ready", metadata: Metadata[]) => Manifest,
    options: { replace?: boolean; signal?: AbortSignal; onProgress?: (completed: number) => void } = {},
  ): Promise<Manifest> {
    const { signal } = options;
    throwIfManagedAborted(signal);
    const directory = this.directory(stagingId);
    if (options.replace) await this.cleanup(stagingId, signal);
    await this.ensureDirectory(this.root, signal);
    await this.ensureDirectory(directory, signal);
    const paths = await this.manifestPaths(stagingId, signal);
    const sequence = paths.reduce((maximum, path) => {
      const match = path.match(MANIFEST_PATTERN)!;
      return Math.max(maximum, Number(match[1]));
    }, 0) + 1;
    await this.writeManifest(directory, manifest(sequence, "staging", []), signal);

    const metadata: Metadata[] = [];
    for await (const entry of entries) {
      throwIfManagedAborted(signal);
      const path = this.entryPath(stagingId, entry.name);
      await this.adapter.writeBinary(`${path}.tmp`, entry.bytes);
      throwIfManagedAborted(signal);
      await this.adapter.rename(`${path}.tmp`, path);
      throwIfManagedAborted(signal);
      metadata.push(entry.metadata);
      options.onProgress?.(metadata.length);
    }
    throwIfManagedAborted(signal);
    const ready = manifest(sequence + 1, "ready", metadata);
    const text = JSON.stringify(ready);
    const path = await this.writeManifest(directory, ready, signal);
    const persisted = await this.adapter.read(path);
    throwIfManagedAborted(signal);
    if (persisted !== text) throw this.format.error("staging_corrupt", "Staging manifest failed verification.");
    return ready;
  }

  async findManifest(
    stagingId: string,
    accept: (manifest: Manifest) => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<Manifest | null> {
    try {
      for (const path of await this.manifestPaths(stagingId, signal)) {
        const raw = await this.adapter.read(path);
        throwIfManagedAborted(signal);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          // A partial immutable generation must not hide older valid work.
          continue;
        }
        if (this.format.isManifest(value, stagingId) && accept(value)) return value;
      }
      return null;
    } catch (error) {
      throwIfManagedAborted(signal);
      throw error;
    }
  }

  async readVerified(
    stagingId: string,
    name: string,
    expected: { byteLength: number; sha256: string },
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    throwIfManagedAborted(signal);
    if (!HASH_PATTERN.test(expected.sha256)) throw this.format.error("staging_corrupt", "Staging metadata is invalid.");
    const bytes = await this.adapter.readBinary(this.entryPath(stagingId, name));
    throwIfManagedAborted(signal);
    const digest = await this.digest(bytes);
    throwIfManagedAborted(signal);
    if (bytes.byteLength !== expected.byteLength || digest !== expected.sha256) {
      throw this.format.error("staging_corrupt", "Staged file failed verification.");
    }
    return bytes;
  }

  async cleanup(stagingId: string, signal?: AbortSignal): Promise<void> {
    throwIfManagedAborted(signal);
    const directory = this.directory(stagingId);
    const exists = await this.adapter.exists(directory);
    throwIfManagedAborted(signal);
    if (!exists) return;
    await this.adapter.rmdir(directory, true);
    throwIfManagedAborted(signal);
  }

  async cleanupStale(
    activeStagingIds: ReadonlySet<string>,
    expired: (manifest: Manifest | null, modifiedAt: number | undefined) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfManagedAborted(signal);
    const exists = await this.adapter.exists(this.root);
    throwIfManagedAborted(signal);
    if (!exists) return;
    const listing = await this.adapter.list(this.root);
    throwIfManagedAborted(signal);
    for (const folder of listing.folders) {
      const stagingId = folder.slice(folder.lastIndexOf("/") + 1);
      if (!HASH_PATTERN.test(stagingId) || folder !== this.directory(stagingId) || activeStagingIds.has(stagingId)) continue;
      let manifest: Manifest | null;
      try {
        manifest = await this.findManifest(stagingId, undefined, signal);
      } catch {
        throwIfManagedAborted(signal);
        manifest = null;
      }
      const stat = manifest ? null : await this.adapter.stat(folder);
      throwIfManagedAborted(signal);
      if (expired(manifest, stat?.mtime)) await this.cleanup(stagingId, signal);
    }
  }

  private async manifestPaths(stagingId: string, signal?: AbortSignal): Promise<string[]> {
    throwIfManagedAborted(signal);
    const directory = this.directory(stagingId);
    const exists = await this.adapter.exists(directory);
    throwIfManagedAborted(signal);
    if (!exists) return [];
    const listing = await this.adapter.list(directory);
    throwIfManagedAborted(signal);
    return listing.files.filter(path => path.startsWith(`${directory}/`) && MANIFEST_PATTERN.test(path)).sort().reverse();
  }

  private async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    const exists = await this.adapter.exists(path);
    throwIfManagedAborted(signal);
    if (exists) return;
    try {
      await this.adapter.mkdir(path);
    } catch (error) {
      throwIfManagedAborted(signal);
      const created = await this.adapter.exists(path);
      throwIfManagedAborted(signal);
      if (!created) throw error;
    }
    throwIfManagedAborted(signal);
  }

  private async writeManifest(directory: string, manifest: Manifest, signal?: AbortSignal): Promise<string> {
    const path = `${directory}/manifest-${String(manifest.sequence).padStart(6, "0")}.json`;
    await this.adapter.write(`${path}.tmp`, JSON.stringify(manifest));
    throwIfManagedAborted(signal);
    await this.adapter.rename(`${path}.tmp`, path);
    throwIfManagedAborted(signal);
    return path;
  }

  private entryPath(stagingId: string, name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw this.format.error("invalid_staging_request");
    return `${this.directory(stagingId)}/${name}`;
  }

  private directory(stagingId: string): string {
    if (!HASH_PATTERN.test(stagingId)) throw this.format.error("invalid_staging_request");
    return `${this.root}/${stagingId}`;
  }

  private requireDirectory(value: unknown): string {
    if (typeof value !== "string") throw this.format.error("invalid_staging_request");
    try {
      return normalizeVaultRelativePath(value, {
        trim: false,
        preserveCharacters: true,
        validateRelative: { allowLeadingDot: true },
      });
    } catch {
      throw this.format.error("invalid_staging_request");
    }
  }
}
