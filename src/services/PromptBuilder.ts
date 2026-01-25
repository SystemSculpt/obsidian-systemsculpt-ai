import { App } from 'obsidian';
import { SystemPromptService } from './SystemPromptService';
import { GENERAL_USE_PRESET } from '../constants/prompts';

export interface BuildPromptOptions {
  type?: 'general-use' | 'concise' | 'agent' | 'custom';
  path?: string;
  agentMode?: boolean;
  hasTools?: boolean;
}

/**
 * PromptBuilder centralizes system prompt assembly:
 * - resolves the base prompt for the selected type/path
 * - conditionally prefixes the Agent prompt when agentMode is on
 * - appends a brief tools hint when tools are available
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
        opts.path,
        opts.agentMode
      );
    } catch (_) {
      base = GENERAL_USE_PRESET.systemPrompt;
    }

    // Prefix Agent prompt when needed
    let composed = await svc.combineWithAgentPrefix(base, opts.type, opts.agentMode);

    // Append tools hint when tools are available
    composed = svc.appendToolsHint(composed || GENERAL_USE_PRESET.systemPrompt, !!opts.hasTools);

    return composed;
  }
}

