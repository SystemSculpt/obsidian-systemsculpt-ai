import type { App } from "obsidian";
import type { ManagedRecoveryAdapter } from "../ManagedJobRecoveryStore";

type ObsidianDataAdapter = App["vault"]["adapter"];

function stableDomain(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 220);
  return `obsidian:${safe || "vault"}`;
}

export class ObsidianManagedRecoveryAdapter implements ManagedRecoveryAdapter {
  readonly capabilities = Object.freeze({ read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true });
  readonly storageDomain: string;
  private readonly adapter: ObsidianDataAdapter;

  constructor(app: App) {
    this.adapter = app.vault.adapter;
    this.storageDomain = stableDomain(app.vault.getName());
  }

  read(path: string): Promise<string> { return this.adapter.read(path); }
  write(path: string, contents: string): Promise<void> { return this.adapter.write(path, contents); }
  exists(path: string): Promise<boolean> { return this.adapter.exists(path); }
  rename(from: string, to: string): Promise<void> { return this.adapter.rename(from, to); }
  remove(path: string): Promise<void> { return this.adapter.remove(path); }

  async mkdir(path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
  }

  async list(path: string): Promise<string[]> {
    if (!(await this.adapter.exists(path))) return [];
    const found: string[] = [];
    const visit = async (folder: string): Promise<void> => {
      const listed = await this.adapter.list(folder);
      found.push(...listed.files);
      for (const child of listed.folders) await visit(child);
    };
    await visit(path);
    return found;
  }
}
