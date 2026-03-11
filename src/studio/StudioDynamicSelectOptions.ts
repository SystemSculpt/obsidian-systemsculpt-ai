import type SystemSculptPlugin from "../main";
import { resolveProviderLabel } from "./piAuth/StudioPiProviderRegistry";
import type {
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
} from "./types";
import type { SystemSculptModel } from "../types/llm";

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

export async function resolveStudioDynamicSelectOptions(options: {
  plugin: SystemSculptPlugin;
  source: StudioNodeConfigDynamicOptionsSource;
}): Promise<StudioNodeConfigSelectOption[]> {
  const { plugin, source } = options;
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
