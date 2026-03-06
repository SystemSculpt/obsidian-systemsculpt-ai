import { Platform } from "obsidian";
import {
  listStudioPiProviderAuthRecords,
  resolveStudioPiProviderApiKey,
  type StudioPiProviderAuthRecord,
} from "../../studio/piAuth/StudioPiAuthStorage";
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

export async function loadPiTextProviderAuth(
  providerHints: string[]
): Promise<Map<string, StudioPiProviderAuthRecord>> {
  if (!Platform.isDesktopApp || providerHints.length === 0) {
    return new Map<string, StudioPiProviderAuthRecord>();
  }

  try {
    const records = await listStudioPiProviderAuthRecords({ providerHints });
    return new Map(
      records
        .map((record) => [normalizeStudioPiProviderId(record.provider), record] as const)
        .filter(([providerId]) => providerId.length > 0)
    );
  } catch {
    return new Map<string, StudioPiProviderAuthRecord>();
  }
}

export async function resolvePiTextProviderCredential(
  providerHint: string
): Promise<PiTextProviderCredentialInput | null> {
  if (!Platform.isDesktopApp) {
    return null;
  }

  const apiKey = await resolveStudioPiProviderApiKey(providerHint);
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

export async function hasPiTextProviderAuth(providerHint: string): Promise<boolean> {
  if (!piTextProviderRequiresAuth(providerHint)) {
    return true;
  }

  if (!Platform.isDesktopApp) {
    return false;
  }

  const providerId = normalizeStudioPiProviderId(providerHint);
  if (!providerId) {
    return false;
  }

  const apiKey = await resolveStudioPiProviderApiKey(providerId);
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
