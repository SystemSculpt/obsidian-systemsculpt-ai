import { ToolCallManager } from "../ToolCallManager";
import type { ToolCallRequest } from "../../../types/toolCalls";

const createManager = (settings: Record<string, unknown> = {}) => {
  const baseSettings = {
    mcpServers: [
      {
        id: "mcp-filesystem",
        name: "Filesystem",
        transport: "internal",
        isEnabled: true,
      },
      {
        id: "mcp-shell",
        name: "Shell",
        transport: "http",
        endpoint: "http://example.invalid",
        isEnabled: true,
      },
    ],
  };

  const chatView = {
    agentMode: true,
    trustedToolNames: new Set<string>(),
    plugin: {
      settings: { ...baseSettings, ...settings },
    },
  } as any;

  const manager = new ToolCallManager({} as any, chatView);
  return manager;
};

describe("ToolCallManager auto-approval policy", () => {
  const createRequest = (name: string): ToolCallRequest => ({
    id: `${name}-id`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify({}),
    },
  });

  test("read-only filesystem tools are auto-approved", () => {
    const manager = createManager();

    // Read-only tools - auto-approved
    expect(manager.shouldAutoApprove("mcp-filesystem_search")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-filesystem_read")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-filesystem_find")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-filesystem_list_items")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-filesystem_context")).toBe(true);
  });

  test("destructive filesystem tools require approval", () => {
    const manager = createManager();

    // Destructive tools - require approval (return false)
    expect(manager.shouldAutoApprove("mcp-filesystem_write")).toBe(false);
    expect(manager.shouldAutoApprove("mcp-filesystem_edit")).toBe(false);
    expect(manager.shouldAutoApprove("mcp-filesystem_move")).toBe(false);
    expect(manager.shouldAutoApprove("mcp-filesystem_trash")).toBe(false);
  });

  test("destructive filesystem tools can auto-approve when confirmations are disabled", () => {
    const manager = createManager({ toolingRequireApprovalForDestructiveTools: false });

    expect(manager.shouldAutoApprove("mcp-filesystem_write")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-filesystem_edit")).toBe(true);
  });

  test("allowlisted mutating tools auto-approve", () => {
    const manager = createManager({ mcpAutoAcceptTools: ["mcp-filesystem:write"] });

    expect(manager.shouldAutoApprove("mcp-filesystem_write")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-filesystem_edit")).toBe(false);
  });

  test("external MCP server tools require approval", () => {
    const manager = createManager();

    // External MCP server tools - require approval
    expect(manager.shouldAutoApprove("mcp-shell_run_command")).toBe(false);
    expect(manager.shouldAutoApprove("mcp-shell_execute")).toBe(false);
    expect(manager.shouldAutoApprove("mcp-custom_anything")).toBe(false);
  });

  test("youtube tools are auto-approved (read-only)", () => {
    const manager = createManager();

    // YouTube is read-only, auto-approved
    expect(manager.shouldAutoApprove("mcp-youtube_transcript")).toBe(true);
    expect(manager.shouldAutoApprove("mcp-youtube_metadata")).toBe(true);
  });

  test("destructive tool calls start in pending state", () => {
    const manager = createManager();
    const request = createRequest("mcp-filesystem_write");

    const toolCall = manager.createToolCall(request, "message-1", manager.shouldAutoApprove(request.function.name));

    // Should be pending, waiting for user approval
    expect(toolCall.state).toBe("pending");
    expect(toolCall.autoApproved).toBe(false);
  });

  test("read-only tool calls execute immediately", () => {
    const manager = createManager();
    const request = createRequest("mcp-filesystem_read");

    const toolCall = manager.createToolCall(request, "message-1", manager.shouldAutoApprove(request.function.name));

    // Should go straight to executing
    expect(toolCall.state).toBe("executing");
    expect(toolCall.autoApproved).toBe(true);
  });

  test("fails tools when custom server is explicitly disabled", () => {
    const manager = createManager({
      mcpServers: [{ id: "mcp-custom", name: "Custom", transport: "http", isEnabled: false }]
    });
    const request = createRequest("mcp-custom_write");

    const toolCall = manager.createToolCall(request, "message-2", true);

    expect(toolCall.state).toBe("failed");
    expect(toolCall.result?.error?.code).toBe("MCP_SERVER_DISABLED");
  });

  test("custom server tools work when server is enabled", () => {
    const manager = createManager({
      mcpServers: [{ id: "mcp-custom", name: "Custom", transport: "http", isEnabled: true }]
    });
    const request = createRequest("mcp-custom_search");

    const toolCall = manager.createToolCall(request, "message-3", true);

    expect(toolCall.state).not.toBe("failed");
  });

  test("internal servers (filesystem, youtube) are always available", () => {
    const manager = createManager({});
    const request = createRequest("mcp-filesystem_write");

    const toolCall = manager.createToolCall(request, "message-4", true);

    expect(toolCall.state).toBe("executing");
    expect(toolCall.autoApproved).toBe(true);
  });
});
