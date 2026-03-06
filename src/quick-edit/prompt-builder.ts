import type { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { ChatMessage } from "../types";

export interface QuickEditSelection {
  text: string;
  range?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export interface QuickEditPromptOptions {
  app: App;
  plugin: SystemSculptPlugin;
  file: TFile;
  prompt: string;
  selection?: QuickEditSelection;
}

export interface QuickEditMessages {
  user: ChatMessage;
  systemPrompt: string;
}

export async function buildQuickEditMessages(_options: QuickEditPromptOptions): Promise<QuickEditMessages> {
  throw new Error("Quick Edit message building is unavailable until the Pi-native replacement ships.");
}
