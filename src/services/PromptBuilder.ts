import { App } from 'obsidian';
import { SystemPromptService } from './SystemPromptService';
import { GENERAL_USE_PRESET } from '../constants/prompts';

export interface BuildPromptOptions {
  type?: 'general-use' | 'concise' | 'agent' | 'custom';
  path?: string;
}

/**
 * PromptBuilder centralizes system prompt assembly:
 * - resolves the base prompt for the selected type/path
 * - keeps legacy "agent" selections readable by normalizing them to General Use
 */
export class PromptBuilder {
  static async buildSystemPrompt(
    app: App,
    getSettings: () => any,
    opts: BuildPromptOptions
  ): Promise<string> {
    const svc = SystemPromptService.getInstance(app, getSettings);

    // Resolve base prompt for selected type
    let base = '';
    try {
      base = await svc.getSystemPromptContent(
        (opts.type as any) || 'general-use',
        opts.path
      );
    } catch (_) {
      base = GENERAL_USE_PRESET.systemPrompt;
    }

    return base || GENERAL_USE_PRESET.systemPrompt;
  }
}
