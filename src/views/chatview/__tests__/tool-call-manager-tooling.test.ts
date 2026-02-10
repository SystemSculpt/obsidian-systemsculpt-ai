import { ToolCallManager } from "../ToolCallManager";
import type { ToolCallRequest } from "../../../types/toolCalls";

const flush = async (): Promise<void> =>
  await new Promise((resolve) => setImmediate(resolve));

const createManager = () => {
  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: { settings: {} },
  } as any;

  return new ToolCallManager({} as any, chatView);
};

const createManagerWithMcpTools = (tools: any[]) => {
  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: { settings: {} },
  } as any;
  const mcpService = {
    getAvailableTools: jest.fn().mockResolvedValue(tools),
  } as any;
  return new ToolCallManager(mcpService, chatView);
};

const createManagerWithMcpExecution = () => {
  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: { settings: {} },
  } as any;
  const mcpService = {
    getAvailableTools: jest.fn().mockResolvedValue([]),
    executeTool: jest.fn().mockResolvedValue({ ok: true }),
  } as any;
  return { manager: new ToolCallManager(mcpService, chatView), mcpService, chatView };
};

const createRequest = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  id,
  type: "function",
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

describe("ToolCallManager PI-driven behavior", () => {
  test("executes tool calls immediately without approval gate", async () => {
    const manager = createManager();

    manager.registerTool(
      {
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      async () => ({ ok: true })
    );

    const call = manager.createToolCall(
      createRequest("call_write", "write_file", { path: "A.md", content: "ok" }),
      "msg-1"
    );
    expect(call.state === "executing" || call.state === "completed").toBe(true);

    for (let i = 0; i < 30 && call.state !== "completed"; i++) {
      await flush();
    }

    expect(call.state).toBe("completed");
  });

  test("does not block repeated calls after failure", async () => {
    const manager = createManager();

    manager.registerTool(
      {
        name: "edit_file",
        description: "Edit",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      async () => {
        throw new Error("simulated failure");
      }
    );

    const first = manager.createToolCall(createRequest("call_1", "edit_file", { path: "A.md" }), "msg-loop");
    for (let i = 0; i < 30 && first.state !== "failed"; i++) {
      await flush();
    }
    expect(first.state).toBe("failed");

    const second = manager.createToolCall(createRequest("call_2", "edit_file", { path: "A.md" }), "msg-loop");
    for (let i = 0; i < 30 && second.state !== "failed"; i++) {
      await flush();
    }
    expect(second.state).toBe("failed");
  });

  test("returns all terminal tool results for context", async () => {
    const manager = createManager();

    manager.registerTool(
      {
        name: "ok",
        description: "Ok",
        parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      },
      async (args: any) => ({ n: Number(args?.n ?? 0) })
    );

    const calls = [
      manager.createToolCall(createRequest("call_1", "ok", { n: 1 }), "msg"),
      manager.createToolCall(createRequest("call_2", "ok", { n: 2 }), "msg"),
      manager.createToolCall(createRequest("call_3", "ok", { n: 3 }), "msg"),
    ];

    for (let i = 0; i < 50; i++) {
      if (calls.every((call) => call.state === "completed")) break;
      await flush();
    }

    const results = manager.getToolResultsForContext();
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.map((result) => result.id)).toEqual(expect.arrayContaining(["call_1", "call_2", "call_3"]));
  });

  test("sanitizes MCP tool schemas when building OpenAI tools", async () => {
    const manager = createManagerWithMcpTools([
      {
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          description: "Read",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              paths: { type: "array" },
              offset: { type: "number" },
              length: { type: "number" },
            },
            required: ["paths"],
          },
        },
      },
    ]);

    const tools = await manager.getOpenAITools();
    const mcpReadTool = tools.find((tool) => tool.function.name === "mcp-filesystem_read");
    expect(mcpReadTool).toBeDefined();
    expect(mcpReadTool.function.parameters.required).toEqual(["paths"]);
    expect(mcpReadTool.function.strict).toBeUndefined();

    const canonicalAlias = tools.find((tool) => tool.function.name === "read");
    expect(canonicalAlias).toBeDefined();
    expect(canonicalAlias.function.parameters.required).toEqual(["paths"]);
  });

  test("routes canonical read alias to mcp-filesystem_read and normalizes args", async () => {
    const { manager, mcpService, chatView } = createManagerWithMcpExecution();

    const request = createRequest("call_read_alias", "read", { path: "Notes/A.md" });
    const call = manager.createToolCall(request, "msg-read");

    for (let i = 0; i < 30 && call.state !== "completed"; i++) {
      await flush();
    }

    expect(call.state).toBe("completed");
    expect(mcpService.executeTool).toHaveBeenCalledWith(
      "mcp-filesystem_read",
      { path: "Notes/A.md", paths: ["Notes/A.md"] },
      chatView,
      { timeoutMs: 0 }
    );
  });

  test("routes canonical move alias to mcp-filesystem_move and normalizes args", async () => {
    const { manager, mcpService, chatView } = createManagerWithMcpExecution();

    const request = createRequest("call_move_alias", "move", { from: "A.md", to: "B.md" });
    const call = manager.createToolCall(request, "msg-move");

    for (let i = 0; i < 30 && call.state !== "completed"; i++) {
      await flush();
    }

    expect(call.state).toBe("completed");
    expect(mcpService.executeTool).toHaveBeenCalledWith(
      "mcp-filesystem_move",
      {
        from: "A.md",
        to: "B.md",
        items: [{ source: "A.md", destination: "B.md" }],
      },
      chatView,
      { timeoutMs: 0 }
    );
  });
});
