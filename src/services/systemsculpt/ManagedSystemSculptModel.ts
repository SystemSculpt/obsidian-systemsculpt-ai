import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { ensureCanonicalId } from "../../utils/modelUtils";
import {
  SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
  SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
  SYSTEMSCULPT_PI_PROVIDER_ID,
  SYSTEMSCULPT_PI_PROVIDER_MODEL_ID,
} from "../pi/PiCanonicalIds";

function hasActiveSystemSculptLicense(plugin: Pick<SystemSculptPlugin, "settings">): boolean {
  const settings = plugin?.settings || {};
  return !!(String(settings.licenseKey || "").trim() && settings.licenseValid === true);
}

export function getManagedSystemSculptModelId(): string {
  return SYSTEMSCULPT_PI_CANONICAL_MODEL_ID;
}

export function isManagedSystemSculptModelId(modelId?: string | null): boolean {
  return ensureCanonicalId(String(modelId || "").trim()) === SYSTEMSCULPT_PI_CANONICAL_MODEL_ID;
}

export function hasManagedSystemSculptAccess(
  plugin: Pick<SystemSculptPlugin, "settings">
): boolean {
  return hasActiveSystemSculptLicense(plugin);
}

export function buildManagedSystemSculptModel(
  plugin: Pick<SystemSculptPlugin, "settings">
): SystemSculptModel {
  const hasLicense = hasActiveSystemSculptLicense(plugin);

  return {
    id: SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
    name: "SystemSculpt",
    description: hasLicense
      ? "The managed SystemSculpt model for chat across desktop and mobile."
      : "Add an active SystemSculpt license in Setup to use SystemSculpt.",
    provider: SYSTEMSCULPT_PI_PROVIDER_ID,
    sourceMode: "systemsculpt",
    sourceProviderId: SYSTEMSCULPT_PI_PROVIDER_ID,
    identifier: {
      providerId: SYSTEMSCULPT_PI_PROVIDER_ID,
      modelId: SYSTEMSCULPT_PI_PROVIDER_MODEL_ID,
      displayName: "SystemSculpt",
    },
    piExecutionModelId: SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
    piAuthMode: "hosted",
    piRemoteAvailable: true,
    piLocalAvailable: false,
    context_length: 256_000,
    capabilities: ["chat", "reasoning"],
    supported_parameters: ["tools"],
    architecture: {
      modality: "text+image->text",
      tokenizer: "systemsculpt-managed",
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
      image: "0",
      request: "0",
    },
    top_provider: {
      context_length: 256_000,
      max_completion_tokens: 32_768,
      is_moderated: false,
    },
  };
}
