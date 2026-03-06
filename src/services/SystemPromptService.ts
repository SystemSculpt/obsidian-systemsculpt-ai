import { App, TFile } from "obsidian";
import { SystemPromptPreset } from "../types";
import { LOCAL_SYSTEM_PROMPTS, GENERAL_USE_PRESET, CONCISE_PRESET } from "../constants/prompts";

export type SystemPromptSelectionType = "general-use" | "concise" | "agent" | "custom";
export type DesktopPromptSelectionType = "general-use" | "concise" | "custom";

export function normalizeDesktopPromptSelectionType(type?: string): DesktopPromptSelectionType {
  switch ((type || "").toLowerCase()) {
    case "concise":
      return "concise";
    case "custom":
      return "custom";
    case "agent":
    case "general-use":
    default:
      return "general-use";
  }
}

/**
 * Simple service for managing system prompts.
 * Handles the three types of prompts:
 * 1. general-use: Our standard comprehensive prompt
 * 2. concise: Our shorter, more direct prompt
 * 3. custom: Loaded from a user-specified file path
 */
export class SystemPromptService {
  private static instance: SystemPromptService | null = null;
  private app: App;
  private pluginSettings: () => any;

  private constructor(app: App, pluginSettingsGetter: () => any) {
    this.app = app;
    this.pluginSettings = pluginSettingsGetter;
  }

  /**
   * Get the singleton instance of SystemPromptService
   */
  public static getInstance(app: App, pluginSettingsGetter: () => any): SystemPromptService {
    if (!this.instance) {
      this.instance = new SystemPromptService(app, pluginSettingsGetter);
    }
    this.instance.pluginSettings = pluginSettingsGetter;
    return this.instance;
  }

  /**
   * Get the content of a system prompt based on the selected preset.
   * Legacy "agent" selections are normalized to the desktop Pi default.
   */
  async getSystemPromptContent(
    type: SystemPromptSelectionType,
    path?: string
  ): Promise<string> {
    const normalizedType = normalizeDesktopPromptSelectionType(type);

    if (normalizedType === "general-use") {
      return GENERAL_USE_PRESET.systemPrompt;
    }
    if (normalizedType === "concise") {
      return CONCISE_PRESET.systemPrompt;
    }
    if (normalizedType === "custom" && path) {
      try {
        return await this.readCustomPromptFile(path);
      } catch (error) {
        return GENERAL_USE_PRESET.systemPrompt;
      }
    }

    return GENERAL_USE_PRESET.systemPrompt;
  }

  /**
   * Helper to read content from a custom prompt file
   */
  private async readCustomPromptFile(path: string): Promise<string> {
    // Try to get the file directly
    let file = this.app.vault.getAbstractFileByPath(path);

    // If not found, try with .md extension
    if (!file && !path.endsWith('.md')) {
      file = this.app.vault.getAbstractFileByPath(`${path}.md`);
    }

    // Look in the system prompts directory if configured (top-level match)
    if (!file) {
      const settings = this.pluginSettings();
      const promptsDir = settings?.systemPromptsDirectory || "SystemSculpt/System Prompts";
      const filename = path.split('/').pop(); // Just get the filename

      if (filename) {
        file = this.app.vault.getAbstractFileByPath(`${promptsDir}/${filename}`);

        // Try with .md extension in the prompts directory
        if (!file && !filename.endsWith('.md')) {
          file = this.app.vault.getAbstractFileByPath(`${promptsDir}/${filename}.md`);
        }
      }
    }

    // If still not found, search recursively within the system prompts directory by basename
    if (!file) {
      const settings = this.pluginSettings();
      const promptsDir = settings?.systemPromptsDirectory || "SystemSculpt/System Prompts";
      const filename = path.split('/').pop();
      if (filename) {
        const targetBase = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
        const candidates = this.app.vault
          .getMarkdownFiles()
          .filter(f => (f.path === promptsDir || f.path.startsWith(`${promptsDir}/`)) && f.basename === targetBase)
          .sort((a, b) => a.path.localeCompare(b.path));
        if (candidates.length > 0) {
          file = candidates[0];
        }
      }
    }

    if (file instanceof TFile) {
      return await this.app.vault.read(file);
    }

    throw new Error(`Custom prompt file not found: ${path}`);
  }

  /**
   * Get available system prompt presets
   */
  getLocalPresets(): SystemPromptPreset[] {
    return LOCAL_SYSTEM_PROMPTS.filter(
      (preset) => normalizeDesktopPromptSelectionType(preset.id) === preset.id
    );
  }

  /**
   * Get custom prompt files in the SystemSculpt/System Prompts directory
   * Now with timeout protection and better error handling
   */
  async getCustomPromptFiles(): Promise<{ path: string; name: string }[]> {
    const settings = this.pluginSettings();
    const promptsDir = settings?.systemPromptsDirectory || "SystemSculpt/System Prompts";

    try {
      // Verify directory exists
      const dirExists = await this.app.vault.adapter.exists(promptsDir);
      if (!dirExists) return [];

      // Collect all markdown files recursively under promptsDir
      const all = this.app.vault.getMarkdownFiles();
      const files = all
        .filter(f => f.path === promptsDir || f.path.startsWith(`${promptsDir}/`))
        .map(f => ({ path: f.path, name: f.basename }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return files;
    } catch (_) {
      return [];
    }
  }
}
