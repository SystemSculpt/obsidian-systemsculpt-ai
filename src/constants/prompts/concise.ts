import { SystemPromptPreset } from "../../types";

/**
 * Concise system prompt - focused on brevity
 */
export const CONCISE_PRESET: SystemPromptPreset = {
  id: "concise",
  label: "Concise Preset",
  description: "Shorter, more direct prompt.",
  isUserConfigurable: false,
  systemPrompt: "You are a concise AI assistant. Be brief and to the point.",
}; 