import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getApiKeyEnvVarForProvider } from "../../studio/piAuth/StudioPiProviderRegistry";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
} from "@mariozechner/pi-ai/oauth";
import lockfile from "proper-lockfile";

type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredential;
type AuthStorageData = Record<string, AuthCredential>;

type LockResult<T> = {
  result: T;
  next?: string;
};

type AuthStorageBackend = {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
};

type PiOAuthModule = typeof import("@mariozechner/pi-ai/oauth");
type PiOAuthProviders = ReturnType<PiOAuthModule["getOAuthProviders"]>;

function resolveDefaultPiAuthPath(): string {
  const homeDir = String(process?.env?.HOME || process?.env?.USERPROFILE || "").trim();
  if (homeDir) {
    return join(homeDir, ".pi", "agent", "auth.json");
  }

  try {
    return join(process.cwd(), ".pi", "agent", "auth.json");
  } catch {
    return join(".pi", "agent", "auth.json");
  }
}

const commandResultCache = new Map<string, string | undefined>();
let piOAuthModulePromise: Promise<PiOAuthModule> | null = null;

function getConfiguredEnvApiKey(providerId: string): string | undefined {
  const envVar = getApiKeyEnvVarForProvider(providerId);
  if (!envVar || typeof process === "undefined" || !process.env) {
    return undefined;
  }
  const value = String(process.env[envVar] || "").trim();
  return value || undefined;
}

async function loadPiOAuthModule(): Promise<PiOAuthModule> {
  if (!piOAuthModulePromise) {
    piOAuthModulePromise = import("@mariozechner/pi-ai/oauth");
  }
  return await piOAuthModulePromise;
}

function loadPiOAuthModuleSync(): PiOAuthModule | null {
  const runtimeRequire = typeof require === "function" ? require : (globalThis as any).require;
  if (typeof runtimeRequire !== "function") {
    return null;
  }

  try {
    return runtimeRequire("@mariozechner/pi-ai/oauth") as PiOAuthModule;
  } catch {
    return null;
  }
}

function resolveConfigValue(config: string): string | undefined {
  const normalized = String(config || "").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith("!")) {
    if (commandResultCache.has(normalized)) {
      return commandResultCache.get(normalized);
    }

    const command = normalized.slice(1);
    let value: string | undefined;
    try {
      value =
        execSync(command, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        }).trim() || undefined;
    } catch {
      value = undefined;
    }

    commandResultCache.set(normalized, value);
    return value;
  }

  return process.env[normalized] || normalized;
}

class FilePiAuthStorageBackend implements AuthStorageBackend {
  constructor(private readonly authPath: string = resolveDefaultPiAuthPath()) {}

  private ensureParentDir(): void {
    const directory = dirname(this.authPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }

  private ensureFileExists(): void {
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", "utf-8");
      chmodSync(this.authPath, 0o600);
    }
  }

  private acquireLockSyncWithRetry(pathValue: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return lockfile.lockSync(pathValue, { realpath: false });
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code?: unknown }).code !== "undefined"
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== "ELOCKED" || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const startedAt = Date.now();
        while (Date.now() - startedAt < delayMs) {
          // Intentional synchronous backoff to match the SDK locking semantics.
        }
      }
    }

    throw lastError ?? new Error("Failed to acquire auth storage lock.");
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureParentDir();
    this.ensureFileExists();

    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry(this.authPath);
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = fn(current);
      if (typeof next !== "undefined") {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      return result;
    } finally {
      release?.();
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    this.ensureParentDir();
    this.ensureFileExists();

    let release: (() => Promise<void>) | undefined;
    let compromisedError: Error | null = null;
    const throwIfCompromised = () => {
      if (compromisedError) {
        throw compromisedError;
      }
    };

    try {
      release = await lockfile.lock(this.authPath, {
        retries: {
          retries: 10,
          factor: 2,
          minTimeout: 100,
          maxTimeout: 10_000,
          randomize: true,
        },
        stale: 30_000,
        onCompromised: (error) => {
          compromisedError = error;
        },
      });

      throwIfCompromised();
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = await fn(current);
      throwIfCompromised();

      if (typeof next !== "undefined") {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }

      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore unlock failures after compromise.
        }
      }
    }
  }
}

export class BundledPiAuthStorage {
  private data: AuthStorageData = {};
  private runtimeOverrides = new Map<string, string>();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];

  private constructor(private readonly storage: AuthStorageBackend) {
    this.reload();
  }

  static create(authPath?: string): BundledPiAuthStorage {
    return new BundledPiAuthStorage(new FilePiAuthStorageBackend(authPath));
  }

  private recordError(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) {
      return {};
    }
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AuthStorageData)
      : {};
  }

  reload(): void {
    let content: string | undefined;

    try {
      this.storage.withLock((current) => {
        content = current;
        return { result: undefined };
      });
      this.data = this.parseStorageData(content);
      this.loadError = null;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.loadError = normalizedError;
      this.recordError(normalizedError);
    }
  }

  private persistProviderChange(provider: string, credential?: AuthCredential): void {
    if (this.loadError) {
      return;
    }

    try {
      this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return {
          result: undefined,
          next: JSON.stringify(merged, null, 2),
        };
      });
    } catch (error) {
      this.recordError(error);
    }
  }

  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  setFallbackResolver(resolver: (provider: string) => string | undefined): void {
    this.fallbackResolver = resolver;
  }

  get(provider: string): AuthCredential | undefined {
    return this.data[provider] ?? undefined;
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.persistProviderChange(provider, credential);
  }

  remove(provider: string): void {
    delete this.data[provider];
    this.persistProviderChange(provider, undefined);
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  has(provider: string): boolean {
    return provider in this.data;
  }

  hasAuth(provider: string): boolean {
    if (this.runtimeOverrides.has(provider)) {
      return true;
    }
    if (this.data[provider]) {
      return true;
    }
    if (getConfiguredEnvApiKey(provider)) {
      return true;
    }
    if (this.fallbackResolver?.(provider)) {
      return true;
    }
    return false;
  }

  getAll(): AuthStorageData {
    return { ...this.data };
  }

  getOAuthProviders(): PiOAuthProviders {
    const oauthModule = loadPiOAuthModuleSync();
    if (!oauthModule || typeof oauthModule.getOAuthProviders !== "function") {
      return [];
    }

    try {
      return oauthModule.getOAuthProviders();
    } catch (error) {
      this.recordError(error);
      return [];
    }
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const { getOAuthProvider } = await loadPiOAuthModule();
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  logout(provider: string): void {
    this.remove(provider);
  }

  private async refreshOAuthTokenWithLock(providerId: OAuthProviderId): Promise<{
    apiKey: string;
    newCredentials: OAuthCredentials;
  } | null> {
    const { getOAuthApiKey, getOAuthProvider } = await loadPiOAuthModule();
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return null;
    }

    return await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      this.data = currentData;
      this.loadError = null;

      const credential = currentData[providerId];
      if (credential?.type !== "oauth") {
        return { result: null };
      }

      if (Date.now() < credential.expires) {
        return {
          result: {
            apiKey: provider.getApiKey(credential),
            newCredentials: credential,
          },
        };
      }

      const oauthCredentials: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(currentData)) {
        if (value.type === "oauth") {
          oauthCredentials[key] = value;
        }
      }

      const refreshed = await getOAuthApiKey(providerId, oauthCredentials);
      if (!refreshed) {
        return { result: null };
      }

      const merged = {
        ...currentData,
        [providerId]: { type: "oauth", ...refreshed.newCredentials } as AuthCredential,
      };
      this.data = merged;
      this.loadError = null;

      return {
        result: refreshed,
        next: JSON.stringify(merged, null, 2),
      };
    });
  }

  async getApiKey(providerId: string): Promise<string | undefined> {
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) {
      return runtimeKey;
    }

    const credential = this.data[providerId];
    if (credential?.type === "api_key") {
      return resolveConfigValue(credential.key);
    }

    if (credential?.type === "oauth") {
      const { getOAuthProvider } = await loadPiOAuthModule();
      const provider = getOAuthProvider(providerId as OAuthProviderId);
      if (!provider) {
        return undefined;
      }

      const needsRefresh = Date.now() >= credential.expires;
      if (needsRefresh) {
        try {
          const refreshed = await this.refreshOAuthTokenWithLock(providerId as OAuthProviderId);
          if (refreshed) {
            return refreshed.apiKey;
          }
        } catch (error) {
          this.recordError(error);
          this.reload();
          const updatedCredential = this.data[providerId];
          if (updatedCredential?.type === "oauth" && Date.now() < updatedCredential.expires) {
            return provider.getApiKey(updatedCredential);
          }
          return undefined;
        }
      } else {
        return provider.getApiKey(credential);
      }
    }

    const envKey = getConfiguredEnvApiKey(providerId);
    if (envKey) {
      return envKey;
    }

    return this.fallbackResolver?.(providerId) ?? undefined;
  }
}

export type PiAuthStorageInstance = BundledPiAuthStorage;

export const createBundledPiAuthStorage = (
  authPath?: string,
): PiAuthStorageInstance => {
  return BundledPiAuthStorage.create(authPath);
};
