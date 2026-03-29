import type { Model } from "@mariozechner/pi-ai";
import type SystemSculptPlugin from "../../main";
import {
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "./PiSdkCore";
import {
  createPiAuthStorage,
  installPiDesktopFetchShim,
  withPiDesktopFetchShim,
} from "./PiSdkDesktopSupport";
import { resolvePiModelsPath } from "./PiSdkStoragePaths";
import type {
  AgentSession,
  ResourceLoader,
} from "./PiSdkSessionCore";

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

export {
  createPiAuthStorage,
  installPiDesktopFetchShim,
  withPiDesktopFetchShim,
} from "./PiSdkDesktopSupport";

export function createPiModelRegistry(options: {
  plugin?: SystemSculptPlugin | null;
  authStorage?: ReturnType<typeof createPiAuthStorage>;
} = {}): ModelRegistry {
  const authStorage = options.authStorage ?? createPiAuthStorage({ plugin: options.plugin });
  const modelsPath = resolvePiModelsPath(options.plugin);
  return modelsPath
    ? new ModelRegistry(authStorage, modelsPath)
    : new ModelRegistry(authStorage);
}

export async function openPiAgentSession(options: {
  plugin: SystemSculptPlugin;
  sessionFile?: string;
  modelId?: string;
  systemPrompt?: string;
  thinkingLevel?: string;
}): Promise<AgentSession> {
  const {
    createAgentSession,
    createCodingTools,
    createExtensionRuntime,
  } = await import("./PiSdkSessionCore");
  const cwd = resolvePiWorkingDirectory(options.plugin);
  const authStorage = createPiAuthStorage({ plugin: options.plugin });
  const modelRegistry = createPiModelRegistry({
    plugin: options.plugin,
    authStorage,
  });
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
