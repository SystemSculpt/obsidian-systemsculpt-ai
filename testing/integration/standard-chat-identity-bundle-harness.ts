import { readFileSync } from "node:fs";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import fixture from "../fixtures/managed/managed-capabilities-v2.json";

function managedStream(text: string): Response {
  const sessionId = "mchat_0123456789abcdef0123456789abcdef";
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({
      object: "systemsculpt.chat.session",
      session_id: sessionId,
      revision: 1,
      state: "committed",
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  const encoded = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-systemsculpt-session-id": sessionId,
      "x-systemsculpt-session-revision": "1",
    },
  });
}

export async function exerciseBuiltStandardChatIdentity(
  bundleModule: { default?: new (...args: never[]) => object } | (new (...args: never[]) => object),
): Promise<void> {
  const PluginClass = (bundleModule as { default?: new (...args: never[]) => object }).default ?? bundleModule;
  const { App, WorkspaceLeaf } = require("obsidian");
  const { webcrypto } = require("node:crypto");
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
  const app = new App();
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, "..", "..", "manifest.json"), "utf8"),
  );
  const plugin = new (PluginClass as new (app: object, manifest: object) => Record<string, any>)(app, manifest);
  await plugin.onload();
  await plugin.criticalInitializationPromise;
  await plugin.deferredInitializationPromise;
  await plugin.initializeManagers();
  plugin.ensureViewManager().initialize();

  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract });
  const acquireChatTurnLease = jest.fn(async () => ({ outcome: "allowed", lease }));
  const beginAcceptedChatDispatch = jest.fn(() => ({ id: "bundle-ticket" }));
  const transportEnvelope = {
    response: managedStream("Managed agent bundle proof"),
    diagnostics: {
      status: 200,
      requestId: "bundle-request",
      contentType: "text/event-stream",
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfter: null,
      errorText: "",
    },
  };
  const streamAcceptedChat = jest.fn(async () => transportEnvelope);
  const managedClient = {
    acquireChatTurnLease,
    beginAcceptedChatDispatch,
    streamAcceptedChat,
  };
  plugin.getManagedCapabilityClient = () => managedClient;

  for (const key of ["modelService", "getEntitlementService", "providerRegistry", "piAuth", "favorites"]) {
    Object.defineProperty(plugin, key, {
      configurable: true,
      get: () => { throw new Error(`forbidden built ${key} read`); },
    });
  }
  for (const key of ["activeProvider", "customProviders", "credentials", "endpoints"]) {
    Object.defineProperty(plugin.settings, key, {
      configurable: true,
      get: () => { throw new Error(`forbidden built settings.${key} read`); },
    });
  }

  const viewCreator = plugin._views.get("systemsculpt-chat-view") as
    | ((leaf: object) => Record<string, any>)
    | undefined;
  expect(viewCreator).toEqual(expect.any(Function));
  const leaf = new WorkspaceLeaf(app);
  await leaf.setViewState({ type: "systemsculpt-chat-view", state: {} });
  const view = viewCreator!(leaf);

  let durableMessages: Array<Record<string, unknown>> = [];
  let version = 0;
  view.chatStorage.createChatExclusive = jest.fn(async (_id: string, messages: Array<Record<string, unknown>>) => {
    durableMessages = JSON.parse(JSON.stringify(messages));
    version += 1;
    return { version };
  });
  view.chatStorage.saveChat = jest.fn(async (_id: string, messages: Array<Record<string, unknown>>) => {
    durableMessages = JSON.parse(JSON.stringify(messages));
    version += 1;
    return { version };
  });

  let acceptedSnapshot: Record<string, any> | null = null;
  const originalPrepare = view.aiService.prepareAcceptedChatRequest.bind(view.aiService);
  view.aiService.prepareAcceptedChatRequest = async (...args: unknown[]) => {
    acceptedSnapshot = await originalPrepare(...args);
    return acceptedSnapshot;
  };

  await view.onOpen();
  const content = view.containerEl.children[1] as HTMLElement;
  expect(content.querySelector(".systemsculpt-agent-workspace")).not.toBeNull();
  expect(content.querySelector(".systemsculpt-agent-prompt-input")).not.toBeNull();
  expect(content.querySelector(".systemsculpt-chat-identity")).toBeNull();
  expect(content.querySelector("[aria-haspopup]")).toBeNull();
  expect(view.getState()).not.toHaveProperty("selectedModelId");
  expect(view.isLegacyReadOnlyChat()).toBe(false);

  await view.sendAutomationMessage({
    message: "built identity proof",
    includeContextFiles: false,
    focusAfterSend: false,
  });
  await Promise.resolve();

  expect(acquireChatTurnLease).toHaveBeenCalledTimes(1);
  expect(beginAcceptedChatDispatch).toHaveBeenCalledTimes(1);
  expect(streamAcceptedChat).toHaveBeenCalledTimes(1);
  expect(acceptedSnapshot).toEqual(expect.objectContaining({ runtime: "managed", model: "ai-agent" }));
  expect(acceptedSnapshot).not.toHaveProperty("legacyPreparation");
  expect(acceptedSnapshot?.operation.runtime).toBe("managed");
  expect(acceptedSnapshot?.operation.lease).toBe(lease);
  expect(durableMessages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "user", content: "built identity proof" }),
    expect.objectContaining({ role: "assistant", content: "Managed agent bundle proof" }),
  ]));
  expect(view.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "assistant", content: "Managed agent bundle proof" }),
  ]));

  await view.onClose();
  plugin.unload();
}
