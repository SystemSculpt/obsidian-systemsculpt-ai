import { App, TFile } from "obsidian";
import { SystemPromptPreset } from "../types";
import { LOCAL_SYSTEM_PROMPTS, GENERAL_USE_PRESET, CONCISE_PRESET, AGENT_PRESET } from "../constants/prompts";

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
   * Get the content of a system prompt based on type and agent mode
   */
  async getSystemPromptContent(
    type: "general-use" | "concise" | "agent" | "custom", 
    path?: string,
    agentMode?: boolean
  ): Promise<string> {
    const settings = this.pluginSettings();
    // Use the passed agentMode parameter if provided, otherwise fall back to global settings
    const effectiveAgentMode = agentMode !== undefined ? agentMode : (settings?.agentMode || false);

    // Handle each prompt type based on the selected type and agent mode status
    if (type === "general-use") {
      return GENERAL_USE_PRESET.systemPrompt;
    } 
    else if (type === "concise") {
      return CONCISE_PRESET.systemPrompt;
    }
    else if (type === "agent") {
      if (effectiveAgentMode) {
        // Agent mode is ON and agent prompt selected = use base agent prompt
        return AGENT_PRESET.systemPrompt;
      } else {
        // Agent prompt selected but agent mode is OFF - show warning and fall back
        return GENERAL_USE_PRESET.systemPrompt;
      }
    } 
    else if (type === "custom" && path) {
      try {
        return await this.readCustomPromptFile(path);
      } catch (error) {
        return GENERAL_USE_PRESET.systemPrompt; // Fall back to general prompt
      }
    }
    
    // Default fallback
    return GENERAL_USE_PRESET.systemPrompt;
  }

  /**
   * Compose the final system prompt by prefixing the agent prompt when
   * agent mode is enabled and the selected type is not already the agent
   * preset. If basePrompt is empty, the agent prompt alone is returned.
   */
  async combineWithAgentPrefix(
    basePrompt: string | undefined,
    selectedType?: string,
    agentMode?: boolean
  ): Promise<string> {
    const normalized = (selectedType || '').toLowerCase();
    const effectiveBase = basePrompt && basePrompt.length > 0
      ? basePrompt
      : GENERAL_USE_PRESET.systemPrompt;

    if (!agentMode) return effectiveBase;
    if (normalized === 'agent') return effectiveBase;

    try {
      const agentPrompt = await this.getSystemPromptContent('agent', undefined, true);
      if (agentPrompt && agentPrompt.length > 0) {
        return effectiveBase ? `${agentPrompt}\n\n${effectiveBase}` : agentPrompt;
      }
    } catch (_) {}
    return effectiveBase;
  }

  /**
   * Append a concise tools hint to the end of the assembled system prompt
   * when tools are available for this turn.
   */
  appendToolsHint(prompt: string, hasTools: boolean): string {
    if (!hasTools) return prompt;
    const hint = [
      "You have access to filesystem tools to interact with the user's vault.",
      "Use the tool names exactly as listed (for example, mcp-filesystem_read).",
      "Tool arguments must be valid JSON that matches the tool schema exactly (no extra keys).",
      "Never fabricate file contents or tool results—when you need an exact string from the vault, use a tool and copy it verbatim.",
      "Prefer batching reads into a single call when possible (e.g., mcp-filesystem_read with multiple paths). If multiple independent tool calls are needed, you may call them in parallel.",
    ].join(" ");
    return prompt && prompt.length > 0 ? `${prompt}\n\n${hint}` : hint;
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
    return LOCAL_SYSTEM_PROMPTS;
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
