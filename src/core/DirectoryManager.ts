import { App, TFolder } from "obsidian";
import { normalizeVaultRelativePath } from "../utils/vaultPathUtils";
import type SystemSculptPlugin from "../main";
import type { SystemSculptSettings } from "../types";
import { createVaultFolder } from "../utils/vaultFolders";
import { DEFAULT_DIRS } from "./settings/defaultDirectories";

// Only folders the plugin writes to. The retired saved-chats and attachments
// settings are never created, and an existing folder of theirs is left alone.
const DIRECTORY_SETTING_KEYS = [
  "chatsDirectory",
  "recordingsDirectory",
  "extractionsDirectory",
] as const satisfies readonly (keyof SystemSculptSettings)[];

type DirectorySettingKey = (typeof DIRECTORY_SETTING_KEYS)[number];

/** Direct, vault-native ownership of SystemSculpt output directories. */
export class DirectoryManager {
  private initialized = false;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
  ) {}

  public isInitialized(): boolean {
    return this.initialized;
  }

  /** Compatibility lifecycle hook; only explicit ensure calls create folders. */
  public initialize(): Promise<void> {
    this.initialized = true;
    return Promise.resolve();
  }

  public async ensureDirectoryByKey(key: DirectorySettingKey): Promise<string> {
    const path = this.directorySetting(key);
    await this.createDirectory(path);
    return path;
  }

  public async ensureDirectoryByPath(dirPath: string): Promise<void> {
    await this.createDirectory(dirPath);
  }

  public async verifyDirectories(): Promise<{ valid: boolean; issues: string[] }> {
    const results = await Promise.all(
      this.configuredDirectories().map((path) => this.directoryIssue(path)),
    );
    const issues = results.filter((issue): issue is string => issue !== null);
    return { valid: issues.length === 0, issues };
  }

  public async repair(): Promise<boolean> {
    this.initialized = false;
    try {
      // Missing outputs need no repair. Never overwrite a conflicting file or
      // create unused folders; the next writer ensures its own destination.
      const { valid } = await this.verifyDirectories();
      this.initialized = valid;
      return valid;
    } catch {
      return false;
    }
  }

  private async directoryIssue(path: string): Promise<string | null> {
    const parts = path.split("/");
    while (parts.length > 0) {
      const current = parts.join("/");
      try {
        const existing = this.app.vault.getAbstractFileByPath(current);
        if (existing instanceof TFolder) return null;
        if (existing) return `Directory "${path}" is blocked by a file at "${current}"`;

        if (await this.app.vault.adapter.exists(current)) {
          const stat = await this.app.vault.adapter.stat(current);
          if (stat?.type === "folder") return null;
          if (stat?.type === "file") {
            return `Directory "${path}" is blocked by a file at "${current}"`;
          }
          return `Directory "${path}" is not accessible at "${current}"`;
        }
      } catch {
        return `Directory "${path}" is not accessible at "${current}"`;
      }
      // A missing leaf is valid unless an existing ancestor prevents creation.
      parts.pop();
    }
    return null;
  }

  private configuredDirectories(): string[] {
    return [...new Set(
      DIRECTORY_SETTING_KEYS
        .filter((key) => key !== "extractionsDirectory" || this.plugin.settings[key]?.trim())
        .map((key) => this.directorySetting(key)),
    )];
  }

  private directorySetting(key: DirectorySettingKey): string {
    const value = this.plugin.settings[key]?.trim()
      || (key === "extractionsDirectory" ? "" : DEFAULT_DIRS[key]);
    if (!value) {
      throw new Error(`No path configured for: ${key}`);
    }
    return this.normalizedDirectory(value);
  }

  private async createDirectory(dirPath: string): Promise<void> {
    const path = this.normalizedDirectory(dirPath);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error(`Cannot create directory "${path}": a file already exists at that path.`);

    // The vault tree can miss a folder that exists on disk (onload before
    // indexing settles, a concurrent create). Obsidian then rejects with
    // "Folder already exists."; the helper accepts only a real folder.
    await createVaultFolder(this.app, path);
  }

  private normalizedDirectory(value: string): string {
    const path = normalizeVaultRelativePath(value);
    if (!path) throw new Error("Cannot create directory: empty path provided");
    return path;
  }
}
