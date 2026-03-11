import { normalizeStudioPiProviderId } from "../../studio/piAuth/StudioPiProviderAuthUtils";
import { createCanonicalId, parseCanonicalId } from "../../utils/modelUtils";

export const SYSTEMSCULPT_PI_PROVIDER_ID = "systemsculpt";
export const SYSTEMSCULPT_PI_PROVIDER_MODEL_ID = "ai-agent";
export const SYSTEMSCULPT_PI_EXECUTION_MODEL_ID = "systemsculpt/ai-agent";
export const SYSTEMSCULPT_PI_CANONICAL_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";

const LOCAL_PI_PROVIDER_PREFIX = "local-pi-";

export function isSystemSculptPiExecutionModel(modelId: string): boolean {
  return String(modelId || "").trim().toLowerCase() === SYSTEMSCULPT_PI_EXECUTION_MODEL_ID;
}

export function isSystemSculptPiProviderModel(providerId: string, modelId: string): boolean {
  return (
    String(providerId || "").trim().toLowerCase() === SYSTEMSCULPT_PI_PROVIDER_ID &&
    String(modelId || "").trim().toLowerCase() === SYSTEMSCULPT_PI_PROVIDER_MODEL_ID
  );
}

function normalizePiProviderId(value: unknown): string {
  return normalizeStudioPiProviderId(value);
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
  if (isSystemSculptPiProviderModel(providerId, modelId)) {
    return SYSTEMSCULPT_PI_CANONICAL_MODEL_ID;
  }
  const canonicalProviderId = buildLocalPiCanonicalProviderId(providerId);
  const normalizedModelId = String(modelId || "").trim();
  if (!canonicalProviderId || !normalizedModelId) {
    return "";
  }
  return createCanonicalId(canonicalProviderId, normalizedModelId);
}

export function buildLocalPiExecutionModelId(providerId: string, modelId: string): string {
  if (isSystemSculptPiProviderModel(providerId, modelId)) {
    return SYSTEMSCULPT_PI_EXECUTION_MODEL_ID;
  }
  const normalizedProviderId = normalizePiProviderId(providerId);
  const normalizedModelId = String(modelId || "").trim();
  return normalizedProviderId && normalizedModelId ? `${normalizedProviderId}/${normalizedModelId}` : "";
}

export function normalizeLocalPiExecutionModelId(rawModelId: string): string {
  const trimmed = String(rawModelId || "").trim();
  if (!trimmed) {
    return "";
  }

  const parsed = parseCanonicalId(trimmed);
  if (parsed) {
    const provider = String(parsed.providerId || "")
      .trim()
      .toLowerCase()
      .replace(new RegExp(`^${LOCAL_PI_PROVIDER_PREFIX}`), "");
    const model = String(parsed.modelId || "").trim();
    if (provider && model) {
      return `${provider}/${model}`;
    }
  }

  const firstSlash = trimmed.indexOf("/");
  if (firstSlash <= 0 || firstSlash >= trimmed.length - 1) {
    throw new Error(
      `Local (Pi) model "${trimmed}" is invalid. Choose a model in "provider/model" format.`
    );
  }

  const provider = trimmed.slice(0, firstSlash).trim().toLowerCase();
  const model = trimmed.slice(firstSlash + 1).trim();
  if (!provider || !model) {
    throw new Error(
      `Local (Pi) model "${trimmed}" is invalid. Choose a model in "provider/model" format.`
    );
  }
  return `${provider}/${model}`;
}

export function resolveLocalPiExecutionModelIdFromCanonical(canonicalId: string): string {
  const normalized = String(canonicalId || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized === SYSTEMSCULPT_PI_CANONICAL_MODEL_ID) {
    return SYSTEMSCULPT_PI_EXECUTION_MODEL_ID;
  }

  const parsed = parseCanonicalId(normalized);
  if (parsed) {
    const providerId = getLocalPiProviderIdFromCanonical(parsed.providerId);
    const modelId = String(parsed.modelId || "").trim();
    if (providerId && modelId) {
      return buildLocalPiExecutionModelId(providerId, modelId);
    }
  }

  return normalizeLocalPiExecutionModelId(normalized);
}

export function isLocalPiCanonicalModelId(canonicalId: string): boolean {
  if (String(canonicalId || "").trim() === SYSTEMSCULPT_PI_CANONICAL_MODEL_ID) {
    return true;
  }
  const parsedProvider = String(canonicalId || "").trim().split("@@")[0] || "";
  return isLocalPiCanonicalProviderId(parsedProvider);
}
