/**
 * Pi provider auth storage — thin wrapper around the Pi SDK's AuthStorage.
 *
 * The SDK is a direct npm dependency (`@mariozechner/pi-coding-agent`).
 * Desktop-only: all callers must gate on PlatformContext before reaching here.
 */

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { Platform } from "obsidian";
import { withPiDesktopFetchShim } from "../../services/pi/PiSdkRuntime";
import {
  getStudioPiProviderLabelOrUndefined,
  supportsOAuthLogin,
} from "./StudioPiProviderRegistry";
import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

// ── Public types ──────────────────────────────────────────────────────────

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

// Re-export the SDK instance type so consumers don't need to import the SDK directly.
export type StudioPiAuthStorageInstance = ReturnType<typeof AuthStorage.create>;

// ── Internal helpers ──────────────────────────────────────────────────────

/** Single shared instance — AuthStorage.create() is cheap and reads from disk. */
function getAuthStorage(override?: StudioPiAuthStorageInstance): StudioPiAuthStorageInstance {
  return override ?? AuthStorage.create();
}

function normalizeAuthSource(
  credentialType: unknown,
  hasAnyAuth: boolean,
): StudioPiAuthState["source"] {
  if (credentialType === "oauth") return "oauth";
  if (credentialType === "api_key") return "api_key";
  if (hasAnyAuth) return "environment_or_fallback";
  return "none";
}

function normalizeCredentialType(credentialType: unknown): StudioPiAuthCredentialType {
  if (credentialType === "oauth") return "oauth";
  if (credentialType === "api_key") return "api_key";
  if (!credentialType) return "none";
  return "unknown";
}

async function resolveProviderApiKey(
  storage: StudioPiAuthStorageInstance,
  provider: string,
): Promise<string> {
  if (typeof storage.getApiKey !== "function") return "";
  try {
    return await withPiDesktopFetchShim(async () =>
      String((await storage.getApiKey(provider)) || "").trim()
    );
  } catch {
    return "";
  }
}

async function resolveHasAnyAuth(
  storage: StudioPiAuthStorageInstance,
  provider: string,
): Promise<boolean> {
  if (await resolveProviderApiKey(storage, provider)) return true;
  return storage.hasAuth(provider);
}

function getStoredProviderIds(storage: StudioPiAuthStorageInstance): string[] {
  if (typeof storage.list === "function") {
    return storage.list().map(normalizeStudioPiProviderHint).filter(Boolean);
  }
  if (typeof storage.getAll === "function") {
    return Object.keys(storage.getAll()).map(normalizeStudioPiProviderHint).filter(Boolean);
  }
  return [];
}

function hasStoredCredential(
  storage: StudioPiAuthStorageInstance,
  provider: string,
  credential: { type?: unknown } | undefined,
): boolean {
  if (typeof storage.has === "function") return storage.has(provider);
  return Boolean(credential);
}

// ── Public API ────────────────────────────────────────────────────────────

export function buildStudioPiLoginCommand(providerHint: string): string {
  const provider = normalizeStudioPiProviderHint(providerHint);
  return provider ? `pi /login ${provider}` : "pi /login";
}

export function listStudioPiOAuthProviders(): StudioPiOAuthProvider[] {
  const storage = getAuthStorage();
  return storage
    .getOAuthProviders()
    .map((p) => ({
      id: String(p.id || "").trim(),
      name: String(p.name || p.id || "").trim(),
      usesCallbackServer: Boolean(p.usesCallbackServer),
    }))
    .filter((p) => p.id.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listStudioPiProviderAuthRecords(
  options: { providerHints?: string[] } = {},
  storageOverride?: StudioPiAuthStorageInstance,
): Promise<StudioPiProviderAuthRecord[]> {
  const storage = getAuthStorage(storageOverride);
  const providerIds = new Set<string>();
  const oauthById = new Map<string, StudioPiOAuthProvider>();

  for (const p of storage.getOAuthProviders()) {
    const id = normalizeStudioPiProviderHint(p.id);
    if (!id) continue;
    providerIds.add(id);
    oauthById.set(id, {
      id,
      name: String(p.name || p.id || id).trim(),
      usesCallbackServer: Boolean(p.usesCallbackServer),
    });
  }

  for (const id of getStoredProviderIds(storage)) providerIds.add(id);
  for (const hint of options.providerHints || []) {
    const id = normalizeStudioPiProviderHint(hint);
    if (id) providerIds.add(id);
  }

  const records: StudioPiProviderAuthRecord[] = [];

  for (const provider of providerIds) {
    const credential = storage.get(provider);
    const hasAuth = await resolveHasAnyAuth(storage, provider);
    const credType = normalizeCredentialType(credential?.type);
    const source = normalizeAuthSource(credential?.type, hasAuth);
    const oauthExpiresAt =
      credType === "oauth" && credential?.type === "oauth" && typeof (credential as any).expires === "number"
        ? (credential as any).expires as number
        : null;
    const oauthInfo = oauthById.get(provider);

    records.push({
      provider,
      displayName:
        getStudioPiProviderLabelOrUndefined(provider, oauthById) ||
        oauthInfo?.name?.trim() ||
        undefined,
      supportsOAuth: supportsOAuthLogin(provider, oauthById),
      hasAnyAuth: hasAuth,
      hasStoredCredential: hasStoredCredential(storage, provider, credential),
      source,
      credentialType: credType,
      oauthExpiresAt,
    });
  }

  records.sort((a, b) =>
    (a.displayName || a.provider).localeCompare(b.displayName || b.provider),
  );

  return records;
}

export async function migrateStudioPiProviderApiKeys(
  candidates: StudioPiApiKeyMigrationCandidate[],
  storageOverride?: StudioPiAuthStorageInstance,
): Promise<StudioPiApiKeyMigrationReport> {
  const storage = getAuthStorage(storageOverride);
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
      report.skipped.push({ provider: String(candidate.providerId || "").trim() || "<unknown>", origin, reason: "invalid_provider" });
      continue;
    }
    if (!key) {
      report.skipped.push({ provider, origin, reason: "empty_key" });
      continue;
    }

    const existing = storage.get(provider);
    if (hasStoredCredential(storage, provider, existing)) {
      const existingType = normalizeCredentialType(existing?.type);
      const reason: StudioPiApiKeyMigrationReason =
        existingType === "oauth" ? "existing_oauth"
          : existingType === "api_key" ? "existing_api_key"
            : "existing_stored_credential";
      report.skipped.push({ provider, origin, reason });
      continue;
    }

    try {
      storage.set(provider, { type: "api_key", key } as any);
      report.migrated.push({ provider, origin });
    } catch (error) {
      report.errors.push({
        provider,
        origin,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/**
 * OAuth login — calls the SDK's AuthStorage.login() directly in-process.
 * No child process bridge needed since the SDK is a bundled npm dependency.
 */
export async function loginStudioPiProviderOAuth(
  options: StudioPiOAuthLoginOptions,
): Promise<void> {
  const providerId = normalizeStudioPiProviderHint(options.providerId);
  if (!providerId) throw new Error("Select a valid provider before starting OAuth login.");
  if (!Platform.isDesktopApp) throw new Error("OAuth login is only available on desktop.");

  const storage = getAuthStorage();
  await withPiDesktopFetchShim(async () => {
    await storage.login(providerId, {
      onAuth: options.onAuth,
      onPrompt: options.onPrompt,
      onProgress: options.onProgress,
      onManualCodeInput: options.onManualCodeInput,
      signal: options.signal,
    });
  });
}

export async function setStudioPiProviderApiKey(
  providerHint: string,
  apiKey: string,
): Promise<void> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  const key = String(apiKey || "").trim();
  if (!provider) throw new Error("Select a valid provider before saving an API key.");
  if (!key) throw new Error("API key cannot be empty.");
  const storage = getAuthStorage();
  storage.set(provider, { type: "api_key", key } as any);
}

export async function clearStudioPiProviderAuth(providerHint: string): Promise<void> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) throw new Error("Select a valid provider before clearing credentials.");
  const storage = getAuthStorage();
  storage.remove(provider);
}

export async function readStudioPiProviderAuthState(
  providerHint: string,
): Promise<StudioPiAuthState> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) return { provider: "", hasAnyAuth: false, source: "none" };
  const storage = getAuthStorage();
  const credType = storage.get(provider)?.type;
  const hasAuth = await resolveHasAnyAuth(storage, provider);
  return { provider, hasAnyAuth: hasAuth, source: normalizeAuthSource(credType, hasAuth) };
}

export async function resolveStudioPiProviderApiKey(
  providerHint: string,
): Promise<string | null> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) return null;
  const storage = getAuthStorage();
  return (await resolveProviderApiKey(storage, provider)) || null;
}
