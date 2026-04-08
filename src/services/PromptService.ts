import { App, TFile, TFolder, parseYaml } from "obsidian";

export interface PromptEntry {
  name: string;
  path: string;
  description?: string;
  icon?: string;
}

export class PromptService {
  private app: App;
  private folderPath: string;

  constructor(app: App, folderPath: string) {
    this.app = app;
    this.folderPath = folderPath;
  }

  async listPrompts(): Promise<PromptEntry[]> {
    const folder = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!folder || !("children" in folder)) return [];

    const entries: PromptEntry[] = [];
    for (const child of (folder as TFolder).children) {
      if (!("extension" in child) || (child as TFile).extension !== "md") continue;
      const file = child as TFile;
      const meta = await this.readFrontmatter(file);
      entries.push({
        name: file.basename,
        path: file.path,
        description: meta?.description,
        icon: meta?.icon,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readPromptContent(filePath: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !("extension" in file)) return null;

    const raw = await this.app.vault.read(file as TFile);
    return this.stripFrontmatter(raw);
  }

  async ensureFolder(): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!existing) {
      await this.app.vault.createFolder(this.folderPath);
    }
  }

  async createPrompt(name: string): Promise<string> {
    await this.ensureFolder();
    const filePath = `${this.folderPath}/${name}.md`;
    await this.app.vault.create(filePath, `---\ndescription: ""\n---\n\n`);
    return filePath;
  }

  private async readFrontmatter(file: TFile): Promise<Record<string, string> | null> {
    const raw = await this.app.vault.read(file);
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    try {
      return parseYaml(match[1]) || null;
    } catch {
      return null;
    }
  }

  private stripFrontmatter(raw: string): string {
    return raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  }
}
