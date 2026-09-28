import { App, normalizePath, TFolder } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { SystemSculptSettings } from "../types";
import { createVaultFolder, isVaultFolder } from "../utils/vaultFolders";

const DIRECTORY_SETTING_KEYS = [
  "chatsDirectory",
  "savedChatsDirectory",
  "recordingsDirectory",
  "attachmentsDirectory",
  "extractionsDirectory",
] as const satisfies readonly (keyof SystemSculptSettings)[];

type DirectorySettingKey = (typeof DIRECTORY_SETTING_KEYS)[number];

/** Direct, vault-native ownership of SystemSculpt output directories. */
export class DirectoryManager {
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
  ) {}

  public isInitialized(): boolean {
    return this.initialized;
  }

  public initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializationPromise) return this.initializationPromise;

    const operation = Promise.all(
      this.configuredDirectories().map((path) => this.createDirectory(path)),
    ).then(() => {
      this.initialized = true;
    });

    this.initializationPromise = operation.finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  public async ensureDirectoryByKey(key: DirectorySettingKey): Promise<string> {
    const path = this.directorySetting(key);
    await this.createDirectory(path);
    return path;
  }

  public async ensureDirectoryByPath(dirPath: string): Promise<void> {
    await this.createDirectory(dirPath);
  }

  public async handleDirectorySettingChange(
    _key: DirectorySettingKey,
    newPath: string,
  ): Promise<void> {
    if (!newPath.trim()) return;
    await this.createDirectory(newPath);
  }

  public async verifyDirectories(): Promise<{ valid: boolean; issues: string[] }> {
    // Same test initialization and repair accept, so a folder on disk that the
    // vault tree has not indexed yet is healthy rather than a false failure.
    const directories = this.configuredDirectories();
    const present = await Promise.all(directories.map((path) => isVaultFolder(this.app, path)));
    const issues = directories
      .filter((_path, index) => !present[index])
      .map((path) => `Directory "${path}" does not exist or is not accessible`);
    return { valid: issues.length === 0, issues };
  }

  public async repair(): Promise<boolean> {
    this.initialized = false;
    try {
      await this.initialize();
      return true;
    } catch {
      return false;
    }
  }

  private configuredDirectories(): string[] {
    return [...new Set(
      DIRECTORY_SETTING_KEYS
        .map((key) => this.plugin.settings[key])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((path) => this.normalizedDirectory(path)),
    )];
  }

  private directorySetting(key: DirectorySettingKey): string {
    const value = this.plugin.settings[key];
    if (typeof value !== "string" || !value.trim()) {
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
    const path = normalizePath(value.trim())
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/+/g, "/");
    if (!path) throw new Error("Cannot create directory: empty path provided");
    return path;
  }
}
