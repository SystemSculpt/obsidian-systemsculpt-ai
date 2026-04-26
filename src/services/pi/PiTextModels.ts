import { readFile } from "fs/promises";
import type SystemSculptPlugin from "../../main";
import type { CustomProvider, SystemSculptModel } from "../../types/llm";
import { PlatformContext } from "../PlatformContext";
import {
  getDefaultStudioPiProviderHints,
  resolvePiProviderFromEndpoint,
  resolveProviderLabel,
} from "../../studio/piAuth/StudioPiProviderRegistry";
import { resolvePiModelsPath } from "./PiSdkStoragePaths";
import { normalizeStudioPiProviderId } from "../../studio/piAuth/StudioPiProviderAuthUtils";
import {
  buildLocalPiCanonicalModelId,
  buildLocalPiCanonicalProviderId,
  buildLocalPiExecutionModelId,
  getLocalPiProviderIdFromCanonical,
  isLocalPiCanonicalModelId,
  isLocalPiCanonicalProviderId,
  isSystemSculptPiProviderModel,
  normalizeLocalPiExecutionModelId,
  resolveLocalPiExecutionModelIdFromCanonical,
  SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
  SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
} from "./PiCanonicalIds";

export {
  buildLocalPiCanonicalModelId,
  buildLocalPiCanonicalProviderId,
  buildLocalPiExecutionModelId,
  getLocalPiProviderIdFromCanonical,
  isLocalPiCanonicalModelId,
  isLocalPiCanonicalProviderId,
  isSystemSculptPiExecutionModel,
  isSystemSculptPiProviderModel,
  normalizeLocalPiExecutionModelId,
  resolveLocalPiExecutionModelIdFromCanonical,
  SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
  SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
  SYSTEMSCULPT_PI_PROVIDER_ID,
  SYSTEMSCULPT_PI_PROVIDER_MODEL_ID,
} from "./PiCanonicalIds";

export type LocalPiTextModelOption = {
  value: string;
  label: string;
  description: string;
  badge: string;
  keywords: string[];
};

export type LocalPiListedModel = {
  providerId: string;
  modelId: string;
  label: string;
  description: string;
  contextLength: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  supportsImages: boolean;
  keywords: string[];
};

const OPENAI_CODEX_CHATGPT_SUPPORTED_MODEL_IDS = new Set([
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

async function loadPiSdkRuntimeModule(): Promise<
  typeof import("./PiSdkRuntime")
> {
  return await import("./PiSdkRuntime");
}

function stripPinnedDateSuffix(modelId: string): string {
  const normalized = String(modelId || "").trim();
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^(.*)-\d{8}(?:-v\d+:\d+)?$/i);
  return match?.[1]?.trim() || "";
}

function normalizePiProviderId(value: unknown): string {
  return normalizeStudioPiProviderId(value);
}

export function isSupportedOpenAiCodexChatModel(providerId: string, modelId: string): boolean {
  const normalizedProviderId = normalizePiProviderId(providerId);
  if (normalizedProviderId !== "openai-codex") {
    return true;
  }

  return OPENAI_CODEX_CHATGPT_SUPPORTED_MODEL_IDS.has(
    String(modelId || "").trim().toLowerCase()
  );
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatPiTokenCount(value: number): string {
  const count = Math.max(0, Math.floor(value || 0));
  if (count >= 1_000_000_000) {
    const scaled = count / 1_000_000_000;
    return Number.isInteger(scaled) ? `${scaled}B` : `${scaled.toFixed(1)}B`;
  }
  if (count >= 1_000_000) {
    const scaled = count / 1_000_000;
    return Number.isInteger(scaled) ? `${scaled}M` : `${scaled.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const scaled = count / 1_000;
    return Number.isInteger(scaled) ? `${scaled}K` : `${scaled.toFixed(1)}K`;
  }
  return String(count);
}

function normalizeModelInputKinds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
}

function buildLocalPiDescription(model: {
  contextLength: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  supportsImages: boolean;
}): string {
  const parts: string[] = [];
  if (model.contextLength > 0) {
    parts.push(`context ${formatPiTokenCount(model.contextLength)}`);
  }
  if (model.maxOutputTokens > 0) {
    parts.push(`max out ${formatPiTokenCount(model.maxOutputTokens)}`);
  }
  parts.push(`thinking ${model.supportsReasoning ? "yes" : "no"}`);
  parts.push(`images ${model.supportsImages ? "yes" : "no"}`);
  return parts.join(" • ");
}

function toLocalPiListEntry(model: {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  input?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
}): LocalPiListedModel | null {
  const providerId = normalizePiProviderId(model.provider);
  const modelId = String(model.id || "").trim();
  if (!providerId || !modelId) {
    return null;
  }

  const label = String(model.name || modelId).trim() || modelId;
  const contextLength = toNumber(model.contextWindow);
  const maxOutputTokens = toNumber(model.maxTokens);
  const supportsReasoning = Boolean(model.reasoning);
  const inputs = normalizeModelInputKinds(model.input);
  const supportsImages = inputs.includes("image");
  const description = buildLocalPiDescription({
    contextLength,
    maxOutputTokens,
    supportsReasoning,
    supportsImages,
  });

  const keywords = Array.from(
    new Set(
      [
        `${providerId}/${modelId}`,
        providerId,
        modelId,
        label,
        contextLength > 0 ? formatPiTokenCount(contextLength) : "",
        maxOutputTokens > 0 ? formatPiTokenCount(maxOutputTokens) : "",
        supportsReasoning ? "yes" : "no",
        supportsImages ? "yes" : "no",
      ].filter((entry) => String(entry || "").trim().length > 0)
    )
  );

  return {
    providerId,
    modelId,
    label,
    description,
    contextLength,
    maxOutputTokens,
    supportsReasoning,
    supportsImages,
    keywords,
  };
}

export function toLocalPiSystemSculptModel(model: LocalPiListedModel): SystemSculptModel {
  const canonicalProviderId = isSystemSculptPiProviderModel(model.providerId, model.modelId)
    ? "systemsculpt"
    : buildLocalPiCanonicalProviderId(model.providerId);
  const canonicalId = buildLocalPiCanonicalModelId(model.providerId, model.modelId);
  const providerLabel = resolveProviderLabel(model.providerId);
  const capabilities = model.supportsReasoning ? ["chat", "reasoning"] : ["chat"];
  const executionModelId = buildLocalPiExecutionModelId(model.providerId, model.modelId);
  const publicModelId = isSystemSculptPiProviderModel(model.providerId, model.modelId)
    ? SYSTEMSCULPT_PI_EXECUTION_MODEL_ID
    : model.modelId;
  const displayName = isSystemSculptPiProviderModel(model.providerId, model.modelId)
    ? "SystemSculpt"
    : model.label;

  return {
    id: canonicalId,
    name: displayName,
    description: model.description || `${providerLabel} via Pi`,
    provider: model.providerId,
    sourceMode: "pi_local",
    sourceProviderId: model.providerId,
    identifier: {
      providerId: canonicalProviderId,
      modelId: publicModelId,
      displayName,
    },
    piExecutionModelId: executionModelId,
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
  } satisfies SystemSculptModel;
}

export async function listLocalPiTextModels(
  plugin: SystemSculptPlugin
): Promise<LocalPiListedModel[]> {
  if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
    return [];
  }

  // Keep lightweight settings/provider inventory reads import-safe on clean hosts.
  const { createPiModelRegistry } = await loadPiSdkRuntimeModule();
  const modelRegistry = createPiModelRegistry({ plugin });
  const models: LocalPiListedModel[] = modelRegistry
    .getAvailable()
    .map((model) => toLocalPiListEntry(model))
    .filter((model): model is LocalPiListedModel => {
      if (!model) {
        return false;
      }
      return isSupportedOpenAiCodexChatModel(model.providerId, model.modelId);
    });

  const byCanonicalId = new Map<string, LocalPiListedModel>();
  for (const model of models) {
    const canonicalId = buildLocalPiCanonicalModelId(model.providerId, model.modelId);
    if (!canonicalId || byCanonicalId.has(canonicalId)) {
      continue;
    }
    byCanonicalId.set(canonicalId, model);
  }

  const providerAliasSets = new Map<string, Set<string>>();
  for (const model of byCanonicalId.values()) {
    const provider = String(model.providerId || "").trim().toLowerCase();
    if (!provider) {
      continue;
    }
    const current = providerAliasSets.get(provider) || new Set<string>();
    current.add(String(model.modelId || "").trim().toLowerCase());
    providerAliasSets.set(provider, current);
  }

  return Array.from(byCanonicalId.values())
    .filter((model) => {
      const provider = String(model.providerId || "").trim().toLowerCase();
      const modelId = String(model.modelId || "").trim().toLowerCase();
      const aliases = providerAliasSets.get(provider);
      if (!aliases) {
        return true;
      }

      const stableBase = stripPinnedDateSuffix(modelId);
      if (!stableBase) {
        return true;
      }

      return !aliases.has(stableBase) && !aliases.has(`${stableBase}-latest`);
    })
    .sort((left, right) => {
      const providerCompare = left.providerId.localeCompare(right.providerId);
      if (providerCompare !== 0) {
        return providerCompare;
      }
      return left.label.localeCompare(right.label);
    });
}

export async function listLocalPiTextModelsAsSystemModels(
  plugin: SystemSculptPlugin
): Promise<SystemSculptModel[]> {
  const models = await listLocalPiTextModels(plugin);
  return models.map((model) => toLocalPiSystemSculptModel(model));
}

export async function listLocalPiTextModelOptions(
  plugin: SystemSculptPlugin
): Promise<LocalPiTextModelOption[]> {
  const models = await listLocalPiTextModels(plugin);
  return models.map((model) => ({
    value: buildLocalPiExecutionModelId(model.providerId, model.modelId),
    label: model.label,
    description: model.description,
    badge: model.providerId,
    keywords: model.keywords,
  }));
}

export async function listLocalPiProviderIds(
  plugin: SystemSculptPlugin
): Promise<string[]> {
  if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
    return [];
  }

  const modelsPath = resolvePiModelsPath(plugin);
  if (!modelsPath) {
    return [];
  }

  try {
    const raw = await readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> } | null;
    const providers =
      parsed?.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
        ? parsed.providers
        : {};

    return Object.keys(providers)
      .map((providerId) => normalizePiProviderId(providerId))
      .filter((providerId) => providerId.length > 0)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function collectSharedPiProviderHints(customProviders: CustomProvider[]): string[] {
  const hintSet = new Set<string>(getDefaultStudioPiProviderHints());
  for (const customProvider of customProviders) {
    const mapped = resolvePiProviderFromEndpoint(customProvider.endpoint || "");
    if (mapped) {
      hintSet.add(mapped);
    }
  }
  return Array.from(hintSet.values());
}

export const listStudioLocalTextModelOptions = listLocalPiTextModelOptions;
export const normalizeStudioLocalPiExecutionModelId = normalizeLocalPiExecutionModelId;
