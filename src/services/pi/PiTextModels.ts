import { Platform } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { CustomProvider, SystemSculptModel } from "../../types/llm";
import {
  getDefaultStudioPiProviderHints,
  resolvePiProviderFromEndpoint,
  resolveProviderLabel,
} from "../../studio/piAuth/StudioPiProviderRegistry";
import { normalizeStudioPiProviderId } from "../../studio/piAuth/StudioPiProviderAuthUtils";
import { createCanonicalId } from "../../utils/modelUtils";
import { normalizeLocalPiExecutionModelId } from "./PiCli";
import { loadPiSdkModule, type PiSdkModelRecord } from "./PiSdk";

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

const LOCAL_PI_PROVIDER_PREFIX = "local-pi-";

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

function toLocalPiListEntry(model: PiSdkModelRecord): LocalPiListedModel | null {
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

export function buildLocalPiCanonicalProviderId(providerId: string): string {
  const normalized = normalizePiProviderId(providerId);
  if (!normalized) {
    return "";
  }
  return `${LOCAL_PI_PROVIDER_PREFIX}${normalized}`;
}

export function isLocalPiCanonicalProviderId(providerId: string): boolean {
  return String(providerId || "").trim().toLowerCase().startsWith(LOCAL_PI_PROVIDER_PREFIX);
}

export function getLocalPiProviderIdFromCanonical(providerId: string): string {
  const normalized = String(providerId || "").trim().toLowerCase();
  if (!isLocalPiCanonicalProviderId(normalized)) {
    return "";
  }
  return normalizePiProviderId(normalized.slice(LOCAL_PI_PROVIDER_PREFIX.length));
}

export function buildLocalPiCanonicalModelId(providerId: string, modelId: string): string {
  const canonicalProviderId = buildLocalPiCanonicalProviderId(providerId);
  const normalizedModelId = String(modelId || "").trim();
  if (!canonicalProviderId || !normalizedModelId) {
    return "";
  }
  return createCanonicalId(canonicalProviderId, normalizedModelId);
}

export function buildLocalPiExecutionModelId(providerId: string, modelId: string): string {
  const normalizedProviderId = normalizePiProviderId(providerId);
  const normalizedModelId = String(modelId || "").trim();
  return normalizedProviderId && normalizedModelId ? `${normalizedProviderId}/${normalizedModelId}` : "";
}

export function resolveLocalPiExecutionModelIdFromCanonical(canonicalId: string): string {
  const normalized = String(canonicalId || "").trim();
  if (!normalized) {
    return "";
  }
  const parsed = normalized.includes("@@") ? normalized.split("@@") : [];
  if (parsed.length < 2) {
    return normalizeLocalPiExecutionModelId(normalized);
  }
  const providerId = getLocalPiProviderIdFromCanonical(parsed[0]);
  const modelId = parsed.slice(1).join("@@");
  return buildLocalPiExecutionModelId(providerId, modelId);
}

export function isLocalPiCanonicalModelId(canonicalId: string): boolean {
  const parsedProvider = String(canonicalId || "").trim().split("@@")[0] || "";
  return isLocalPiCanonicalProviderId(parsedProvider);
}

export function toLocalPiSystemSculptModel(model: LocalPiListedModel): SystemSculptModel {
  const canonicalProviderId = buildLocalPiCanonicalProviderId(model.providerId);
  const canonicalId = buildLocalPiCanonicalModelId(model.providerId, model.modelId);
  const providerLabel = resolveProviderLabel(model.providerId);
  const capabilities = model.supportsReasoning ? ["chat", "reasoning"] : ["chat"];

  return {
    id: canonicalId,
    name: model.label,
    description: model.description || `${providerLabel} via Pi`,
    provider: model.providerId,
    sourceMode: "pi_local",
    sourceProviderId: model.providerId,
    identifier: {
      providerId: canonicalProviderId,
      modelId: model.modelId,
      displayName: model.label,
    },
    piExecutionModelId: `${model.providerId}/${model.modelId}`,
    piAuthMode: "local",
    piRemoteAvailable: false,
    piLocalAvailable: true,
    context_length: model.contextLength,
    capabilities,
    supported_parameters: [],
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
  _plugin: SystemSculptPlugin
): Promise<LocalPiListedModel[]> {
  if (!Platform.isDesktopApp) {
    return [];
  }

  const sdk = await loadPiSdkModule();
  const authStorage = sdk.AuthStorage.create();
  const modelRegistry = new sdk.ModelRegistry(authStorage);
  const models = modelRegistry
    .getAvailable()
    .map((model) => toLocalPiListEntry(model))
    .filter((model): model is LocalPiListedModel => !!model);

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
  const models = await listLocalPiTextModels(plugin);
  return Array.from(
    new Set(
      models
        .map((model) => normalizePiProviderId(model.providerId))
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));
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
