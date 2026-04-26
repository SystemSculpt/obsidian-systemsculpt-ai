import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { SYSTEMSCULPT_PI_CANONICAL_MODEL_ID } from "../pi/PiCanonicalIds";
import {
  MANAGED_SYSTEMSCULPT_MODEL_CONTRACT,
  type ManagedSystemSculptModelContract,
} from "./ManagedSystemSculptContract";

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
  plugin: Pick<SystemSculptPlugin, "settings">,
  contract: ManagedSystemSculptModelContract = MANAGED_SYSTEMSCULPT_MODEL_CONTRACT
): SystemSculptModel {
  const hasLicense = hasActiveSystemSculptLicense(plugin);

  return {
    id: contract.id,
    name: contract.name,
    description: hasLicense
      ? "The managed SystemSculpt model for chat across desktop and mobile."
      : "Add an active SystemSculpt license in Setup to use SystemSculpt.",
    provider: contract.providerId,
    sourceMode: "systemsculpt",
    sourceProviderId: contract.providerId,
    identifier: {
      providerId: contract.providerId,
      modelId: contract.providerModelId,
      displayName: contract.name,
    },
    piExecutionModelId: contract.executionModelId,
    piAuthMode: "hosted",
    piRemoteAvailable: true,
    piLocalAvailable: false,
    context_length: contract.contextLength,
    capabilities: [...contract.capabilities],
    supported_parameters: ["tools"],
    architecture: {
      modality: contract.modality,
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
      context_length: contract.contextLength,
      max_completion_tokens: contract.maxCompletionTokens,
      is_moderated: false,
    },
  };
}
