import type { StudioPiProviderAuthRecord } from "../../studio/piAuth/StudioPiAuthInventory";
import type SystemSculptPlugin from "../../main";
import { PlatformContext } from "../PlatformContext";
import {
  normalizeStudioPiProviderId,
} from "../../studio/piAuth/StudioPiProviderAuthUtils";
import {
  getApiKeyEnvVarForProvider,
  resolveProviderLabel,
  supportsOAuthLogin,
} from "../../studio/piAuth/StudioPiProviderRegistry";

export type PiTextProviderCredentialInput = {
  apiKey: string;
};

async function loadStudioPiAuthInventoryModule(): Promise<
  typeof import("../../studio/piAuth/StudioPiAuthInventory")
> {
  return await import("../../studio/piAuth/StudioPiAuthInventory");
}

async function loadStudioPiAuthStorageModule(): Promise<
  typeof import("../../studio/piAuth/StudioPiAuthStorage")
> {
  return await import("../../studio/piAuth/StudioPiAuthStorage");
}

async function loadPiTextModelsModule(): Promise<
  typeof import("../pi/PiTextModels")
> {
  return await import("../pi/PiTextModels");
}

function supportsDesktopPiFeatures(): boolean {
  return PlatformContext.get().supportsDesktopOnlyFeatures();
}

export async function loadPiTextProviderAuth(
  providerHints: string[],
  plugin?: SystemSculptPlugin
): Promise<Map<string, StudioPiProviderAuthRecord>> {
  if (!supportsDesktopPiFeatures() || providerHints.length === 0) {
    return new Map<string, StudioPiProviderAuthRecord>();
  }

  try {
    const { listStudioPiProviderAuthRecords } = await loadStudioPiAuthInventoryModule();
    const records = await listStudioPiProviderAuthRecords({ providerHints, plugin });
    return new Map(
      records
        .map((record) => [normalizeStudioPiProviderId(record.provider), record] as const)
        .filter(([providerId]) => providerId.length > 0)
    );
  } catch {
    return new Map<string, StudioPiProviderAuthRecord>();
  }
}

export async function loadPiTextLocalProviderIds(
  plugin?: SystemSculptPlugin
): Promise<Set<string>> {
  if (!supportsDesktopPiFeatures() || !plugin) {
    return new Set<string>();
  }

  try {
    const { listLocalPiProviderIds } = await loadPiTextModelsModule();
    const providerIds = await listLocalPiProviderIds(plugin);
    return new Set(
      providerIds
        .map((providerId) => normalizeStudioPiProviderId(providerId))
        .filter((providerId) => providerId.length > 0)
    );
  } catch {
    return new Set<string>();
  }
}

export async function resolvePiTextProviderCredential(
  providerHint: string,
  plugin?: SystemSculptPlugin
): Promise<PiTextProviderCredentialInput | null> {
  if (!supportsDesktopPiFeatures()) {
    return null;
  }

  const { resolveStudioPiProviderApiKey } = await loadStudioPiAuthStorageModule();
  const apiKey = await resolveStudioPiProviderApiKey(providerHint, { plugin });
  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
  };
}

export function piTextProviderRequiresAuth(providerHint: string): boolean {
  const providerId = normalizeStudioPiProviderId(providerHint);
  if (!providerId) {
    return false;
  }

  return supportsOAuthLogin(providerId) || getApiKeyEnvVarForProvider(providerId).length > 0;
}

export async function hasPiTextProviderAuth(
  providerHint: string,
  plugin?: SystemSculptPlugin
): Promise<boolean> {
  if (!piTextProviderRequiresAuth(providerHint)) {
    return true;
  }

  if (!supportsDesktopPiFeatures()) {
    return false;
  }

  const providerId = normalizeStudioPiProviderId(providerHint);
  if (!providerId) {
    return false;
  }

  const { resolveStudioPiProviderApiKey } = await loadStudioPiAuthStorageModule();
  const apiKey = await resolveStudioPiProviderApiKey(providerId, { plugin });
  return !!apiKey;
}

export function buildPiTextProviderSetupMessage(
  providerHint: string,
  actualModelId?: string
): string {
  const providerId = normalizeStudioPiProviderId(providerHint);
  const providerLabel = resolveProviderLabel(providerId || providerHint);
  const modelId = String(actualModelId || "").trim();
  if (modelId) {
    return `Connect ${providerLabel} in Pi before running "${modelId}".`;
  }
  return `Connect ${providerLabel} in Pi before using this model.`;
}
