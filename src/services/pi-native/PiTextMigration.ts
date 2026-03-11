import type { SystemSculptModel, CustomProvider } from "../../types/llm";
import { resolvePiProviderFromEndpoint } from "../../studio/piAuth/StudioPiProviderRegistry";
import { createCanonicalId, parseCanonicalId } from "../../utils/modelUtils";
import {
  isLocalPiCanonicalModelId,
  resolveLocalPiExecutionModelIdFromCanonical,
  SYSTEMSCULPT_PI_CANONICAL_MODEL_ID,
} from "../pi/PiCanonicalIds";

function normalizeProviderId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toActualModelId(model: SystemSculptModel): string {
  return String(model.piExecutionModelId || "").trim();
}

function stripPinnedDateSuffix(modelId: string): string {
  const normalized = String(modelId || "").trim();
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^(.*)-\d{8}(?:-v\d+:\d+)?$/i);
  return match?.[1]?.trim() || "";
}

function findModelByActualId(models: SystemSculptModel[], actualModelId: string): SystemSculptModel | undefined {
  const normalized = String(actualModelId || "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return models.find((model) => toActualModelId(model).toLowerCase() === normalized);
}

function findStableAliasModel(
  models: SystemSculptModel[],
  providerId: string,
  modelId: string
): SystemSculptModel | undefined {
  const base = stripPinnedDateSuffix(modelId);
  if (!base) {
    return undefined;
  }

  return (
    findModelByActualId(models, `${providerId}/${base}`) ||
    findModelByActualId(models, `${providerId}/${base}-latest`)
  );
}

function mapLegacyCustomProviderId(
  providerId: string,
  customProviders: CustomProvider[]
): string {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return "";
  }

  const match = (customProviders || []).find((provider) => {
    const providerName = normalizeProviderId(provider.name);
    const providerKey = normalizeProviderId(provider.id);
    return providerName === normalized || providerKey === normalized;
  });

  if (!match) {
    return "";
  }

  return normalizeProviderId(resolvePiProviderFromEndpoint(match.endpoint || ""));
}

function isLegacySystemSculptAlias(providerId: string, modelId: string): boolean {
  return normalizeProviderId(providerId) === "systemsculpt" &&
    String(modelId || "").trim().toLowerCase().startsWith("systemsculpt/");
}

export function normalizeLegacyPiTextSelectionId(savedModelId: string): string {
  const parsed = parseCanonicalId(savedModelId);
  if (!parsed) {
    return savedModelId;
  }

  if (isLegacySystemSculptAlias(parsed.providerId, parsed.modelId)) {
    return SYSTEMSCULPT_PI_CANONICAL_MODEL_ID;
  }

  return savedModelId;
}

function pickBestLocalPiFallback(models: SystemSculptModel[]): SystemSculptModel | undefined {
  return models.find((model) => model.piLocalAvailable) || models[0];
}

export function resolveLegacyPiTextSelection(
  savedModelId: string,
  models: SystemSculptModel[],
  customProviders: CustomProvider[]
): SystemSculptModel | undefined {
  const normalizedSavedModelId = normalizeLegacyPiTextSelectionId(savedModelId);
  const parsed = parseCanonicalId(normalizedSavedModelId);
  if (!parsed) {
    return undefined;
  }

  if (isLocalPiCanonicalModelId(normalizedSavedModelId)) {
    const actualModelId = resolveLocalPiExecutionModelIdFromCanonical(normalizedSavedModelId);
    const directMatch = findModelByActualId(models, actualModelId);
    if (directMatch) {
      return directMatch;
    }

    const [providerId, ...modelIdParts] = actualModelId.split("/");
    return findStableAliasModel(models, providerId || "", modelIdParts.join("/"));
  }

  const mappedProviderId = mapLegacyCustomProviderId(parsed.providerId, customProviders);
  if (mappedProviderId) {
    const actualModelId = `${mappedProviderId}/${parsed.modelId}`;
    return (
      findModelByActualId(models, actualModelId) ||
      findStableAliasModel(models, mappedProviderId, parsed.modelId)
    );
  }

  const canonicalId = createCanonicalId(parsed.providerId, parsed.modelId);
  return (
    models.find((model) => model.id === canonicalId) ||
    findStableAliasModel(models, parsed.providerId, parsed.modelId) ||
    pickBestLocalPiFallback(models)
  );
}

export function resolveLegacyPiTextSelectionId(
  savedModelId: string,
  models: SystemSculptModel[],
  customProviders: CustomProvider[]
): string {
  const migrated = resolveLegacyPiTextSelection(savedModelId, models, customProviders);
  if (migrated?.id) {
    return migrated.id;
  }
  return normalizeLegacyPiTextSelectionId(savedModelId);
}
