import { readFileSync } from "node:fs";
import path from "node:path";

export async function exerciseBuiltStandardChatIdentity(
  bundleModule: { default?: new (...args: never[]) => object } | (new (...args: never[]) => object),
): Promise<void> {
  const PluginClass = (bundleModule as { default?: new (...args: never[]) => object }).default ?? bundleModule;
  const { App, WorkspaceLeaf } = require("obsidian");
  const { webcrypto } = require("node:crypto");
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
  if (typeof globalThis.structuredClone !== "function") {
    Object.defineProperty(globalThis, "structuredClone", {
      configurable: true,
      value: <T>(value: T): T => JSON.parse(JSON.stringify(value)),
    });
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
  plugin.settings.licenseKey = "bundle-integration-license";

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

  const originalAgentStart = view.agent.start;
  const originalAgentHydrate = view.agent.hydrate;
  const connectionRequests: Array<Record<string, any>> = [];
  let submittedCommand: Record<string, any> | null = null;
  const sentAgentFrames: Array<Record<string, any>> = [];
  let activeConversationId = "conversation_0123456789abcdef0123456789abcdef";
  let viewOpened = false;
  let viewClosed = false;
  let pluginUnloaded = false;
  try {
  const response = (body: unknown, status: number): Record<string, unknown> => {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    const bytes = new TextEncoder().encode(serialized);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      json: async () => JSON.parse(serialized),
      text: async () => serialized,
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
    };
  };
  const streamResponse = (
    frames: readonly Record<string, unknown>[],
  ): Response => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify(frame)}\n\n`,
          ));
        }
        controller.close();
      },
    });
    return {
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
    } as Response;
  };
  const agentRequest = jest.fn(
    async (request: Record<string, any>) => {
      connectionRequests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/plugin/agent/bootstrap") {
        activeConversationId = request.body.conversation_id;
        return response({
          contract_version: "thin-agent-v1",
          conversation_id: request.body.conversation_id,
          session: { id: "session_0123456789abcdef0123456789abcdef" },
          access: {
            token: "fixture.access.signature",
            expires_at: "2030-01-01T00:01:00.000Z",
          },
          client_input_limits: {
            image_mime_types: ["image/png", "image/jpeg", "image/webp"],
            max_content_blocks_per_message: 16,
            max_images_per_turn: 6,
            max_image_bytes: 6 * 1024 * 1024,
            max_total_image_bytes: 16 * 1024 * 1024,
            max_text_bytes_per_block: 1024 * 1024,
            max_total_text_bytes: 2 * 1024 * 1024,
            max_document_bytes: 25 * 1024 * 1024,
          },
          accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
        }, 200);
      }
      if (url.pathname === "/api/plugin/agent/connect/get-messages") {
        return response({
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "session_snapshot",
          conversation_id: activeConversationId,
          messages: [],
          run_state: { version: 1, cursor: 0, state: "idle" },
        }, 200);
      }
      if (url.pathname === "/api/plugin/agent/context") {
        return response({
          contract_version: "thin-agent-v1",
          context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          expires_at: "2030-01-01T00:02:00.000Z",
          bytes: 2,
          sha256: `sha256:${"b".repeat(64)}`,
        }, 201);
      }
      if (url.pathname === "/api/plugin/agent/turn") {
        const frame = request.body as Record<string, any>;
        sentAgentFrames.push(frame);
        submittedCommand = frame;
        const userMessage = frame.user_message as Record<string, any>;
        const runId = "run_0123456789abcdef0123456789abcdef";
        return streamResponse([{
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "session_snapshot",
          conversation_id: activeConversationId,
          messages: [userMessage],
          run_state: {
            version: 1,
            cursor: 1,
            state: "running",
            request_id: frame.request_id,
            run_id: runId,
            root_message_id: userMessage.id,
          },
        }, {
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "assistant_snapshot",
          conversation_id: activeConversationId,
          request_id: frame.request_id,
          message: {
            id: "assistant-bundle-proof",
            role: "assistant",
            parts: [{ type: "text", text: "Managed agent bundle proof" }],
          },
        }, {
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "run_state",
          conversation_id: activeConversationId,
          run_state: { version: 1, cursor: 2, state: "idle" },
        }, {
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "terminal",
          conversation_id: activeConversationId,
          request_id: frame.request_id,
          terminal: {
            version: 1,
            run_id: runId,
            root_message_id: userMessage.id,
            outcome: "succeeded",
            code: "completed",
          },
        }]);
      }
      throw new Error(`Unexpected compiled integration request: ${request.method} ${url.pathname}`);
    },
  );
  view.agent.requestClient.request = agentRequest;
  const createAgentSession = view.createAgentSession.bind(view);
  view.createAgentSession = () => {
    const next = createAgentSession();
    next.requestClient.request = agentRequest;
    return next;
  };
  view.getLoadedPluginBuildId = jest.fn(async () => `sha256:${"a".repeat(64)}`);

  await view.onOpen();
  viewOpened = true;
  const content = view.containerEl.children[1] as HTMLElement;
  expect(content.querySelector(".systemsculpt-agent-workspace")).not.toBeNull();
  expect(content.querySelector(".systemsculpt-agent-prompt-input")).not.toBeNull();
  expect(content.querySelector(".systemsculpt-chat-identity")).toBeNull();
  expect(content.querySelector("[aria-haspopup]")).toBeNull();
  expect(view.getState()).not.toHaveProperty("selectedModelId");
  expect(view).not.toHaveProperty("isLegacyReadOnlyChat");

  await view.sendAutomationMessage({
    message: "built identity proof",
    includeContextFiles: false,
    focusAfterSend: false,
  });
  await Promise.resolve();

  expect(view.agent.start).toBe(originalAgentStart);
  expect(view.agent.hydrate).toBe(originalAgentHydrate);
  expect(jest.isMockFunction(view.agent.start)).toBe(false);
  expect(jest.isMockFunction(view.agent.hydrate)).toBe(false);
  expect(view.agent.constructor.name).toBe("AgentChatSession");
  expect(view.agent.getSnapshot()).toEqual(expect.objectContaining({
    status: "completed",
  }));
  expect(view.agent.getSnapshot()).not.toHaveProperty("terminalError");
  expect(view.agent.transport?.constructor.name)
    .toBe("AgentStreamingTransport");
  expect(view.agent.session?.constructor.name).toBe("AgentSession");

  const bootstrapRequest = connectionRequests.find(({ url }) =>
    new URL(url).pathname === "/api/plugin/agent/bootstrap");
  const snapshotRequest = connectionRequests.find(({ url }) =>
    new URL(url).pathname === "/api/plugin/agent/connect/get-messages");
  const contextRequest = connectionRequests.find(({ url }) =>
    new URL(url).pathname === "/api/plugin/agent/context");
  const turnRequest = connectionRequests.find(({ url }) =>
    new URL(url).pathname === "/api/plugin/agent/turn");
  expect(bootstrapRequest?.body).toEqual(expect.objectContaining({
    conversation_id: expect.stringMatching(/^conversation_[a-f0-9]{32}$/),
    plugin_build_id: `sha256:${"a".repeat(64)}`,
  }));
  for (const request of [snapshotRequest, contextRequest, turnRequest]) {
    const requestUrl = new URL(request!.url);
    expect([...requestUrl.searchParams.keys()]).toEqual(["access_token"]);
    expect(requestUrl.searchParams.get("access_token")).toBe(
      "fixture.access.signature",
    );
  }
  expect(contextRequest?.body).toEqual(expect.objectContaining({
    root_message_id: expect.stringMatching(/^user-[a-f0-9-]{36}$/),
    context_sources: [],
  }));
  expect(submittedCommand).toEqual(expect.objectContaining({
    type: "systemsculpt.agent.command.v1",
    version: 1,
    kind: "submit",
    // The request identity is the root user message identity, which keeps
    // resubmits of the same turn idempotent on the server.
    request_id: contextRequest?.body.root_message_id,
    user_message: expect.objectContaining({
      id: contextRequest?.body.root_message_id,
      role: "user",
    }),
    context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }));
  expect(submittedCommand).not.toHaveProperty("messages");
  expect(submittedCommand).not.toHaveProperty("preferences");
  expect(submittedCommand).not.toHaveProperty("runtime");
  expect(submittedCommand).not.toHaveProperty("model");
  expect(submittedCommand).not.toHaveProperty("provider");
  expect(submittedCommand).not.toHaveProperty("legacyPreparation");
  expect(JSON.stringify(submittedCommand)).not.toContain("web_search");
  expect(JSON.stringify(submittedCommand)).not.toContain("context_sources");
  expect(sentAgentFrames).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "submit",
    }),
  ]));
  expect(durableMessages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "user", content: "built identity proof" }),
    expect.objectContaining({ role: "assistant", content: "Managed agent bundle proof" }),
  ]));
  expect(view.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "assistant", content: "Managed agent bundle proof" }),
  ]));

  await view.onClose();
  viewClosed = true;
  plugin.unload();
  pluginUnloaded = true;
  } finally {
    if (viewOpened && !viewClosed) {
      try {
        await view.onClose();
      } catch {
        // Preserve the original integration failure while still restoring globals.
      }
    }
    if (!pluginUnloaded) {
      try {
        plugin.unload();
      } catch {
        // Preserve the original integration failure while still restoring globals.
      }
    }
  }
}
