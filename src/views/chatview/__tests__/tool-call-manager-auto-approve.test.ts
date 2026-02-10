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
    plugin: {
      settings: { ...baseSettings, ...settings },
    },
  } as any;

  const manager = new ToolCallManager({} as any, chatView);
  return manager;
};

describe("ToolCallManager PI-managed execution lifecycle", () => {
  const createRequest = (name: string): ToolCallRequest => ({
    id: `${name}-id`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify({}),
    },
  });

  test("tool calls enter execution immediately without local approval", () => {
    const manager = createManager();
    const request = createRequest("mcp-filesystem_write");

    const toolCall = manager.createToolCall(request, "message-1");

    expect(toolCall.state === "executing" || toolCall.state === "failed").toBe(true);
  });

  test("canonical aliases also execute immediately", () => {
    const manager = createManager();
    const request = createRequest("write");

    const toolCall = manager.createToolCall(request, "message-1");

    expect(toolCall.state === "executing" || toolCall.state === "failed").toBe(true);
  });

  test("fails tools when custom server is explicitly disabled", () => {
    const manager = createManager({
      mcpServers: [{ id: "mcp-custom", name: "Custom", transport: "http", isEnabled: false }],
    });
    const request = createRequest("mcp-custom_write");

    const toolCall = manager.createToolCall(request, "message-2");

    expect(toolCall.state).toBe("failed");
    expect(toolCall.result?.error?.code).toBe("MCP_SERVER_DISABLED");
  });

  test("custom server tools are available when server is enabled", () => {
    const manager = createManager({
      mcpServers: [{ id: "mcp-custom", name: "Custom", transport: "http", isEnabled: true }],
    });
    const request = createRequest("mcp-custom_search");

    const toolCall = manager.createToolCall(request, "message-3");

    expect(toolCall.state).not.toBe("failed");
  });

  test("internal servers (filesystem, youtube) are always available", () => {
    const manager = createManager({});
    const request = createRequest("mcp-filesystem_write");

    const toolCall = manager.createToolCall(request, "message-4");

    expect(toolCall.state).not.toBe("failed");
  });
});
