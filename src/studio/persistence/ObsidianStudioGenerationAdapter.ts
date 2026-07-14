import type { DataAdapter } from "obsidian";
import type { StudioGenerationAdapter } from "./StudioProjectGenerationStore";

/** Common vault DataAdapter wrapper. No Node APIs or rename-based authority. */
export class ObsidianStudioGenerationAdapter implements StudioGenerationAdapter {
  constructor(private readonly adapter: DataAdapter) {}
  read(path: string): Promise<string> { return this.adapter.read(path); }
  readBinary(path: string): Promise<ArrayBuffer> { return this.adapter.readBinary(path); }
  write(path: string, data: string): Promise<void> { return this.adapter.write(path, data); }
  writeBinary(path: string, data: ArrayBuffer): Promise<void> { return this.adapter.writeBinary(path, data); }
  list(path: string): Promise<{ files: string[]; folders: string[] }> { return this.adapter.list(path); }
  mkdir(path: string): Promise<void> { return this.adapter.mkdir(path); }
  remove(path: string): Promise<void> { return this.adapter.remove(path); }
}
