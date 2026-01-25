import { describe, expect, it, jest } from "@jest/globals";
import type { TFile } from "obsidian";
import type { ChatMessage } from "../../types";
import type SystemSculptPlugin from "../../main";
import type { StreamEvent } from "../../streaming/types";
import type { ToolCall, ToolCallRequest } from "../../types/toolCalls";
import { QuickEditController, type QuickEditControllerDeps } from "../controller";

const createFile = (path = "Docs/Example.md"): TFile => {
  return new (require("obsidian").TFile)({ path });
};

const createPlugin = (app: any): SystemSculptPlugin => {
  return {
    settings: {
      selectedModelId: "openrouter/gpt-4.1-mini",
      // mcpEnabled and mcpEnabledTools are deprecated - internal tools always available
    },
    app,
  } as unknown as SystemSculptPlugin;
};

const baseDeps = (): QuickEditControllerDeps => {
  return {
    capabilityChecker: jest.fn().mockResolvedValue({ ok: true, issues: [] }),
    promptBuilder: jest.fn().mockResolvedValue({
      systemPrompt: "system",
      user: { role: "user", content: "user" } as ChatMessage,
    }),
    streamFactory: jest.fn(),
    executeToolCalls: jest.fn().mockResolvedValue([] as ToolCall[]),
    abortControllerFactory: () => ({
      abort: jest.fn(),
      signal: {} as AbortSignal,
    }),
  };
};

const createStreamWithToolCall = (
  args: Record<string, unknown> = { path: "Docs/Example.md", content: "hello everyone" }
): AsyncGenerator<StreamEvent> => {
  async function* generator() {
    yield { type: "content", text: "thinking..." } as StreamEvent;
    yield {
      type: "tool-call",
      phase: "final",
      call: {
        type: "function",
        id: "1",
        function: {
          name: "mcp-filesystem_write",
          arguments: JSON.stringify(args),
        },
      },
    } as StreamEvent;
  }
  return generator();
};

const createStreamWithEditToolCall = (
  args: Record<string, unknown> = { path: "Docs/Example.md", edits: [{ oldText: "world", newText: "everyone" }] }
): AsyncGenerator<StreamEvent> => {
  async function* generator() {
    yield { type: "content", text: "thinking..." } as StreamEvent;
    yield {
      type: "tool-call",
      phase: "final",
      call: {
        type: "function",
        id: "1",
        function: {
          name: "mcp-filesystem_edit",
          arguments: JSON.stringify(args),
        },
      },
    } as StreamEvent;
  }
  return generator();
};

const createStreamWithExplorationToolCall = (
  toolName: string,
  args: Record<string, unknown> = { path: "Docs/Example.md" }
): AsyncGenerator<StreamEvent> => {
  async function* generator() {
    yield { type: "content", text: "thinking..." } as StreamEvent;
    yield {
      type: "tool-call",
      phase: "final",
      call: {
        type: "function",
        id: "1",
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      },
    } as StreamEvent;
  }
  return generator();
};

const createStreamWithContentOnly = (text: string): AsyncGenerator<StreamEvent> => {
  async function* generator() {
    yield { type: "content", text } as StreamEvent;
  }
  return generator();
};

describe("QuickEditController", () => {
  it("stops immediately when capability check fails", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    deps.capabilityChecker = jest.fn().mockResolvedValue({
      ok: false,
      issues: [{ code: "mcp-disabled", message: "Enable MCP" }],
    });
    const controller = new QuickEditController(deps);

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Edit something",
    });

    expect(controller.state).toBe("failed");
    expect(deps.streamFactory).not.toHaveBeenCalled();
  });

  it("collects tool calls and waits for confirmation before executing them", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    (app.vault.read as any).mockResolvedValueOnce("hello world");
    const stream = createStreamWithToolCall();
    deps.streamFactory = jest.fn().mockReturnValue(stream);

    const controller = new QuickEditController(deps);
    const stateUpdates: string[] = [];
    controller.events.on("state", ({ state }) => stateUpdates.push(state));

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Edit something",
    });

    expect(controller.state).toBe("awaiting-confirmation");
    expect(deps.executeToolCalls).not.toHaveBeenCalled();

    controller.complete();

    expect(deps.executeToolCalls).not.toHaveBeenCalled();
    expect(stateUpdates).toContain("awaiting-confirmation");
    expect(controller.state).toBe("completed");
  });

  it("fails when write tool call omits required path", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    deps.streamFactory = jest.fn().mockImplementation(() => createStreamWithToolCall({ content: "x" }));

    const controller = new QuickEditController(deps);
    let previewCalls: ToolCallRequest[] = [];
    let failureMessage = "";
    controller.events.on("preview", ({ toolCalls }) => {
      previewCalls = toolCalls;
    });
    controller.events.on("state", ({ state, error }) => {
      if (state === "failed" && error) failureMessage = error.message;
    });

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Edit without explicit path",
    });

    expect(controller.state).toBe("failed");
    expect(failureMessage).toMatch(/missing required 'path'/i);
    expect(previewCalls.length).toBe(0);
    expect(deps.executeToolCalls).not.toHaveBeenCalled();
  });

  it("retries when the model proposes an edit tool call instead of write", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    (app.vault.read as any).mockResolvedValue("hello world");

    deps.streamFactory = jest
      .fn()
      .mockReturnValueOnce(createStreamWithEditToolCall())
      .mockReturnValueOnce(createStreamWithToolCall({ path: "Docs/Example.md", content: "hello everyone" }));

    const controller = new QuickEditController(deps);

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Change something",
    });

    expect(deps.streamFactory).toHaveBeenCalledTimes(2);
    expect(controller.state).toBe("awaiting-confirmation");
  });

  it("emits a response when the model returns content without tool calls", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    (app.vault.read as any).mockResolvedValueOnce("hello world");

    deps.streamFactory = jest
      .fn()
      .mockReturnValueOnce(createStreamWithContentOnly("Here is the answer you asked for."));

    const controller = new QuickEditController(deps);
    let responseText = "";
    controller.events.on("response", ({ content }) => {
      responseText = content;
    });

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Wrap reply in a codeblock",
    });

    expect(deps.streamFactory).toHaveBeenCalledTimes(1);
    expect(controller.state).toBe("responded");
    expect(responseText).toMatch(/answer you asked/i);
  });

  it("places tool result messages after assistant tool calls for exploration tools", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    (app.vault.read as any).mockResolvedValueOnce("hello world");

    deps.streamFactory = jest
      .fn()
      .mockReturnValueOnce(createStreamWithExplorationToolCall("mcp-filesystem_read", { path: "Docs/Example.md" }))
      .mockReturnValueOnce(createStreamWithContentOnly("No changes needed."));

    deps.executeToolCalls = jest.fn(async (toolCalls: ToolCallRequest[]) => {
      return toolCalls.map((call) => ({
        id: call.id,
        messageId: "user-1",
        request: call,
        state: "completed",
        timestamp: Date.now(),
        autoApproved: true,
        result: { success: true, data: "file content" },
      })) as unknown as ToolCall[];
    });

    const controller = new QuickEditController(deps);

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Read file, then answer.",
    });

    expect(deps.streamFactory).toHaveBeenCalledTimes(2);
    const secondInput = (deps.streamFactory as jest.Mock).mock.calls[1][0];
    const messages = (secondInput?.messages ?? []) as ChatMessage[];

    const assistantIndex = messages.findIndex(
      (m) => m.role === "assistant" && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0
    );
    const toolIndex = messages.findIndex((m) => m.role === "tool");

    expect(assistantIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(assistantIndex);

    const assistantToolCallId = (messages[assistantIndex] as any).tool_calls[0].id;
    expect(messages[toolIndex].tool_call_id).toBe(assistantToolCallId);
    expect(controller.state).toBe("responded");
  });

  it("completes when proposed write content matches the current file", async () => {
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    (app.vault.read as any).mockResolvedValueOnce("hello world");

    const stream = createStreamWithToolCall({
      path: "Docs/Example.md",
      content: "hello world",
    });
    deps.streamFactory = jest.fn().mockReturnValue(stream);

    const controller = new QuickEditController(deps);
    const previewSpy = jest.fn();
    controller.events.on("preview", previewSpy);

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Make sure it's wrapped",
    });

    expect(previewSpy).not.toHaveBeenCalled();
    expect(controller.state).toBe("completed");
  });

  it("aborts streaming and clears previews on cancel", async () => {
    const abortSpy = jest.fn();
    const deps = baseDeps();
    const app = new (require("obsidian").App)();
    (app.vault.read as any).mockResolvedValueOnce("hello world");
    deps.abortControllerFactory = () => ({
      signal: {} as AbortSignal,
      abort: abortSpy,
    });
    const stream = createStreamWithToolCall({ path: "Docs/Example.md", content: "hello everyone" });
    deps.streamFactory = jest.fn().mockReturnValue(stream);

    const controller = new QuickEditController(deps);

    await controller.start({
      plugin: createPlugin(app as any),
      file: createFile(),
      prompt: "Edit something",
    });

    controller.cancel();
    await Promise.resolve();

    expect(abortSpy).toHaveBeenCalled();
    expect(controller.state).toBe("cancelled");
  });
});
