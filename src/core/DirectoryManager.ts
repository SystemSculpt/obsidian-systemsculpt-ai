import { App, normalizePath, TFolder } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { SystemSculptSettings } from "../types";

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
    const issues = this.configuredDirectories()
      .filter((path) => !(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))
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

    try {
      await this.app.vault.createFolder(path);
    } catch (error) {
      // A concurrent caller may have won the create race. Only accept the
      // rejection when Obsidian now resolves the requested path as a folder.
      if (this.app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
      throw error;
    }
  }

  private normalizedDirectory(value: string): string {
    const path = normalizePath(value.trim())
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/+/g, "/");
    if (!path) throw new Error("Cannot create directory: empty path provided");
    return path;
  }
}
