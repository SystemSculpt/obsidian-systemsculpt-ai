import { readFile } from "fs/promises";
import type SystemSculptPlugin from "../../main";
import { resolvePiAuthPath } from "../../services/pi/PiSdkStoragePaths";
import {
  getApiKeyEnvVarForProvider,
  getKnownStudioPiOAuthProviders,
  getStudioPiProviderLabelOrUndefined,
  supportsOAuthLogin,
} from "./StudioPiProviderRegistry";
import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

export type StudioPiOAuthProvider = {
  id: string;
  name: string;
  usesCallbackServer: boolean;
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

type StoredApiKeyCredential = {
  type?: "api_key";
  key?: unknown;
};

type StoredOAuthCredential = {
  type?: "oauth";
  expires?: unknown;
};

type StoredAuthCredential =
  | StoredApiKeyCredential
  | StoredOAuthCredential
  | Record<string, unknown>;

type StoredAuthData = Record<string, StoredAuthCredential>;

type StudioPiAuthInventoryContext = {
  plugin?: SystemSculptPlugin | null;
  authPath?: string | null;
  authData?: Record<string, unknown> | null;
};

export type StudioPiProviderAuthRecordsOptions = StudioPiAuthInventoryContext & {
  providerHints?: string[];
};

function normalizeStoredAuthData(value: unknown): StoredAuthData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredAuthData)
    : {};
}

async function loadStoredAuthData(
  context: StudioPiAuthInventoryContext = {},
): Promise<StoredAuthData> {
  if (context.authData) {
    return normalizeStoredAuthData(context.authData);
  }

  const authPath = String(context.authPath ?? resolvePiAuthPath(context.plugin) ?? "").trim();
  if (!authPath) {
    return {};
  }

  try {
    const raw = await readFile(authPath, "utf8");
    return normalizeStoredAuthData(JSON.parse(raw));
  } catch {
    return {};
  }
}

function normalizeCredentialType(credentialType: unknown): StudioPiAuthCredentialType {
  if (credentialType === "oauth") return "oauth";
  if (credentialType === "api_key") return "api_key";
  if (!credentialType) return "none";
  return "unknown";
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

function hasStoredCredential(credential: StoredAuthCredential | undefined): boolean {
  return Boolean(credential && typeof credential === "object" && !Array.isArray(credential));
}

function hasEnvironmentApiKey(provider: string): boolean {
  const envVar = getApiKeyEnvVarForProvider(provider);
  if (!envVar) {
    return false;
  }
  const envValue =
    typeof process !== "undefined" && process?.env
      ? process.env[envVar]
      : undefined;
  return String(envValue || "").trim().length > 0;
}

function resolveHasAnyAuth(
  provider: string,
  credential: StoredAuthCredential | undefined,
): boolean {
  return hasStoredCredential(credential) || hasEnvironmentApiKey(provider);
}

export function listStudioPiOAuthProviders(
  _context: StudioPiAuthInventoryContext = {},
): StudioPiOAuthProvider[] {
  return getKnownStudioPiOAuthProviders().map((provider) => ({ ...provider }));
}

export async function listStudioPiProviderAuthRecords(
  options: StudioPiProviderAuthRecordsOptions = {},
): Promise<StudioPiProviderAuthRecord[]> {
  const authData = await loadStoredAuthData(options);
  const providerIds = new Set<string>();
  const oauthProviders = listStudioPiOAuthProviders(options);
  const oauthById = new Map<string, StudioPiOAuthProvider>();

  for (const provider of oauthProviders) {
    const id = normalizeStudioPiProviderHint(provider.id);
    if (!id) {
      continue;
    }
    providerIds.add(id);
    oauthById.set(id, {
      id,
      name: String(provider.name || provider.id || id).trim(),
      usesCallbackServer: Boolean(provider.usesCallbackServer),
    });
  }

  for (const providerId of Object.keys(authData)) {
    const normalized = normalizeStudioPiProviderHint(providerId);
    if (normalized) {
      providerIds.add(normalized);
    }
  }

  for (const hint of options.providerHints || []) {
    const normalized = normalizeStudioPiProviderHint(hint);
    if (normalized) {
      providerIds.add(normalized);
    }
  }

  const records: StudioPiProviderAuthRecord[] = [];

  for (const provider of providerIds) {
    const credential = authData[provider];
    const hasAnyAuth = resolveHasAnyAuth(provider, credential);
    const credentialType = normalizeCredentialType(credential?.type);
    const oauthExpiresAt =
      credentialType === "oauth" && typeof credential?.expires === "number"
        ? credential.expires
        : null;

    records.push({
      provider,
      displayName:
        getStudioPiProviderLabelOrUndefined(provider, oauthById) ||
        oauthById.get(provider)?.name?.trim() ||
        undefined,
      supportsOAuth: supportsOAuthLogin(provider, oauthById),
      hasAnyAuth,
      hasStoredCredential: hasStoredCredential(credential),
      source: normalizeAuthSource(credential?.type, hasAnyAuth),
      credentialType,
      oauthExpiresAt,
    });
  }

  records.sort((left, right) =>
    (left.displayName || left.provider).localeCompare(right.displayName || right.provider),
  );

  return records;
}

export async function readStudioPiProviderAuthState(
  providerHint: string,
  context: StudioPiAuthInventoryContext = {},
): Promise<StudioPiAuthState> {
  const provider = normalizeStudioPiProviderHint(providerHint);
  if (!provider) {
    return { provider: "", hasAnyAuth: false, source: "none" };
  }

  const authData = await loadStoredAuthData(context);
  const credential = authData[provider];
  const hasAnyAuth = resolveHasAnyAuth(provider, credential);
  return {
    provider,
    hasAnyAuth,
    source: normalizeAuthSource(credential?.type, hasAnyAuth),
  };
}
