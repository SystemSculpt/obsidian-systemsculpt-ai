/**
 * @jest-environment jsdom
 */

import type { StreamEvent } from "../../../streaming/types";
import { ChatView } from "../ChatView";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { App, WorkspaceLeaf } from "obsidian";

jest.mock("../../../services/RecorderService", () => {
  return {
    RecorderService: {
      getInstance: jest.fn(() => ({
        onToggle: jest.fn(() => () => {}),
      })),
    },
  };
});

const createStream = (events: StreamEvent[]) => (async function* () {
  for (const event of events) {
    yield event;
  }
})();

const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe("ChatView realistic agent flow", () => {
  beforeAll(() => {
    class NoopIntersectionObserver {
      constructor(_cb: IntersectionObserverCallback) {}
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }

    class NoopResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    (window as any).IntersectionObserver = NoopIntersectionObserver;
    (window as any).ResizeObserver = NoopResizeObserver;

    const raf = (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0);
    const caf = (id: number) => window.clearTimeout(id);
    (window as any).requestAnimationFrame = raf;
    (window as any).cancelAnimationFrame = caf;
    (globalThis as any).requestAnimationFrame = raf;
    (globalThis as any).cancelAnimationFrame = caf;

    // Obsidian provides createDiv() globally; our Jest environment needs a shim.
    if (!(globalThis as any).createDiv) {
      (globalThis as any).createDiv = (opts?: any) => {
        const el = document.createElement("div");
        const normalized = typeof opts === "string" ? { cls: opts } : (opts ?? {});
        if (normalized.cls) {
          `${normalized.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
        }
        if (normalized.text !== undefined) {
          el.textContent = `${normalized.text}`;
        }
        if (normalized.attr) {
          Object.entries(normalized.attr).forEach(([key, value]) => {
            if (value === null || value === undefined || value === false) el.removeAttribute(key);
            else if (value === true) el.setAttribute(key, "");
            else el.setAttribute(key, `${value}`);
          });
        }
        return el;
      };
    }
  });

  test("continues PI turns on toolUse and completes after tool results are available", async () => {
    const app = new App();
    const leaf = new WorkspaceLeaf(app);

    const canonicalModelId = "systemsculpt@@test-model";

    const plugin: any = {
      app,
      manifest: { id: "systemsculpt" },
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        selectedModelId: canonicalModelId,
        chatFontSize: "medium",
        systemPromptType: "general-use",
        systemPromptPath: "",
        respectReducedMotion: false,
        // Provider config (so InputHandler can send without modals)
        enableSystemSculptProvider: true,
        licenseKey: "test-key",
        licenseValid: true,
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
        // Tooling
        mcpServers: [],
        // Misc
        autoSubmitAfterTranscription: false,
      },
      modelService: {
        getModelById: jest.fn(async (id: string) => ({
          id,
          name: "Test Model",
          capabilities: [],
          supported_parameters: [],
        })),
        getModels: jest.fn(async () => [{ id: canonicalModelId, name: "Test Model" }]),
      },
    };

    const readStarted: string[] = [];
    const readResolvers = new Map<string, () => void>();
    const writeResolvers = new Map<string, () => void>();

    const streamCalls: any[] = [];
    const streamMessage = jest.fn((opts: any) => {
      streamCalls.push(opts);
      if (streamCalls.length === 1) {
        return createStream([
          { type: "reasoning", text: "Thinking..." },
          { type: "content", text: "I'll use tools." },
          {
            type: "tool-call",
            phase: "delta",
            call: {
              id: "call_readA12345678",
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"A\"" },
            },
          },
          {
            type: "tool-call",
            phase: "final",
            call: {
              id: "call_readA12345678",
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"A\"}" },
            },
          },
          {
            type: "tool-call",
            phase: "final",
            call: {
              id: "call_readB12345678",
              index: 1,
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"B\"}" },
            },
          },
          {
            type: "tool-call",
            phase: "final",
            call: {
              id: "call_write12345678",
              index: 2,
              type: "function",
              function: { name: "write_file", arguments: "{\"path\":\"out.md\",\"content\":\"hello\"}" },
            },
          },
          {
            type: "tool-call",
            phase: "final",
            call: {
              id: "call_fail12345678",
              index: 3,
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"FAIL\"}" },
            },
          },
          { type: "meta", key: "stop-reason", value: "toolUse" },
        ] satisfies StreamEvent[]);
      }

      return createStream([
        { type: "reasoning", text: "Summarizing results..." },
        { type: "content", text: "All done." },
        { type: "meta", key: "stop-reason", value: "stop" },
      ] satisfies StreamEvent[]);
    });

    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({
      streamMessage,
    } as any);

    const chatView = new ChatView(leaf as any, plugin);
    document.body.appendChild(chatView.containerEl);
    // Avoid touching the filesystem in tests; the chat flow only needs an in-memory commit.
    chatView.saveChat = jest.fn(async () => {});

    await chatView.onOpen();
    chatView.isFullyLoaded = true;
    chatView.contextManager.validateAndCleanContextFiles = jest.fn(async () => {});
    chatView.contextManager.addToContextFiles("[[context.md]]");

    // Register a minimal tool set for deterministic testing.
    chatView.toolCallManager.registerTool(
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      async (args: any) => {
        const path = String(args?.path ?? "");
        readStarted.push(path);
        if (path === "FAIL") {
          throw new Error("Simulated tool failure");
        }
        return await new Promise((resolve) => {
          readResolvers.set(path, () => resolve({ path, content: `content:${path}` }));
        });
      }
    );

    chatView.toolCallManager.registerTool(
      {
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      async (args: any) => {
        const path = String(args?.path ?? "");
        return await new Promise((resolve) => {
          writeResolvers.set(path, () => resolve({ ok: true, path }));
        });
      }
    );

    const createdToolCalls: any[] = [];
    const executionStartedIds: string[] = [];
    const executionFailedIds: string[] = [];
    chatView.toolCallManager.on("tool-call:created", ({ toolCall }) => createdToolCalls.push(toolCall));
    chatView.toolCallManager.on("tool-call:execution-started", ({ toolCallId }) => executionStartedIds.push(toolCallId));
    chatView.toolCallManager.on("tool-call:execution-failed", ({ toolCallId }) => executionFailedIds.push(toolCallId));

    // Simulate the user sending a message from the chat composer.
    const input = chatView.containerEl.querySelector("textarea.systemsculpt-chat-input") as HTMLTextAreaElement;
    input.value = "Do the thing (follow instructions).";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const sendPromise = (chatView.inputHandler as any).handleSendMessage();

    // Wait until the assistant stream has started and produced tool calls.
    await waitFor(() => streamCalls.length >= 1);
    await waitFor(() => createdToolCalls.length >= 4);

    // Verify request includes context files and system prompt metadata.
    expect(streamCalls[0].model).toBe(canonicalModelId);
    expect(streamCalls[0].systemPromptType).toBe("general-use");
    expect(streamCalls[0].contextFiles instanceof Set).toBe(true);
    expect(Array.from(streamCalls[0].contextFiles)).toEqual(["[[context.md]]"]);
    expect(streamCalls).toHaveLength(1);

    // Tool calls are auto-approved and start immediately.
    await waitFor(() => readStarted.includes("A") && readStarted.includes("B") && readStarted.includes("FAIL"));
    expect(executionStartedIds).toEqual(expect.arrayContaining(["call_readA12345678", "call_readB12345678"]));

    // Internal (non-MCP) tools auto-approve.
    const writeCall = createdToolCalls.find((tc) => tc.request?.function?.name === "write_file");
    expect(writeCall?.state).toBe("executing");
    await waitFor(() => writeResolvers.has("out.md"));

    // Resolve tool work so the PI toolUse continuation can run.
    readResolvers.get("A")?.();
    readResolvers.get("B")?.();
    writeResolvers.get("out.md")?.();
    await waitFor(() => {
      const readA = createdToolCalls.find((tc) => tc.id === "call_readA12345678");
      const readB = createdToolCalls.find((tc) => tc.id === "call_readB12345678");
      const write = createdToolCalls.find((tc) => tc.id === "call_write12345678");
      return readA?.state === "completed" && readB?.state === "completed" && write?.state === "completed";
    });
    await waitFor(() => streamCalls.length >= 2);

    await sendPromise;
    expect(streamCalls).toHaveLength(2);
    expect(executionFailedIds).toContain("call_fail12345678");

    // Final state: generation is done and the UI has returned to "send" mode.
    const stopBtn = chatView.containerEl.querySelector("button.mod-stop") as HTMLButtonElement;
    expect(stopBtn.style.display).toBe("none");
    const sendBtn = chatView.containerEl.querySelector("button.mod-send") as HTMLButtonElement;
    expect(sendBtn.style.display).toBe("flex");

    chatView.unload();
    document.body.removeChild(chatView.containerEl);
  });

  test("takes repeated PI toolUse continuations without a local hard turn cap", async () => {
    const app = new App();
    const leaf = new WorkspaceLeaf(app);

    const canonicalModelId = "systemsculpt@@test-model";
    const plugin: any = {
      app,
      manifest: { id: "systemsculpt" },
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        selectedModelId: canonicalModelId,
        chatFontSize: "medium",
        systemPromptType: "general-use",
        systemPromptPath: "",
        respectReducedMotion: false,
        enableSystemSculptProvider: true,
        licenseKey: "test-key",
        licenseValid: true,
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
        mcpServers: [],
        autoSubmitAfterTranscription: false,
      },
      modelService: {
        getModelById: jest.fn(async (id: string) => ({
          id,
          name: "Test Model",
          capabilities: [],
          supported_parameters: [],
        })),
        getModels: jest.fn(async () => [{ id: canonicalModelId, name: "Test Model" }]),
      },
    };

    const streamCalls: any[] = [];
    const repeatedToolUseTurns = 6;
    const streamMessage = jest.fn((opts: any) => {
      streamCalls.push(opts);
      const turnNumber = streamCalls.length;

      if (turnNumber <= repeatedToolUseTurns) {
        return createStream([
          {
            type: "tool-call",
            phase: "final",
            call: {
              id: `call_loop_${turnNumber}`,
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: `Loop-${turnNumber}` }) },
            },
          },
          { type: "meta", key: "stop-reason", value: "toolUse" },
        ] satisfies StreamEvent[]);
      }

      return createStream([
        { type: "content", text: "Finished after tool loops." },
        { type: "meta", key: "stop-reason", value: "stop" },
      ] satisfies StreamEvent[]);
    });

    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({
      streamMessage,
    } as any);

    const chatView = new ChatView(leaf as any, plugin);
    document.body.appendChild(chatView.containerEl);
    chatView.saveChat = jest.fn(async () => {});

    await chatView.onOpen();
    chatView.isFullyLoaded = true;
    chatView.contextManager.validateAndCleanContextFiles = jest.fn(async () => {});

    chatView.toolCallManager.registerTool(
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      async (args: any) => ({ path: String(args?.path ?? ""), ok: true })
    );

    const input = chatView.containerEl.querySelector("textarea.systemsculpt-chat-input") as HTMLTextAreaElement;
    input.value = "Loop until PI says stop.";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await (chatView.inputHandler as any).handleSendMessage();

    expect(streamCalls).toHaveLength(repeatedToolUseTurns + 1);
    const stopBtn = chatView.containerEl.querySelector("button.mod-stop") as HTMLButtonElement;
    expect(stopBtn.style.display).toBe("none");

    chatView.unload();
    document.body.removeChild(chatView.containerEl);
  });
});
