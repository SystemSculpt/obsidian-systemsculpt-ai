/**
 * Pi provider auth storage — thin wrapper around the Pi SDK's AuthStorage.
 *
 * The SDK is a direct npm dependency (`@mariozechner/pi-coding-agent`).
 * Desktop-only: all callers must gate on PlatformContext before reaching here.
 */

import { Platform } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { CustomProvider } from "../../types/llm";
import {
  createPiAuthStorage,
  withPiDesktopFetchShim,
} from "../../services/pi/PiSdkDesktopSupport";
import type { PiAuthStorageInstance } from "../../services/pi/PiSdkAuthStorage";
import type {
  StudioPiAuthCredentialType,
  StudioPiAuthState,
} from "./StudioPiAuthInventory";
import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

// ── Public types ──────────────────────────────────────────────────────────
export type {
  StudioPiAuthCredentialType,
  StudioPiAuthState,
  StudioPiOAuthProvider,
  StudioPiProviderAuthRecord,
} from "./StudioPiAuthInventory";

export type StudioPiAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type StudioPiAuthInfo = {
  url: string;
  instructions?: string;
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
  plugin?: SystemSculptPlugin;
  onAuth: (info: StudioPiAuthInfo) => void;
  onPrompt: (prompt: StudioPiAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
};

// Re-export the SDK instance type so consumers don't need to import the SDK directly.
export type StudioPiAuthStorageInstance = PiAuthStorageInstance;

// ── Internal helpers ──────────────────────────────────────────────────────

/** Single shared instance — AuthStorage.create() is cheap and reads from disk. */
type StudioPiAuthStorageContext = {
  plugin?: SystemSculptPlugin | null;
  storage?: StudioPiAuthStorageInstance;
};

function tryGetAuthStorage(
  context: StudioPiAuthStorageContext = {},
): StudioPiAuthStorageInstance | null {
  if (context.storage) {
    return context.storage;
  }

  try {
    return createPiAuthStorage({ plugin: context.plugin });
  } catch {
    return null;
  }
}

function getCustomProviders(plugin?: SystemSculptPlugin | null): CustomProvider[] {
  return Array.isArray(plugin?.settings?.customProviders)
    ? (plugin!.settings.customProviders as CustomProvider[])
    : [];
}

async function upsertPluginStoredApiKey(
  provider: string,
  key: string,
  plugin?: SystemSculptPlugin | null,
): Promise<void> {
  if (!plugin) {
    return;
  }

  const existing = getCustomProviders(plugin);
  const next = [...existing];
  const index = next.findIndex((entry) => normalizeStudioPiProviderHint(entry.id || entry.name) === provider);
  const previous = index >= 0 ? next[index] : undefined;
  const entry: CustomProvider = {
    id: previous?.id || provider,
    name: previous?.name || provider,
    endpoint: previous?.endpoint || "",
    apiKey: key,
    isEnabled: previous?.isEnabled !== false,
    cachedModels: previous?.cachedModels,
    lastFailureTime: previous?.lastFailureTime,
    lastHealthyAt: previous?.lastHealthyAt,
    lastHealthyConfigHash: previous?.lastHealthyConfigHash,
    lastTested: previous?.lastTested,
    failureCount: previous?.failureCount,
  };
  if (index >= 0) {
    next[index] = entry;
  } else {
    next.push(entry);
  }
  await plugin.getSettingsManager().updateSettings({ customProviders: next });
}

async function clearPluginStoredApiKey(
  provider: string,
  plugin?: SystemSculptPlugin | null,
): Promise<void> {
  if (!plugin) {
    return;
  }

  const existing = getCustomProviders(plugin);
  let changed = false;
  const next = existing.map((entry) => {
    if (normalizeStudioPiProviderHint(entry.id || entry.name) !== provider) {
      return entry;
    }
    if (!String(entry.apiKey || "").trim()) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      apiKey: "",
    };
  });
  if (changed) {
    await plugin.getSettingsManager().updateSettings({ customProviders: next });
  }
}

function getAuthStorage(
  context: StudioPiAuthStorageContext = {},
): StudioPiAuthStorageInstance {
  const storage = tryGetAuthStorage(context);
  if (storage) {
    return storage;
  }
  throw new Error("Pi auth storage is unavailable.");
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
  storage: StudioPiAuthStorageInstance | null,
  provider: string,
  plugin?: SystemSculptPlugin | null,
): Promise<string> {
  // Plugin settings is the authoritative source for credential state. If a
  // provider entry exists there with an empty apiKey, the user has explicitly
  // cleared it. We must not shadow that decision with a potentially stale Pi
  // storage value (Pi storage removal can fail silently on mobile).
  const pluginEntry = getCustomProviders(plugin).find(
    (entry) => normalizeStudioPiProviderHint(entry.id || entry.name) === provider,
  );
  const fromPluginSettings = String(pluginEntry?.apiKey || "").trim();

  // If plugin settings knows about this provider but the key is empty, the
  // user cleared it. Return empty regardless of what Pi storage holds.
  if (pluginEntry && !fromPluginSettings) {
    return "";
  }

  if (storage && typeof storage.getApiKey === "function") {
    try {
      const fromStorage = await withPiDesktopFetchShim(async () =>
        String((await storage.getApiKey(provider)) || "").trim()
      );
      if (fromStorage) {
        return fromStorage;
      }
    } catch {
      // fall through to plugin settings fallback
    }
  }

  return fromPluginSettings;
}

function resolvePluginStoredCredential(
  provider: string,
  plugin?: SystemSculptPlugin | null,
): { type: "api_key"; key: string } | undefined {
  const found = getCustomProviders(plugin).find(
    (entry) => normalizeStudioPiProviderHint(entry.id || entry.name) === provider,
  );
  const key = String(found?.apiKey || "").trim();
  if (!key) {
    return undefined;
  }
  return { type: "api_key", key };
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

export async function migrateStudioPiProviderApiKeys(
  candidates: StudioPiApiKeyMigrationCandidate[],
  context: StudioPiAuthStorageContext = {},
): Promise<StudioPiApiKeyMigrationReport> {
  const storage = getAuthStorage(context);
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

  const storage = getAuthStorage({ plugin: options.plugin });
  await withPiDesktopFetchShim(async () => {
    await storage.login(providerId, {
      onAuth: options.onAuth,
      onPrompt: options.onPrompt,
      onProgress: options.onProgress,
      onManualCodeInput: options.onManualCodeInput,
      signal: options.signal,
    });
  });

  // After successful OAuth login, ensure the credential is persisted to auth.json.
  // The SDK's persistProviderChange uses proper-lockfile which can silently fail
  // in Electron. As a safety net, read the credential from the in-memory storage
  // and write auth.json directly if the SDK's persist was lost.
  try {
    const credential = storage.get(providerId);
    if (credential) {
      const { resolvePiAuthPath } = await import("../../services/pi/PiSdkStoragePaths");
      const authPath = resolvePiAuthPath(options.plugin);
      if (authPath) {
        const fs = require("fs");
        const path = require("path");
        const dir = path.dirname(authPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        let existing: Record<string, unknown> = {};
        try {
          if (fs.existsSync(authPath)) {
            existing = JSON.parse(fs.readFileSync(authPath, "utf-8"));
          }
        } catch {
          // Corrupt auth.json — start fresh so the new credential is not lost.
        }
        existing[providerId] = credential;
        fs.writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");
      }
    }
  } catch {
    // Best-effort — the login itself succeeded even if disk persist fails.
  }
}

export async function setStudioPiProviderApiKey(
  providerHint: string,
  apiKey: string,
  context: StudioPiAuthStorageContext = {},
): Promise<void> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  const key = String(apiKey || "").trim();
  if (!provider) throw new Error("Select a valid provider before saving an API key.");
  if (!key) throw new Error("API key cannot be empty.");
  await upsertPluginStoredApiKey(provider, key, context.plugin);
  const storage = tryGetAuthStorage(context);
  if (!storage) {
    return;
  }
  try {
    storage.set(provider, { type: "api_key", key } as any);
  } catch {
    // Mobile and other restricted runtimes may not support Pi auth storage writes.
    // The plugin-settings mirror above remains the source of truth in that case.
  }
}

export async function clearStudioPiProviderAuth(
  providerHint: string,
  context: StudioPiAuthStorageContext = {},
): Promise<void> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) throw new Error("Select a valid provider before clearing credentials.");
  await clearPluginStoredApiKey(provider, context.plugin);
  const storage = tryGetAuthStorage(context);
  if (!storage) {
    return;
  }
  try {
    storage.remove(provider);
  } catch (err) {
    // Plugin-settings fallback is already cleared above. Log a warning so the
    // discrepancy is visible: resolveProviderApiKey prefers Pi storage, so a
    // stale entry there could shadow the cleared plugin-settings value.
    console.warn(
      `[StudioPiAuthStorage] Failed to remove ${provider} from Pi auth storage; plugin-settings entry was cleared but Pi storage may retain stale credentials.`,
      err,
    );
  }
}

export async function readStudioPiProviderAuthState(
  providerHint: string,
  context: StudioPiAuthStorageContext = {},
): Promise<StudioPiAuthState> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) return { provider: "", hasAnyAuth: false, source: "none" };
  const pluginCredential = resolvePluginStoredCredential(provider, context.plugin);
  const storage = tryGetAuthStorage(context);
  const storageCredential = (() => {
    if (!storage) {
      return undefined;
    }
    try {
      return storage.get(provider);
    } catch {
      return undefined;
    }
  })();
  const storageHasAuth = (() => {
    if (!storage) {
      return false;
    }
    try {
      return storage.hasAuth(provider);
    } catch {
      return false;
    }
  })();
  const credType = storageCredential?.type ?? pluginCredential?.type;
  const hasAuth = storageHasAuth || Boolean(pluginCredential);
  return { provider, hasAnyAuth: hasAuth, source: normalizeAuthSource(credType, hasAuth) };
}

export async function resolveStudioPiProviderApiKey(
  providerHint: string,
  context: StudioPiAuthStorageContext = {},
): Promise<string | null> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) return null;
  const storage = tryGetAuthStorage(context);
  return (await resolveProviderApiKey(storage, provider, context.plugin)) || null;
}
