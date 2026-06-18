import type SystemSculptPlugin from "../main";
import { resolveProviderLabel } from "./piAuth/StudioPiProviderRegistry";
import type {
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
} from "./types";
import type { SystemSculptModel } from "../types/llm";
import {
  getCuratedImageGenerationModelGroups,
  type ImageGenerationServerCatalogModel,
} from "../services/canvasflow/ImageGenerationModelCatalog";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatContextLength(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M context`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K context`;
  }
  return `${tokens} context`;
}

function describeModel(model: SystemSculptModel): string {
  const parts: string[] = ["SystemSculpt managed"];
  const context = formatContextLength(model.context_length);
  if (context) {
    parts.push(context);
  }
  return parts.join(" • ");
}

function buildKeywords(model: SystemSculptModel): string[] {
  return [
    normalizeText(model.name),
    normalizeText(model.id),
    normalizeText(model.piExecutionModelId),
    normalizeText(model.provider),
    normalizeText(model.identifier?.modelId),
  ].filter((entry) => entry.length > 0);
}

function toPiTextOption(
  model: SystemSculptModel,
  providerAuthenticated: boolean
): StudioNodeConfigSelectOption {
  return {
    value: model.id,
    label: normalizeText(model.name) || normalizeText(model.identifier?.modelId) || model.id,
    description: describeModel(model) || undefined,
    badge: resolveProviderLabel(model.provider || "systemsculpt"),
    keywords: buildKeywords(model),
    providerAuthenticated,
  };
}

function readCachedServerImageModels(
  plugin: SystemSculptPlugin
): ImageGenerationServerCatalogModel[] {
  const raw = plugin.settings.imageGenerationModelCatalogCache?.models;
  // The cached catalog is normalized again downstream, so a loose pass-through is safe.
  return Array.isArray(raw) ? (raw as ImageGenerationServerCatalogModel[]) : [];
}

function resolveStudioImageModelOptions(
  plugin: SystemSculptPlugin
): StudioNodeConfigSelectOption[] {
  const authenticated = normalizeText(plugin.settings.licenseKey).length > 0;
  const options: StudioNodeConfigSelectOption[] = [
    {
      value: "",
      label: "SystemSculpt Default",
      description: "Managed image model chosen by SystemSculpt (recommended).",
      badge: "Default",
      keywords: ["default", "managed", "systemsculpt", "auto", "nano banana"],
      providerAuthenticated: authenticated,
    },
  ];

  const groups = getCuratedImageGenerationModelGroups(readCachedServerImageModels(plugin));
  for (const group of groups) {
    for (const model of group.models) {
      const id = normalizeText(model.id);
      // The managed engine is already represented by the "SystemSculpt Default" entry.
      if (!id || id.toLowerCase().startsWith("systemsculpt/managed")) {
        continue;
      }
      const summary = normalizeText(model.pricing?.summary);
      options.push({
        value: id,
        label: normalizeText(model.label) || id,
        description: summary || undefined,
        badge: normalizeText(model.provider) || undefined,
        keywords: [id, normalizeText(model.label), normalizeText(model.provider)].filter(
          (entry) => entry.length > 0
        ),
        providerAuthenticated: authenticated,
      });
    }
  }

  return options;
}

export async function resolveStudioDynamicSelectOptions(options: {
  plugin: SystemSculptPlugin;
  source: StudioNodeConfigDynamicOptionsSource;
}): Promise<StudioNodeConfigSelectOption[]> {
  const { plugin, source } = options;

  if (source === "studio.systemsculpt_image_models") {
    return resolveStudioImageModelOptions(plugin);
  }

  if (
    source !== "studio.pi_text_models" &&
    source !== "studio.systemsculpt_text_models" &&
    source !== "studio.local_text_models"
  ) {
    return [];
  }

  const models = await plugin.modelService.getModels().catch(() => [] as SystemSculptModel[]);
  const hostedAccessConfigured = normalizeText(plugin.settings.licenseKey).length > 0;

  return models
    .map((model) => toPiTextOption(model, hostedAccessConfigured))
    .sort((left, right) => {
      const authCompare = Number(Boolean(right.providerAuthenticated)) - Number(Boolean(left.providerAuthenticated));
      if (authCompare !== 0) {
        return authCompare;
      }
      return left.label.localeCompare(right.label);
    });
}
