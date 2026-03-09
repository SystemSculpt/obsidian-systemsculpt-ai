import { Platform } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { compareSystemSculptModelPriority } from "../../utils/modelUtils";
import {
  listLocalPiTextModels,
  toLocalPiSystemSculptModel,
} from "../pi/PiTextModels";
import {
  SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
  SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
} from "../pi/PiSystemSculptProvider";

function hasActiveSystemSculptLicense(plugin: SystemSculptPlugin): boolean {
  return !!(plugin.settings.licenseKey?.trim() && plugin.settings.licenseValid === true);
}

function buildUnavailableSystemSculptModel(plugin: SystemSculptPlugin): SystemSculptModel {
  const hasDesktopPi = Platform.isDesktopApp;
  const missingLicense = hasDesktopPi && !hasActiveSystemSculptLicense(plugin);
  return {
    id: SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
    name: "SystemSculpt",
    description: !hasDesktopPi
      ? "Requires the Desktop app so requests can run through Pi."
      : missingLicense
        ? "Add an active SystemSculpt license in Setup to use this model."
      : "Requires the Desktop app so Pi can route requests locally.",
    provider: "systemsculpt",
    sourceMode: "pi_local",
    sourceProviderId: "systemsculpt",
    identifier: {
      providerId: "systemsculpt",
      modelId: SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
      displayName: "SystemSculpt",
    },
    piExecutionModelId: SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
    piAuthMode: "local",
    piRemoteAvailable: false,
    piLocalAvailable: false,
    context_length: 256_000,
    capabilities: ["chat", "reasoning"],
    supported_parameters: ["tools"],
    architecture: {
      modality: "text+image->text",
      tokenizer: "pi-local",
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

export async function listPiTextCatalogModels(
  plugin: SystemSculptPlugin
): Promise<SystemSculptModel[]> {
  const merged = new Map<string, SystemSculptModel>();
  const systemSculptReady = hasActiveSystemSculptLicense(plugin);

  for (const model of await listLocalPiTextModels(plugin)) {
    const normalized = toLocalPiSystemSculptModel(model);
    if (normalized.id === SYSTEMSCULPT_PI_CANONICAL_MODEL_ID && !systemSculptReady) {
      merged.set(normalized.id, buildUnavailableSystemSculptModel(plugin));
      continue;
    }
    merged.set(normalized.id, normalized);
  }

  if (!merged.has(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID)) {
    merged.set(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID, buildUnavailableSystemSculptModel(plugin));
  }

  return Array.from(merged.values()).sort((left, right) => {
    const pinnedCompare = compareSystemSculptModelPriority(left, right);
    if (pinnedCompare !== 0) {
      return pinnedCompare;
    }

    const providerCompare = String(left.provider || "").localeCompare(String(right.provider || ""));
    if (providerCompare !== 0) {
      return providerCompare;
    }

    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}
