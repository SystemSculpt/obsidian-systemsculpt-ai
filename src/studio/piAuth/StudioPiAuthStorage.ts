import { Platform } from "obsidian";
import { loginStudioPiProviderOAuthThroughNode } from "./StudioPiOAuthBridge";
import {
  loadPiSdkModule,
  resolvePiPackageEntryPath,
  type PiSdkAuthCredential,
  type PiSdkAuthStorageInstance,
} from "../../services/pi/PiSdk";
import { ensureBundledPiRuntime } from "../../services/pi/PiRuntimeBootstrap";
import {
  getStudioPiProviderLabelOrUndefined,
  supportsOAuthLogin,
} from "./StudioPiProviderRegistry";
import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

export type StudioPiOAuthProvider = {
  id: string;
  name: string;
  usesCallbackServer: boolean;
};

export type StudioPiAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type StudioPiAuthInfo = {
  url: string;
  instructions?: string;
};

export type StudioPiAuthState = {
  provider: string;
  hasAnyAuth: boolean;
  source: "none" | "oauth" | "api_key" | "environment_or_fallback";
};

export type StudioPiAuthCredentialType = "oauth" | "api_key" | "unknown" | "none";

export type StudioPiProviderAuthRecord = {
  provider: string;
  displayName?: string;
  supportsOAuth: boolean;
  hasAnyAuth: boolean;
  hasStoredCredential: boolean;
  source: StudioPiAuthState["source"];
  credentialType: StudioPiAuthCredentialType;
  oauthExpiresAt: number | null;
};

export type StudioPiApiKeyMigrationCandidate = {
  providerId: string;
  apiKey: string;
  origin?: string;
};

export type StudioPiApiKeyMigrationReason =
  | "invalid_provider"
  | "empty_key"
  | "existing_oauth"
  | "existing_api_key"
  | "existing_stored_credential";

export type StudioPiApiKeyMigrationEntry = {
  provider: string;
  origin?: string;
  reason?: StudioPiApiKeyMigrationReason;
  message?: string;
};

export type StudioPiApiKeyMigrationReport = {
  migrated: StudioPiApiKeyMigrationEntry[];
  skipped: StudioPiApiKeyMigrationEntry[];
  errors: StudioPiApiKeyMigrationEntry[];
};

export type StudioPiOAuthLoginOptions = {
  providerId: string;
  onAuth: (info: StudioPiAuthInfo) => void;
  onPrompt: (prompt: StudioPiAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
};

type StudioPiAuthCredentialRecord = PiSdkAuthCredential;
type StudioPiAuthStorageData = Record<string, StudioPiAuthCredentialRecord>;

type StudioPiOAuthProviderRecord = {
  id?: unknown;
  name?: unknown;
  usesCallbackServer?: unknown;
};

export type StudioPiAuthStorageInstance = PiSdkAuthStorageInstance;

function normalizeAuthSource(credentialType: unknown, hasAnyAuth: boolean): StudioPiAuthState["source"] {
  if (credentialType === "oauth") {
    return "oauth";
  }
  if (credentialType === "api_key") {
    return "api_key";
  }
  if (hasAnyAuth) {
    return "environment_or_fallback";
  }
  return "none";
}

function normalizeCredentialType(credentialType: unknown): StudioPiAuthCredentialType {
  if (credentialType === "oauth") {
    return "oauth";
  }
  if (credentialType === "api_key") {
    return "api_key";
  }
  if (credentialType === undefined || credentialType === null || credentialType === "") {
    return "none";
  }
  return "unknown";
}

async function resolvePiAuthStorage(
  storageOverride?: StudioPiAuthStorageInstance
): Promise<StudioPiAuthStorageInstance> {
  if (storageOverride) {
    return storageOverride;
  }
  const sdk = await loadPiSdkModule();
  return sdk.AuthStorage.create();
}

async function resolveProviderApiKeyFromStorage(
  storage: StudioPiAuthStorageInstance,
  provider: string
): Promise<string> {
  const getApiKey = storage.getApiKey;
  if (typeof getApiKey !== "function") {
    return "";
  }

  try {
    return String((await getApiKey.call(storage, provider)) || "").trim();
  } catch {
    return "";
  }
}

async function resolveProviderHasAnyAuth(
  storage: StudioPiAuthStorageInstance,
  provider: string
): Promise<boolean> {
  const resolvedApiKey = await resolveProviderApiKeyFromStorage(storage, provider);
  if (resolvedApiKey) {
    return true;
  }
  return storage.hasAuth(provider);
}

function getStoredProviderIds(storage: StudioPiAuthStorageInstance): string[] {
  if (typeof storage.list === "function") {
    return storage.list().map((provider) => normalizeStudioPiProviderHint(provider)).filter(Boolean);
  }

  if (typeof storage.getAll === "function") {
    return Object.keys(storage.getAll())
      .map((provider) => normalizeStudioPiProviderHint(provider))
      .filter(Boolean);
  }

  return [];
}

function hasStoredCredential(
  storage: StudioPiAuthStorageInstance,
  provider: string,
  credential: StudioPiAuthCredentialRecord | undefined
): boolean {
  if (typeof storage.has === "function") {
    return storage.has(provider);
  }
  return Boolean(credential);
}

export function buildStudioPiLoginCommand(providerHint: string): string {
  const provider = normalizeStudioPiProviderHint(providerHint);
  return provider ? `pi /login ${provider}` : "pi /login";
}

export async function listStudioPiOAuthProviders(): Promise<StudioPiOAuthProvider[]> {
  const storage = await resolvePiAuthStorage();
  return storage.getOAuthProviders().map((provider) => ({
    id: String(provider.id || "").trim(),
    name: String(provider.name || provider.id || "").trim(),
    usesCallbackServer: Boolean(provider.usesCallbackServer),
  }))
    .filter((provider) => provider.id.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listStudioPiProviderAuthRecords(
  options: { providerHints?: string[] } = {},
  storageOverride?: StudioPiAuthStorageInstance
): Promise<StudioPiProviderAuthRecord[]> {
  const storage = await resolvePiAuthStorage(storageOverride);
  const providerIds = new Set<string>();
  const oauthProvidersById = new Map<string, StudioPiOAuthProvider>();

  for (const provider of storage.getOAuthProviders()) {
    const id = normalizeStudioPiProviderHint(provider.id);
    if (!id) {
      continue;
    }
    providerIds.add(id);
    oauthProvidersById.set(id, {
      id,
      name: String(provider.name || provider.id || id).trim(),
      usesCallbackServer: Boolean(provider.usesCallbackServer),
    });
  }

  for (const provider of getStoredProviderIds(storage)) {
    providerIds.add(provider);
  }

  for (const provider of options.providerHints || []) {
    const normalized = normalizeStudioPiProviderHint(provider);
    if (normalized) {
      providerIds.add(normalized);
    }
  }

  const records: StudioPiProviderAuthRecord[] = [];
  for (const provider of providerIds.values()) {
    const credential = storage.get(provider);
    const hasAnyAuth = await resolveProviderHasAnyAuth(storage, provider);
    const credentialType = normalizeCredentialType(credential?.type);
    const source = normalizeAuthSource(credential?.type, hasAnyAuth);
    const hasStored = hasStoredCredential(storage, provider, credential);
    const oauthExpiresAt =
      credentialType === "oauth" && typeof credential?.expires === "number"
        ? credential.expires
        : null;
    const oauthInfo = oauthProvidersById.get(provider);
    const displayName = getStudioPiProviderLabelOrUndefined(provider, oauthProvidersById);

    records.push({
      provider,
      displayName: displayName || oauthInfo?.name?.trim() || undefined,
      supportsOAuth: supportsOAuthLogin(provider, oauthProvidersById),
      hasAnyAuth,
      hasStoredCredential: hasStored,
      source,
      credentialType,
      oauthExpiresAt,
    });
  }

  records.sort((left, right) => {
    const leftLabel = left.displayName || left.provider;
    const rightLabel = right.displayName || right.provider;
    return leftLabel.localeCompare(rightLabel);
  });

  return records;
}

export async function migrateStudioPiProviderApiKeys(
  candidates: StudioPiApiKeyMigrationCandidate[],
  storageOverride?: StudioPiAuthStorageInstance
): Promise<StudioPiApiKeyMigrationReport> {
  const storage = await resolvePiAuthStorage(storageOverride);
  const report: StudioPiApiKeyMigrationReport = {
    migrated: [],
    skipped: [],
    errors: [],
  };

  for (const candidate of candidates) {
    const provider = normalizeStudioPiProviderHint(candidate.providerId);
    const key = String(candidate.apiKey || "").trim();
    const origin = String(candidate.origin || "").trim() || undefined;

    if (!provider) {
      report.skipped.push({
        provider: String(candidate.providerId || "").trim() || "<unknown>",
        origin,
        reason: "invalid_provider",
      });
      continue;
    }

    if (!key) {
      report.skipped.push({
        provider,
        origin,
        reason: "empty_key",
      });
      continue;
    }

    const existingCredential = storage.get(provider);
    const storedCredentialExists = hasStoredCredential(storage, provider, existingCredential);
    if (storedCredentialExists) {
      const existingType = normalizeCredentialType(existingCredential?.type);
      const reason: StudioPiApiKeyMigrationReason =
        existingType === "oauth"
          ? "existing_oauth"
          : existingType === "api_key"
            ? "existing_api_key"
            : "existing_stored_credential";
      report.skipped.push({
        provider,
        origin,
        reason,
      });
      continue;
    }

    try {
      storage.set(provider, {
        type: "api_key",
        key,
      });
      report.migrated.push({
        provider,
        origin,
      });
    } catch (error) {
      report.errors.push({
        provider,
        origin,
        message: error instanceof Error ? error.message : String(error || "Failed to migrate key."),
      });
    }
  }

  return report;
}

export async function loginStudioPiProviderOAuth(options: StudioPiOAuthLoginOptions): Promise<void> {
  const providerId = normalizeStudioPiProviderHint(options.providerId);
  if (!providerId) {
    throw new Error("Select a valid provider before starting OAuth login.");
  }
  if (!Platform.isDesktopApp) {
    throw new Error("OAuth login is only available on desktop.");
  }
  await ensureBundledPiRuntime();
  const sdkEntryPath = resolvePiPackageEntryPath();
  await loginStudioPiProviderOAuthThroughNode(providerId, sdkEntryPath, options);
}

export async function setStudioPiProviderApiKey(providerHint: string, apiKey: string): Promise<void> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  const key = String(apiKey || "").trim();
  if (!provider) {
    throw new Error("Select a valid provider before saving an API key.");
  }
  if (!key) {
    throw new Error("API key cannot be empty.");
  }
  const storage = await resolvePiAuthStorage();
  storage.set(provider, {
    type: "api_key",
    key,
  });
}

export async function clearStudioPiProviderAuth(providerHint: string): Promise<void> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) {
    throw new Error("Select a valid provider before clearing credentials.");
  }
  const storage = await resolvePiAuthStorage();
  storage.remove(provider);
}

export async function readStudioPiProviderAuthState(providerHint: string): Promise<StudioPiAuthState> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) {
    return {
      provider: "",
      hasAnyAuth: false,
      source: "none",
    };
  }
  const storage = await resolvePiAuthStorage();
  const credentialType = storage.get(provider)?.type;
  const hasAnyAuth = await resolveProviderHasAnyAuth(storage, provider);
  return {
    provider,
    hasAnyAuth,
    source: normalizeAuthSource(credentialType, hasAnyAuth),
  };
}

export async function resolveStudioPiProviderApiKey(providerHint: string): Promise<string | null> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) {
    return null;
  }

  const storage = await resolvePiAuthStorage();
  const apiKey = await resolveProviderApiKeyFromStorage(storage, provider);
  return apiKey || null;
}
