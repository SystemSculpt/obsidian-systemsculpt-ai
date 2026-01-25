export { GENERAL_USE_PRESET } from "./general";
export { CONCISE_PRESET } from "./concise";
export { AGENT_PRESET } from "./agent";

import { GENERAL_USE_PRESET } from "./general";
import { CONCISE_PRESET } from "./concise";
import { AGENT_PRESET } from "./agent";
import { SystemPromptPreset } from "../../types";

/**
 * Array of all local system prompt presets
 */
export const LOCAL_SYSTEM_PROMPTS: SystemPromptPreset[] = [
  GENERAL_USE_PRESET,
  CONCISE_PRESET,
  AGENT_PRESET,
]; 