import { Platform } from "obsidian";
import type { SystemSculptModel } from "../../types/llm";
import { resolveProviderLabel } from "../../studio/piAuth/StudioPiProviderRegistry";
import type { StudioPiProviderAuthRecord } from "../../studio/piAuth/StudioPiAuthStorage";
import {
  hasAuthenticatedStudioPiProvider,
  normalizeStudioPiProviderId,
  type StudioPiProviderAuthRecordLike,
} from "../../studio/piAuth/StudioPiProviderAuthUtils";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { loadPiTextProviderAuth, piTextProviderRequiresAuth } from "../../services/pi-native/PiTextAuth";

export type ModelSelectorProviderAuthRecord = StudioPiProviderAuthRecordLike &
  Pick<
    StudioPiProviderAuthRecord,
    "displayName" | "supportsOAuth" | "hasAnyAuth" | "hasStoredCredential" | "credentialType" | "source"
  >;

export type ModelSelectionProviderAccessState =
  | "managed"
  | "pi-auth"
  | "local"
  | "unavailable";

export type ModelSelectionProviderSummary = {
  providerId: string;
  providerName: string;
  modelCount: number;
  accessState: ModelSelectionProviderAccessState;
  providerAuthenticated: boolean;
  isCurrentProvider: boolean;
};

export type ModelSelectionProviderSummarySnapshot = {
  totalModels: number;
  totalProviders: number;
  managedProviders: number;
  piReadyProviders: number;
  localProviders: number;
  unavailableProviders: number;
  providers: ModelSelectionProviderSummary[];
};

export type ModelSelectionProviderLabelResolver = (providerName: string) => string;

const EMPTY_PROVIDER_SUMMARY: ModelSelectionProviderSummarySnapshot = {
  totalModels: 0,
  totalProviders: 0,
  managedProviders: 0,
  piReadyProviders: 0,
  localProviders: 0,
  unavailableProviders: 0,
  providers: [],
};

export function createEmptyModelSelectionProviderSummary(): ModelSelectionProviderSummarySnapshot {
  return {
    ...EMPTY_PROVIDER_SUMMARY,
    providers: [],
  };
}

export function normalizeModelSelectorProviderId(value: unknown): string {
  return normalizeStudioPiProviderId(value);
}

export function hasAuthenticatedModelSelectorProvider(
  record: ModelSelectorProviderAuthRecord | null | undefined
): boolean {
  return hasAuthenticatedStudioPiProvider(record);
}

export async function loadModelSelectorProviderAuth(
  models: SystemSculptModel[]
): Promise<Map<string, ModelSelectorProviderAuthRecord>> {
  const providerHints = Array.from(
    new Set(
      models
        .map((model) => normalizeModelSelectorProviderId(model.sourceProviderId || model.provider))
        .filter((providerId) => providerId.length > 0)
    )
  );

  if (!providerHints.length || !Platform.isDesktopApp) {
    return new Map<string, ModelSelectorProviderAuthRecord>();
  }

  return await loadPiTextProviderAuth(providerHints);
}

function defaultResolveProviderName(providerName: string): string {
  const providerId = normalizeModelSelectorProviderId(providerName);
  if (!providerId) {
    return "Pi";
  }
  return resolveProviderLabel(providerId);
}

function resolveCurrentProviderId(models: SystemSculptModel[], selectedModelId?: string): string {
  const selectedCanonicalId = ensureCanonicalId(selectedModelId || "");
  if (!selectedCanonicalId) {
    return "";
  }

  const currentModel = models.find((model) => ensureCanonicalId(model.id) === selectedCanonicalId);
  return currentModel ? normalizeModelSelectorProviderId(currentModel.provider) : "";
}

function getProviderAccessRank(state: ModelSelectionProviderAccessState): number {
  if (state === "managed") {
    return 0;
  }
  if (state === "pi-auth") {
    return 1;
  }
  if (state === "local") {
    return 2;
  }
  return 3;
}

export function resolveModelSelectionAccessStateForModel(
  model: SystemSculptModel,
  providerAuthById: ReadonlyMap<string, ModelSelectorProviderAuthRecord>
): ModelSelectionProviderAccessState {
  const providerId = normalizeModelSelectorProviderId(model.sourceProviderId || model.provider);
  const providerAuthenticated = hasAuthenticatedModelSelectorProvider(providerAuthById.get(providerId));
  const remoteAuthMode = String(model.piAuthMode || "").trim().toLowerCase();
  const remoteManaged = !!model.piRemoteAvailable && (remoteAuthMode === "hosted" || remoteAuthMode === "both");
  if (remoteManaged) {
    return "managed";
  }

  if (!!model.piRemoteAvailable && remoteAuthMode === "byok") {
    return providerAuthenticated ? "pi-auth" : "unavailable";
  }

  const localReady =
    !!model.piLocalAvailable &&
    (!piTextProviderRequiresAuth(providerId) || providerAuthenticated);
  return localReady ? "local" : "unavailable";
}

export function buildModelSelectionProviderSummary(
  models: SystemSculptModel[],
  providerAuthById: ReadonlyMap<string, ModelSelectorProviderAuthRecord>,
  options?: {
    selectedModelId?: string;
    resolveProviderLabel?: ModelSelectionProviderLabelResolver;
  }
): ModelSelectionProviderSummarySnapshot {
  if (!models.length && providerAuthById.size === 0) {
    return createEmptyModelSelectionProviderSummary();
  }

  const resolveProviderName = options?.resolveProviderLabel || defaultResolveProviderName;
  const currentProviderId = resolveCurrentProviderId(models, options?.selectedModelId);
  const providers = new Map<string, ModelSelectionProviderSummary>();

  for (const [providerId, record] of providerAuthById.entries()) {
    providers.set(providerId, {
      providerId,
      providerName: String(record.displayName || "").trim() || resolveProviderName(record.provider || providerId),
      modelCount: 0,
      accessState: hasAuthenticatedModelSelectorProvider(record) ? "pi-auth" : "unavailable",
      providerAuthenticated: hasAuthenticatedModelSelectorProvider(record),
      isCurrentProvider: currentProviderId.length > 0 && currentProviderId === providerId,
    });
  }

  for (const model of models) {
    const providerId = normalizeModelSelectorProviderId(model.provider) || "pi";
    const existing = providers.get(providerId);
    const accessState = resolveModelSelectionAccessStateForModel(model, providerAuthById);
    if (existing) {
      existing.modelCount += 1;
      if (
        accessState === "managed" ||
        accessState === "local" ||
        getProviderAccessRank(accessState) < getProviderAccessRank(existing.accessState)
      ) {
        existing.accessState = accessState;
        existing.providerAuthenticated =
          accessState === "managed" || accessState === "pi-auth" || accessState === "local";
      }
      continue;
    }

    providers.set(providerId, {
      providerId,
      providerName: resolveProviderName(model.provider || providerId) || defaultResolveProviderName(providerId),
      modelCount: 1,
      accessState,
      providerAuthenticated:
        accessState === "managed" || accessState === "pi-auth" || accessState === "local",
      isCurrentProvider: currentProviderId.length > 0 && currentProviderId === providerId,
    });
  }

  const items = Array.from(providers.values()).sort((left, right) => {
    const currentCompare = Number(right.isCurrentProvider) - Number(left.isCurrentProvider);
    if (currentCompare !== 0) {
      return currentCompare;
    }

    const accessCompare = getProviderAccessRank(left.accessState) - getProviderAccessRank(right.accessState);
    if (accessCompare !== 0) {
      return accessCompare;
    }

    const countCompare = right.modelCount - left.modelCount;
    if (countCompare !== 0) {
      return countCompare;
    }

    return left.providerName.localeCompare(right.providerName);
  });

  return {
    totalModels: models.length,
    totalProviders: items.length,
    managedProviders: items.filter((provider) => provider.accessState === "managed").length,
    piReadyProviders: items.filter((provider) => provider.accessState === "pi-auth").length,
    localProviders: items.filter((provider) => provider.accessState === "local").length,
    unavailableProviders: items.filter((provider) => provider.accessState === "unavailable").length,
    providers: items,
  };
}
