import { Platform } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { createCanonicalId } from "../../utils/modelUtils";
import { listLocalPiTextModels, type LocalPiListedModel } from "../pi/PiTextModels";

function toLocalOnlySystemSculptModel(model: LocalPiListedModel): SystemSculptModel {
  const actualModelId = `${model.providerId}/${model.modelId}`;
  const capabilities = model.supportsReasoning ? ["chat", "reasoning", "tools"] : ["chat", "tools"];

  return {
    id: createCanonicalId(model.providerId, model.modelId),
    name: model.label,
    description: model.description || "Local Pi model",
    provider: model.providerId,
    sourceMode: "pi_local",
    sourceProviderId: model.providerId,
    identifier: {
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.label,
    },
    piExecutionModelId: actualModelId,
    piAuthMode: "local",
    piRemoteAvailable: false,
    piLocalAvailable: true,
    context_length: model.contextLength,
    capabilities,
    supported_parameters: ["tools"],
    architecture: {
      modality: model.supportsImages ? "text+image->text" : "text->text",
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
      context_length: model.contextLength,
      max_completion_tokens: model.maxOutputTokens > 0 ? model.maxOutputTokens : null,
      is_moderated: false,
    },
  };
}

async function fetchLocalPiModels(plugin: SystemSculptPlugin): Promise<LocalPiListedModel[]> {
  if (!Platform.isDesktopApp) {
    return [];
  }

  try {
    return await listLocalPiTextModels(plugin);
  } catch {
    return [];
  }
}

export async function listPiTextCatalogModels(
  plugin: SystemSculptPlugin
): Promise<SystemSculptModel[]> {
  const localModels = await fetchLocalPiModels(plugin);
  const models = localModels.map((model) => toLocalOnlySystemSculptModel(model));

  return models.sort((left, right) => {
    const providerCompare = String(left.provider || "").localeCompare(String(right.provider || ""));
    if (providerCompare !== 0) {
      return providerCompare;
    }

    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}
