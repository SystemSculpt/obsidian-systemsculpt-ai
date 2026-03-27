import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type SystemSculptPlugin from "../../main";

export type PiSdkThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function normalizeThinkingLevel(value: unknown): PiSdkThinkingLevel | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return undefined;
}

export function resolvePiWorkingDirectory(plugin: SystemSculptPlugin): string {
  const adapter = plugin.app?.vault?.adapter as {
    getBasePath?: () => string;
    basePath?: string;
  };
  const fromGetter =
    typeof adapter?.getBasePath === "function"
      ? String(adapter.getBasePath() || "").trim()
      : "";
  if (fromGetter) {
    return fromGetter;
  }

  const fromBasePath = String(adapter?.basePath || "").trim();
  if (fromBasePath) {
    return fromBasePath;
  }

  try {
    return process.cwd();
  } catch {
    return "/";
  }
}

function resolvePiModel(
  modelRegistry: ModelRegistry,
  actualModelId: string,
): Model<any> | undefined {
  const normalized = String(actualModelId || "").trim();
  if (!normalized) {
    return undefined;
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return undefined;
  }

  const provider = normalized.slice(0, slashIndex).trim();
  const modelId = normalized.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    return undefined;
  }

  return modelRegistry.find(provider, modelId);
}

type FetchLike = typeof globalThis.fetch;

type PiDesktopFetchRestore = () => void;

function isStandardHeaders(value: unknown): value is Headers {
  return (
    typeof Headers !== "undefined" &&
    value instanceof Headers
  );
}

function normalizeFetchHeaders(value: unknown): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  if (isStandardHeaders(value)) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, headerValue]) => [String(key), String(headerValue)]));
  }

  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => [String(entry?.[0] || ""), String(entry?.[1] || "")]).filter(([key]) => key.length > 0)
    );
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, headerValue]) => [String(key), String(headerValue)])
    );
  }

  return undefined;
}

function toStandardHeaders(value: unknown): Headers | undefined {
  if (isStandardHeaders(value)) {
    return value;
  }

  const normalized = normalizeFetchHeaders(value);
  if (!normalized || typeof Headers === "undefined") {
    return undefined;
  }

  const headers = new Headers();
  for (const [key, headerValue] of Object.entries(normalized)) {
    headers.set(String(key), String(headerValue));
  }
  return headers;
}

function normalizeFetchResponse<T>(response: T): T {
  if (!response || typeof response !== "object") {
    return response;
  }

  const currentHeaders = (response as { headers?: unknown }).headers;
  const headers = toStandardHeaders(currentHeaders);
  if (!headers || headers === currentHeaders) {
    return response;
  }

  const descriptors = Object.getOwnPropertyDescriptors(response);
  const patchedResponse = Object.create(Object.getPrototypeOf(response));
  Object.defineProperties(patchedResponse, descriptors);
  Object.defineProperty(patchedResponse, "headers", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: headers,
  });

  const clone = (response as { clone?: () => unknown }).clone;
  if (typeof clone === "function") {
    Object.defineProperty(patchedResponse, "clone", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => normalizeFetchResponse(clone.call(response)),
    });
  }

  return patchedResponse;
}

async function normalizeFetchBody(input: unknown, init: RequestInit | undefined): Promise<BodyInit | undefined> {
  if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
    return init.body ?? undefined;
  }

  if (!input || typeof input !== "object") {
    return undefined;
  }

  const requestLike = input as Request & { clone?: () => Request };
  const method = String(requestLike.method || "GET").trim().toUpperCase();
  if (method === "GET" || method === "HEAD" || typeof requestLike.clone !== "function") {
    return undefined;
  }

  try {
    return await requestLike.clone().text();
  } catch {
    return undefined;
  }
}

export function installPiDesktopFetchShim(): PiDesktopFetchRestore {
  const runtimeRequire = typeof require === "function" ? require : (globalThis as any).require;
  if (typeof runtimeRequire !== "function") {
    return () => {};
  }

  let sessionFetch: FetchLike | null = null;
  try {
    const electron = runtimeRequire("electron");
    const webContents = electron?.remote?.getCurrentWebContents?.();
    const rawSessionFetch = webContents?.session?.fetch;
    if (typeof rawSessionFetch === "function") {
      sessionFetch = rawSessionFetch.bind(webContents.session) as FetchLike;
    }
  } catch {
    sessionFetch = null;
  }

  if (!sessionFetch) {
    return () => {};
  }

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestLike = typeof Request !== "undefined" && input instanceof Request
      ? input
      : null;
    const url = requestLike
      ? String(requestLike.url || "")
      : input instanceof URL
        ? input.toString()
        : String(input || "");
    const method = String(init?.method || requestLike?.method || "GET").trim() || "GET";
    const headers = normalizeFetchHeaders(init?.headers || requestLike?.headers);
    const body = await normalizeFetchBody(requestLike, init);

    const nextInit: RequestInit = {
      ...(init || {}),
      method,
    };
    if (headers) {
      nextInit.headers = headers;
    }
    if (body !== undefined) {
      nextInit.body = body;
    }

    const response = await sessionFetch!(url, nextInit);
    return normalizeFetchResponse(response);
  }) as FetchLike;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

export async function withPiDesktopFetchShim<T>(callback: () => Promise<T> | T): Promise<T> {
  const restore = installPiDesktopFetchShim();
  try {
    return await callback();
  } finally {
    restore();
  }
}

export function createPiAuthStorage() {
  return AuthStorage.create();
}

export function createPiModelRegistry(authStorage = createPiAuthStorage()): ModelRegistry {
  return new ModelRegistry(authStorage);
}

export async function openPiAgentSession(options: {
  plugin: SystemSculptPlugin;
  sessionFile?: string;
  modelId?: string;
  systemPrompt?: string;
  thinkingLevel?: string;
}): Promise<AgentSession> {
  const cwd = resolvePiWorkingDirectory(options.plugin);
  const authStorage = createPiAuthStorage();
  const modelRegistry = createPiModelRegistry(authStorage);
  const settingsManager = SettingsManager.inMemory();
  const systemPrompt = String(options.systemPrompt || "").trim() || undefined;
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const requestedModel = options.modelId
    ? resolvePiModel(modelRegistry, options.modelId)
    : undefined;
  if (options.modelId && !requestedModel) {
    throw new Error(`Pi could not resolve the configured model "${options.modelId}".`);
  }

  const sessionManager = String(options.sessionFile || "").trim()
    ? SessionManager.open(String(options.sessionFile).trim())
    : SessionManager.create(cwd);

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    model: requestedModel,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: createCodingTools(cwd),
  });

  if (requestedModel) {
    const currentProvider = String(session.model?.provider || "").trim();
    const currentModelId = String(session.model?.id || "").trim();
    if (currentProvider !== String(requestedModel.provider || "").trim() || currentModelId !== String(requestedModel.id || "").trim()) {
      await session.setModel(requestedModel);
    }
  }

  const thinkingLevel = normalizeThinkingLevel(options.thinkingLevel);
  if (thinkingLevel) {
    session.setThinkingLevel(thinkingLevel);
  }

  return session;
}
