import { readFileSync } from "node:fs";
import path from "node:path";
import fixture from "../fixtures/managed/managed-capabilities-v2.json";

const CANONICAL_ID = "systemsculpt@@systemsculpt/ai-agent";

export async function exerciseBuiltStandardChatIdentity(
  bundleModule: { default?: new (...args: never[]) => object } | (new (...args: never[]) => object),
): Promise<void> {
  const PluginClass = (bundleModule as { default?: new (...args: never[]) => object }).default ?? bundleModule;
  const { App, WorkspaceLeaf } = require("obsidian");
  const app = new App();
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, "..", "..", "manifest.json"), "utf8"),
  );
  const plugin = new (PluginClass as new (app: object, manifest: object) => Record<string, unknown>)(app, manifest);
  await (plugin.onload as () => Promise<void>)();
  await plugin.criticalInitializationPromise;
  await plugin.deferredInitializationPromise;
  await (plugin.initializeManagers as () => Promise<void>)();
  (plugin.ensureViewManager as () => { initialize(): void })().initialize();

  const viewCreator = (plugin._views as Map<string, (leaf: object) => Record<string, unknown>>)
    .get("systemsculpt-chat-view");
  expect(viewCreator).toEqual(expect.any(Function));

  Object.defineProperty(plugin, "modelService", {
    configurable: true,
    get: () => { throw new Error("forbidden built modelService read"); },
  });
  Object.defineProperty(plugin, "getEntitlementService", {
    configurable: true,
    get: () => { throw new Error("forbidden built entitlement read"); },
  });
  for (const key of ["providerRegistry", "piAuth", "favorites"]) {
    Object.defineProperty(plugin, key, {
      configurable: true,
      get: () => { throw new Error(`forbidden built ${key} read`); },
    });
  }
  const settings = plugin.settings as Record<string, unknown>;
  settings.selectedModelId = "openrouter@@openai/gpt-5.4-mini";
  for (const key of ["activeProvider", "customProviders", "credentials", "endpoints"]) {
    Object.defineProperty(settings, key, {
      configurable: true,
      get: () => { throw new Error(`forbidden built settings.${key} read`); },
    });
  }

  const leaf = new WorkspaceLeaf(app);
  await leaf.setViewState({
    type: "systemsculpt-chat-view",
    state: { selectedModelId: "local-pi-openai@@gpt-5.4" },
  });
  const view = viewCreator!(leaf);
  if (!(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver) {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  await (view.onOpen as () => Promise<void>)();
  view.isFullyLoaded = true;

  expect((view.getEffectiveSelectedModelId as () => string)()).toBe(CANONICAL_ID);
  expect((view.getCurrentModelName as () => string)()).toBe("SystemSculpt");
  expect((view.getState as () => { selectedModelId: string })().selectedModelId).toBe(CANONICAL_ID);
  expect((view.isPiBackedChat as () => boolean)()).toBe(false);

  const content = (view.containerEl as HTMLElement).children[1] as HTMLElement;
  expect(content.querySelectorAll(".systemsculpt-chat-identity")).toHaveLength(1);
  expect(content.querySelector(".systemsculpt-chat-identity")?.textContent).toContain("SystemSculpt");
  expect(content.querySelector(".systemsculpt-chat-identity")?.textContent).toContain("ai-agent");
  expect(content.querySelector(".systemsculpt-chat-identity button")).toBeNull();
  expect(content.querySelector("[aria-haspopup]")).toBeNull();

  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract });
  const inputHandler = view.inputHandler as Record<string, unknown>;
  view.commitAcceptedUserMessage = async (input: { message: Record<string, unknown> }) => {
    const snapshot = Object.freeze({
      chatId: "built-chat",
      version: 1,
      messages: Object.freeze([Object.freeze({ ...input.message })]),
    });
    return Object.freeze({
      status: "accepted_current",
      snapshot,
      message: snapshot.messages[0],
      ownership: Object.freeze({
        transcriptIdentity: snapshot,
        generation: 1,
        originalChatId: "built-chat",
        acceptedChatId: "built-chat",
      }),
    });
  };
  view.claimAcceptedUserCommit = () => true;
  view.persistAssistantMessage = async (message: Record<string, unknown>) => message;
  view.saveChat = async () => undefined;
  const acquireChatTurnLease = jest.fn().mockResolvedValue({ outcome: "allowed", lease });
  inputHandler.managedChatAdmission = { acquireChatTurnLease };

  const aiService = view.aiService as Record<string, unknown>;
  const originalPrepare = (aiService.prepareAcceptedChatRequest as (...args: unknown[]) => Promise<Record<string, unknown>>)
    .bind(aiService);
  let acceptedSnapshot: Record<string, unknown> | null = null;
  aiService.prepareAcceptedChatRequest = async (...args: unknown[]) => {
    acceptedSnapshot = await originalPrepare(...args);
    return acceptedSnapshot;
  };
  inputHandler.streamAssistantTurn = jest.fn().mockResolvedValue({
    messageId: "assistant-built",
    message: { role: "assistant", content: "done", message_id: "assistant-built" },
    messageEl: document.createElement("div"),
    completed: true,
    completionState: "completed",
  });

  (inputHandler.setValue as (value: string) => void)("built identity proof");
  await (inputHandler.submitForAutomation as () => Promise<void>)();

  expect(acquireChatTurnLease).toHaveBeenCalledTimes(1);
  expect(acceptedSnapshot).toEqual(expect.objectContaining({
    runtime: "managed",
    model: "ai-agent",
  }));
  expect(acceptedSnapshot).not.toHaveProperty("legacyPreparation");
  expect((acceptedSnapshot?.operation as { runtime: string }).runtime).toBe("managed");
  expect((acceptedSnapshot?.operation as object)).toHaveProperty("lease", lease);

  (plugin.unload as () => void)();
}
