import {
  SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
  SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
  SYSTEMSCULPT_PI_PROVIDER_ID,
  SYSTEMSCULPT_PI_PROVIDER_MODEL_ID,
} from "../pi/PiCanonicalIds";

export type ManagedSystemSculptModelContract = {
  id: string;
  providerId: string;
  providerModelId: string;
  executionModelId: string;
  name: string;
  contextLength: number;
  maxCompletionTokens: number;
  capabilities: readonly string[];
  modality: string;
};

export const MANAGED_SYSTEMSCULPT_MODEL_CONTRACT: ManagedSystemSculptModelContract = {
  id: SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
  providerId: SYSTEMSCULPT_PI_PROVIDER_ID,
  providerModelId: SYSTEMSCULPT_PI_PROVIDER_MODEL_ID,
  executionModelId: SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
  name: "SystemSculpt",
  contextLength: 262_144,
  maxCompletionTokens: 32_768,
  capabilities: ["chat", "reasoning", "vision", "tools"],
  modality: "text+image->text",
} as const;
