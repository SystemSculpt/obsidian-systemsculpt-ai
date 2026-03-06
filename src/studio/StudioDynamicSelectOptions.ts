import type SystemSculptPlugin from "../main";
import { resolveProviderLabel } from "./piAuth/StudioPiProviderRegistry";
import { hasAuthenticatedStudioPiProvider } from "./piAuth/StudioPiProviderAuthUtils";
import { loadPiTextProviderAuth, piTextProviderRequiresAuth } from "../services/pi-native/PiTextAuth";
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
  const parts: string[] = ["Local Pi runtime"];
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
  const providerHints = Array.from(
    new Set(
      models
        .map((model) => normalizeText(model.sourceProviderId || model.provider).toLowerCase())
        .filter((providerId) => providerId.length > 0)
    )
  );
  const providerAuthById = await loadPiTextProviderAuth(providerHints);

  return models
    .map((model) => {
      const providerId = normalizeText(model.sourceProviderId || model.provider).toLowerCase();
      const authRecord = providerAuthById.get(providerId);
      const localReady =
        !!model.piLocalAvailable &&
        (!piTextProviderRequiresAuth(providerId) || hasAuthenticatedStudioPiProvider(authRecord));
      const providerAuthenticated = localReady;
      return toPiTextOption(model, providerAuthenticated);
    })
    .sort((left, right) => {
      const authCompare = Number(Boolean(right.providerAuthenticated)) - Number(Boolean(left.providerAuthenticated));
      if (authCompare !== 0) {
        return authCompare;
      }
      return left.label.localeCompare(right.label);
    });
}
