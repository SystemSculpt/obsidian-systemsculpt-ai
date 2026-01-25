import { SystemPromptPreset } from "../../types";

/**
 * General use system prompt - comprehensive and balanced
 */
export const GENERAL_USE_PRESET: SystemPromptPreset = {
  id: "general-use",
  label: "General Use Preset",
  description: "Standard balanced prompt.",
  isUserConfigurable: false,
  systemPrompt:
    "You are a helpful AI assistant. You help users with their questions and tasks in a clear and concise way.",
}; 