import type { DataAdapter } from "obsidian";
import type { StudioGenerationAdapter } from "./StudioProjectGenerationStore";
import { resolveStudioEntry } from '../StudioEntry';

/** Common vault DataAdapter wrapper. No Node APIs or rename-based authority. */
export class ObsidianStudioGenerationAdapter implements StudioGenerationAdapter {
  constructor(private readonly adapter: DataAdapter) {}
  get coordinationKey(): object { return this.adapter; }
  exists(path: string): Promise<boolean> { return this.adapter.exists(path); }
  async read(path: string): Promise<string> { return path.endsWith('.systemsculpt') ? (await resolveStudioEntry(this.adapter, path)).raw : this.adapter.read(path); }
  async readBinary(path: string): Promise<ArrayBuffer> { return path.endsWith('.systemsculpt') ? new TextEncoder().encode(await this.read(path)).buffer : this.adapter.readBinary(path); }
  write(path: string, data: string): Promise<void> { return this.adapter.write(path, data); }
  writeBinary(path: string, data: ArrayBuffer): Promise<void> { return this.adapter.writeBinary(path, data); }
  async compareAndSwapText(path: string, expectedData: string, nextData: string): Promise<boolean> {
    if (path.endsWith('.systemsculpt')) {
      const resolved = await resolveStudioEntry(this.adapter, path);
      if (resolved.entryRaw !== undefined && await this.adapter.read(path) !== resolved.entryRaw) return false;
      path = resolved.path;
    }
    let matched = false;
    await this.adapter.process(path, (currentData) => {
      if (currentData !== expectedData) return currentData;
      matched = true;
      return nextData;
    });
    return matched;
  }
  async copyFileIfAbsent(sourcePath: string, destinationPath: string): Promise<boolean> {
    try {
      // DataAdapter.copy is the only cross-platform adapter primitive whose
      // contract guarantees failure when the destination already exists.
      await this.adapter.copy(sourcePath, destinationPath);
      return true;
    } catch (error) {
      try {
        if (await this.adapter.exists(destinationPath)) return false;
      } catch {
        // Preserve the original copy failure when destination state is unreadable.
      }
      throw error;
    }
  }
  movePath(sourcePath: string, destinationPath: string): Promise<void> {
    return this.adapter.rename(sourcePath, destinationPath);
  }
  list(path: string): Promise<{ files: string[]; folders: string[] }> { return this.adapter.list(path); }
  mkdir(path: string): Promise<void> { return this.adapter.mkdir(path); }
  remove(path: string): Promise<void> { return this.adapter.remove(path); }
}
