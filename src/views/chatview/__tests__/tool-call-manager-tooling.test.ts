import { ToolCallManager } from "../ToolCallManager";
import type { ToolCallRequest } from "../../../types/toolCalls";
import { TOOL_LOOP_ERROR_CODE } from "../../../utils/tooling";

const flush = async (): Promise<void> =>
  await new Promise((resolve) => setImmediate(resolve));

const createManager = (settings: Record<string, unknown> = {}) => {
  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: {
      settings,
    },
  } as any;

  const manager = new ToolCallManager({} as any, chatView);
  return manager;
};

const createManagerWithMcpTools = (tools: any[], settings: Record<string, unknown> = {}) => {
  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: {
      settings,
    },
  } as any;
  const mcpService = {
    getAvailableTools: jest.fn().mockResolvedValue(tools),
  } as any;
  return new ToolCallManager(mcpService, chatView);
};

const createManagerWithMcpExecution = (settings: Record<string, unknown> = {}) => {
  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: {
      settings,
    },
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

describe("ToolCallManager tooling settings", () => {
  test("auto-approves all tools by default", async () => {
    const manager = createManager({
      toolingToolCallTimeoutMs: 0,
    });

    manager.registerTool(
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      async (args: any) => ({ path: String(args?.path ?? ""), content: "ok" })
    );

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

    // Internal registered tools auto-approve (no MCP prefix)
    expect(manager.shouldAutoApprove("read_file")).toBe(true);
    expect(manager.shouldAutoApprove("write_file")).toBe(true);
    // External MCP servers require approval
    expect(manager.shouldAutoApprove("mcp-shell_run_command")).toBe(false);

    const readCall = manager.createToolCall(createRequest("call_read", "read_file", { path: "A" }), "msg-1", false);
    const writeCall = manager.createToolCall(createRequest("call_write", "write_file", { path: "B", content: "C" }), "msg-1", false);
    await flush();

    expect(readCall.autoApproved).toBe(true);
    expect(writeCall.autoApproved).toBe(true);
    expect(["executing", "completed"]).toContain(readCall.state);
    expect(["executing", "completed"]).toContain(writeCall.state);
  });

  test("all tools execute immediately without pending state", async () => {
    const manager = createManager({
      toolingToolCallTimeoutMs: 0,
    });

    let resolveWrite: (() => void) | null = null;
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
      async () =>
        await new Promise((resolve) => {
          resolveWrite = () => resolve({ ok: true });
        })
    );

    expect(manager.shouldAutoApprove("write_file")).toBe(true);

    const toolCall = manager.createToolCall(
      createRequest("call_write", "write_file", { path: "A", content: "ok" }),
      "msg-2",
      false
    );
    await flush();
    expect(toolCall.autoApproved).toBe(true);
    expect(["executing", "completed"]).toContain(toolCall.state);

    resolveWrite?.();
    await flush();
    expect(toolCall.state).toBe("completed");
  });

  test("enforces toolingConcurrencyLimit and drains queue as executions finish", async () => {
    const manager = createManager({
      toolingConcurrencyLimit: 2,
      toolingToolCallTimeoutMs: 0,
    });

    let active = 0;
    let maxActive = 0;
    const resolvers = new Map<string, () => void>();

    manager.registerTool(
      {
        name: "delay",
        description: "Delay until resolved",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
      async (args: any) => {
        const key = String(args?.key ?? "");
        active += 1;
        maxActive = Math.max(maxActive, active);
        return await new Promise((resolve) => {
          resolvers.set(key, () => {
            active -= 1;
            resolve({ key });
          });
        });
      }
    );

    const tcA = manager.createToolCall(createRequest("call_A", "delay", { key: "A" }), "msg-3", false);
    const tcB = manager.createToolCall(createRequest("call_B", "delay", { key: "B" }), "msg-3", false);
    const tcC = manager.createToolCall(createRequest("call_C", "delay", { key: "C" }), "msg-3", false);

    manager.approveToolCall(tcA.id);
    manager.approveToolCall(tcB.id);
    manager.approveToolCall(tcC.id);
    await flush();

    const executing = [tcA, tcB, tcC].filter((tc) => tc.state === "executing");
    expect(executing).toHaveLength(2);
    expect([tcA, tcB, tcC].some((tc) => tc.state === "approved")).toBe(true);
    expect(maxActive).toBe(2);

    resolvers.get("A")?.();
    await flush();
    expect([tcA, tcB, tcC].filter((tc) => tc.state === "executing")).toHaveLength(2);
    expect(maxActive).toBe(2);

    resolvers.get("B")?.();
    resolvers.get("C")?.();
    await flush();

    expect(tcA.state).toBe("completed");
    expect(tcB.state).toBe("completed");
    expect(tcC.state).toBe("completed");
  });

  test("fails hung tools after toolingToolCallTimeoutMs and frees the queue", async () => {
    const manager = createManager({
      toolingConcurrencyLimit: 1,
      toolingToolCallTimeoutMs: 40,
    });

    manager.registerTool(
      {
        name: "hang",
        description: "Never resolves",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async () => await new Promise(() => {})
    );

    let resolveNext: (() => void) | null = null;
    manager.registerTool(
      {
        name: "next",
        description: "Resolves when allowed",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async () =>
        await new Promise((resolve) => {
          resolveNext = () => resolve({ ok: true });
        })
    );

    const tcHang = manager.createToolCall(createRequest("call_hang", "hang"), "msg-4", false);
    const tcNext = manager.createToolCall(createRequest("call_next", "next"), "msg-4", false);

    manager.approveToolCall(tcHang.id);
    manager.approveToolCall(tcNext.id);
    await flush();

    expect(tcHang.state).toBe("executing");
    expect(tcNext.state).toBe("approved");

    const deadline = Date.now() + 500;
    while (Date.now() < deadline && tcHang.state !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await flush();
    }

    expect(tcHang.state).toBe("failed");
    expect(tcHang.result?.error?.code).toBe("TIMEOUT");

    while (Date.now() < deadline && tcNext.state === "approved") {
      await flush();
    }

    expect(tcNext.state).toBe("executing");
    resolveNext?.();
    await flush();
    expect(tcNext.state).toBe("completed");
  });

  test("respects toolingMaxToolResultsInContext and includes failed calls", async () => {
    const manager = createManager({
      toolingConcurrencyLimit: 1,
      toolingMaxToolResultsInContext: 2,
      toolingToolCallTimeoutMs: 0,
      mcpServers: [{ id: "mcp-disabled", name: "Disabled", transport: "http", isEnabled: false }],
    });

    manager.registerTool(
      {
        name: "ok",
        description: "Ok tool",
        parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      },
      async (args: any) => ({ n: Number(args?.n ?? 0) })
    );

    const tc1 = manager.createToolCall(createRequest("call_1", "ok", { n: 1 }), "msg-5", true);
    const tc2 = manager.createToolCall(createRequest("call_2", "ok", { n: 2 }), "msg-5", true);
    const tc3 = manager.createToolCall(createRequest("call_3", "ok", { n: 3 }), "msg-5", true);

    for (let i = 0; i < 50; i++) {
      if (tc1.state === "completed" && tc2.state === "completed" && tc3.state === "completed") {
        break;
      }
      await flush();
    }

    expect(tc1.state).toBe("completed");
    expect(tc2.state).toBe("completed");
    expect(tc3.state).toBe("completed");

    // Make ordering deterministic for the "last N" sort key.
    tc1.executionCompletedAt = 100;
    tc2.executionCompletedAt = 200;
    tc3.executionCompletedAt = 300;

    // Add a failed call (disabled MCP server) - should be included in terminal results
    const failed = manager.createToolCall(
      createRequest("call_failed", "mcp-disabled_something", {}),
      "msg-5",
      true
    );
    expect(failed.state).toBe("failed");
    failed.timestamp = 400;

    const results = manager.getToolResultsForContext();
    const ids = results.map((tc) => tc.id);

    // Should have 2 results (maxToolResultsInContext) including the most recent (call_3) and failed
    expect(results).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set(["call_failed", "call_3"]));
  });

  test("blocks repeated tool calls after denial in the same turn", async () => {
    const manager = createManager({
      toolingToolCallTimeoutMs: 0,
    });

    const first = manager.createToolCall(
      createRequest("call_move_1", "mcp-filesystem_move", { from: "A", to: "B" }),
      "msg-loop",
      false
    );
    manager.denyToolCall(first.id);
    expect(first.state).toBe("denied");

    const second = manager.createToolCall(
      createRequest("call_move_2", "mcp-filesystem_move", { to: "B", from: "A" }),
      "msg-loop",
      false
    );
    expect(second.state).toBe("failed");
    expect(second.result?.error?.code).toBe(TOOL_LOOP_ERROR_CODE);
  });

  test("blocks repeated tool calls after repeated failures in the same turn", async () => {
    const manager = createManager({
      toolingToolCallTimeoutMs: 0,
    });

    let executions = 0;
    manager.registerTool(
      {
        name: "edit_file",
        description: "Edit a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      async () => {
        executions += 1;
        throw new Error("Simulated failure");
      }
    );

    const first = manager.createToolCall(createRequest("call_edit_1", "edit_file", { path: "A" }), "msg-fail", false);
    for (let i = 0; i < 10 && first.state !== "failed"; i++) {
      await flush();
    }
    expect(first.state).toBe("failed");

    const second = manager.createToolCall(createRequest("call_edit_2", "edit_file", { path: "A" }), "msg-fail", false);
    for (let i = 0; i < 10 && second.state !== "failed"; i++) {
      await flush();
    }
    expect(second.state).toBe("failed");

    const third = manager.createToolCall(createRequest("call_edit_3", "edit_file", { path: "A" }), "msg-fail", false);
    expect(third.state).toBe("failed");
    expect(third.result?.error?.code).toBe(TOOL_LOOP_ERROR_CODE);
    expect(executions).toBe(2);
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

  test("includes PI canonical aliases for filesystem MCP tools", async () => {
    const manager = createManagerWithMcpTools([
      {
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          description: "Read",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "mcp-filesystem_search",
          description: "Search",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "mcp-filesystem_list_items",
          description: "List",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);

    const tools = await manager.getOpenAITools();
    const names = tools.map((tool) => tool.function.name);

    expect(names).toContain("mcp-filesystem_read");
    expect(names).toContain("mcp-filesystem_search");
    expect(names).toContain("mcp-filesystem_list_items");
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("ls");
  });

  test("routes canonical read alias to mcp-filesystem_read and normalizes args", async () => {
    const { manager, mcpService, chatView } = createManagerWithMcpExecution({
      toolingToolCallTimeoutMs: 0,
    });

    const request = createRequest("call_read_alias", "read", { path: "Notes/A.md" });
    const call = manager.createToolCall(request, "msg-read", manager.shouldAutoApprove(request.function.name));

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
    const { manager, mcpService, chatView } = createManagerWithMcpExecution({
      toolingToolCallTimeoutMs: 0,
    });

    const request = createRequest("call_move_alias", "move", { from: "A.md", to: "B.md" });
    const call = manager.createToolCall(request, "msg-move", manager.shouldAutoApprove(request.function.name));
    expect(call.state).toBe("pending");

    manager.approveToolCall(call.id);
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
