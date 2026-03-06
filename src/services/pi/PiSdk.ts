import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ensureBundledPiRuntime,
  resolvePiPluginInstallDir,
} from "./PiRuntimeBootstrap";

type PiSdkRequire = NodeRequire & {
  resolve?: (id: string) => string;
};

export type PiSdkAuthCredential = {
  type?: unknown;
  expires?: unknown;
};

export type PiSdkAuthStorageInstance = {
  getOAuthProviders: () => Array<{
    id?: unknown;
    name?: unknown;
    usesCallbackServer?: unknown;
  }>;
  login: (
    providerId: string,
    callbacks: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (message: string) => void;
      onManualCodeInput?: () => Promise<string>;
      signal?: AbortSignal;
    }
  ) => Promise<void>;
  set: (provider: string, credential: { type: "api_key"; key: string }) => void;
  remove: (provider: string) => void;
  logout: (provider: string) => void;
  get: (provider: string) => PiSdkAuthCredential | undefined;
  hasAuth: (provider: string) => boolean;
  getApiKey?: (provider: string) => Promise<string | undefined>;
  has?: (provider: string) => boolean;
  list?: () => string[];
  getAll?: () => Record<string, PiSdkAuthCredential>;
};

export type PiSdkModelRecord = {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  input?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
};

export type PiSdkModelRegistryInstance = {
  getAll: () => PiSdkModelRecord[];
  getAvailable: () => PiSdkModelRecord[];
  getApiKey: (model: PiSdkModelRecord) => Promise<string | undefined>;
  getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
  isUsingOAuth: (model: PiSdkModelRecord) => boolean;
  getError?: () => string | undefined;
};

export type PiSdkSessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: Record<string, unknown>;
};

export type PiSdkSessionManagerInstance = {
  getSessionId: () => string;
  getSessionFile: () => string | undefined;
  getSessionName: () => string | undefined;
  getBranch: (fromId?: string) => PiSdkSessionEntry[];
  buildSessionContext: () => {
    model: { provider: string; modelId: string } | null;
  };
};

export type PiSdkModule = {
  AuthStorage: {
    create: (authPath?: string) => PiSdkAuthStorageInstance;
  };
  ModelRegistry: new (
    authStorage: PiSdkAuthStorageInstance,
    modelsJsonPath?: string
  ) => PiSdkModelRegistryInstance;
  SessionManager: {
    open: (sessionFile: string, sessionDir?: string) => PiSdkSessionManagerInstance;
  };
};

function resolveRuntimeRequire(): PiSdkRequire | null {
  if (typeof require === "function") {
    return require as PiSdkRequire;
  }

  const browserWindow = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  if (browserWindow && typeof browserWindow.require === "function") {
    return browserWindow.require as PiSdkRequire;
  }

  return null;
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const addRoot = (value: string | undefined) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return;
    }
    roots.add(normalized);
  };

  addRoot(typeof __dirname === "string" ? __dirname : "");
  addRoot(typeof process?.cwd === "function" ? process.cwd() : "");

  const runtimeRequire = resolveRuntimeRequire();
  if (runtimeRequire?.resolve) {
    try {
      addRoot(dirname(runtimeRequire.resolve("obsidian")));
    } catch {
      // Ignore resolution failures and fall back to directory scanning.
    }
  }

  return Array.from(roots.values());
}

export function resolvePiPackageEntryPath(): string {
  const explicitEntry = String(process.env.SYSTEMSCULPT_PI_PACKAGE_ENTRY || "").trim();
  if (explicitEntry && existsSync(explicitEntry)) {
    return explicitEntry;
  }

  const runtimeRequire = resolveRuntimeRequire();
  if (runtimeRequire?.resolve) {
    try {
      const resolved = runtimeRequire.resolve("@mariozechner/pi-coding-agent");
      if (resolved && existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Ignore require.resolve failures and scan for the local package entry below.
    }
  }

  try {
    const pluginInstallDir = resolvePiPluginInstallDir();
    const bundledEntry = join(
      pluginInstallDir,
      "node_modules",
      "@mariozechner",
      "pi-coding-agent",
      "dist",
      "index.js"
    );
    if (existsSync(bundledEntry)) {
      return bundledEntry;
    }
  } catch {
    // Fall through to legacy directory scanning below.
  }

  for (const root of candidateRoots()) {
    let current = root;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(current, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(current);
      if (!parent || parent === current) {
        break;
      }
      current = parent;
    }
  }

  throw new Error(
    "Pi SDK package is unavailable. Reopen Obsidian or retry after the bundled Pi runtime finishes bootstrapping."
  );
}

export function resolvePiPackageRoot(): string {
  const explicitRoot = String(process.env.SYSTEMSCULPT_PI_PACKAGE_ROOT || "").trim();
  if (explicitRoot && existsSync(explicitRoot)) {
    return explicitRoot;
  }

  const entryPath = resolvePiPackageEntryPath();
  return dirname(dirname(entryPath));
}

async function importPiSdkModule<T>(entryPath: string): Promise<T> {
  const importFn = new Function("specifier", "return import(specifier);") as (
    specifier: string
  ) => Promise<T>;
  return await importFn(`file://${entryPath}`);
}

export async function loadPiSdkModule(): Promise<PiSdkModule> {
  await ensureBundledPiRuntime();
  const entryPath = resolvePiPackageEntryPath();
  const runtimeRequire = resolveRuntimeRequire();
  if (runtimeRequire) {
    try {
      return runtimeRequire(entryPath) as PiSdkModule;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      const normalized = message.toLowerCase();
      if (
        !normalized.includes("unexpected token 'export'") &&
        !normalized.includes("must use import") &&
        !normalized.includes("err_require_esm")
      ) {
        throw error;
      }
    }
  }
  return await importPiSdkModule<PiSdkModule>(entryPath);
}
