/**
 * @jest-environment node
 */

// Mock TFile before importing
jest.mock("obsidian", () => ({
  TFile: jest.fn().mockImplementation(() => ({})),
}));

import type {
  ToolCallState,
  ToolCallRequest,
  ToolCallResult,
  ToolCall,
  ToolCallEvents,
  ToolDefinition,
  SerializedToolCall,
  ToolResultMessage,
  ToolExecutionOptions,
  ToolExecutor,
  LocalTool,
  ToolRegistryEntry,
} from "../../types/toolCalls";

describe("ToolCallState type", () => {
  it("can be pending", () => {
    const state: ToolCallState = "pending";
    expect(state).toBe("pending");
  });

  it("can be approved", () => {
    const state: ToolCallState = "approved";
    expect(state).toBe("approved");
  });

  it("can be denied", () => {
    const state: ToolCallState = "denied";
    expect(state).toBe("denied");
  });

  it("can be executing", () => {
    const state: ToolCallState = "executing";
    expect(state).toBe("executing");
  });

  it("can be completed", () => {
    const state: ToolCallState = "completed";
    expect(state).toBe("completed");
  });

  it("can be failed", () => {
    const state: ToolCallState = "failed";
    expect(state).toBe("failed");
  });
});

describe("ToolCallRequest type", () => {
  it("can create a basic request", () => {
    const request: ToolCallRequest = {
      id: "call_123",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"location": "NYC"}',
      },
    };

    expect(request.id).toBe("call_123");
    expect(request.type).toBe("function");
    expect(request.function.name).toBe("get_weather");
    expect(request.function.arguments).toBe('{"location": "NYC"}');
  });

  it("function type is always 'function'", () => {
    const request: ToolCallRequest = {
      id: "test",
      type: "function",
      function: { name: "test", arguments: "{}" },
    };
    expect(request.type).toBe("function");
  });
});

describe("ToolCallResult type", () => {
  it("can create a successful result", () => {
    const result: ToolCallResult = {
      success: true,
      data: { temperature: 72, unit: "F" },
    };

    expect(result.success).toBe(true);
    expect(result.data.temperature).toBe(72);
    expect(result.error).toBeUndefined();
  });

  it("can create a failed result", () => {
    const result: ToolCallResult = {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Location not found",
        details: { searchedLocation: "Unknown City" },
      },
    };

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.error?.message).toBe("Location not found");
    expect(result.error?.details).toBeDefined();
  });

  it("can have minimal error info", () => {
    const result: ToolCallResult = {
      success: false,
      error: {
        code: "ERROR",
        message: "Something went wrong",
      },
    };

    expect(result.error?.details).toBeUndefined();
  });
});

describe("ToolCall type", () => {
  it("can create a pending tool call", () => {
    const toolCall: ToolCall = {
      id: "tc_123",
      messageId: "msg_456",
      request: {
        id: "call_123",
        type: "function",
        function: { name: "test", arguments: "{}" },
      },
      state: "pending",
      timestamp: Date.now(),
    };

    expect(toolCall.id).toBe("tc_123");
    expect(toolCall.state).toBe("pending");
    expect(toolCall.approvedAt).toBeUndefined();
  });

  it("can create a completed tool call with result", () => {
    const now = Date.now();
    const toolCall: ToolCall = {
      id: "tc_123",
      messageId: "msg_456",
      request: {
        id: "call_123",
        type: "function",
        function: { name: "test", arguments: "{}" },
      },
      state: "completed",
      timestamp: now - 1000,
      approvedAt: now - 500,
      executionStartedAt: now - 400,
      executionCompletedAt: now,
      result: { success: true, data: "Result" },
      autoApproved: true,
      serverId: "mcp-server-1",
    };

    expect(toolCall.state).toBe("completed");
    expect(toolCall.result?.success).toBe(true);
    expect(toolCall.autoApproved).toBe(true);
    expect(toolCall.serverId).toBe("mcp-server-1");
  });
});

describe("ToolCallEvents type", () => {
  it("defines tool-call:created event structure", () => {
    const toolCall: ToolCall = {
      id: "tc_1",
      messageId: "msg_1",
      request: { id: "c_1", type: "function", function: { name: "test", arguments: "{}" } },
      state: "pending",
      timestamp: Date.now(),
    };

    const event: ToolCallEvents["tool-call:created"] = { toolCall };
    expect(event.toolCall.id).toBe("tc_1");
  });

  it("defines tool-call:state-changed event structure", () => {
    const toolCall: ToolCall = {
      id: "tc_1",
      messageId: "msg_1",
      request: { id: "c_1", type: "function", function: { name: "test", arguments: "{}" } },
      state: "approved",
      timestamp: Date.now(),
    };

    const event: ToolCallEvents["tool-call:state-changed"] = {
      toolCallId: "tc_1",
      previousState: "pending",
      newState: "approved",
      toolCall,
    };

    expect(event.previousState).toBe("pending");
    expect(event.newState).toBe("approved");
  });

  it("defines tool-call:execution-completed event structure", () => {
    const toolCall: ToolCall = {
      id: "tc_1",
      messageId: "msg_1",
      request: { id: "c_1", type: "function", function: { name: "test", arguments: "{}" } },
      state: "completed",
      timestamp: Date.now(),
    };

    const event: ToolCallEvents["tool-call:execution-completed"] = {
      toolCallId: "tc_1",
      result: { success: true, data: "done" },
      toolCall,
    };

    expect(event.result.success).toBe(true);
  });
});

describe("ToolDefinition type", () => {
  it("can create a basic tool definition", () => {
    const def: ToolDefinition = {
      name: "get_weather",
      description: "Gets the weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "The city name" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["location"],
      },
    };

    expect(def.name).toBe("get_weather");
    expect(def.parameters.type).toBe("object");
    expect(def.parameters.required).toContain("location");
  });

  it("can have optional metadata", () => {
    const def: ToolDefinition = {
      name: "file_read",
      description: "Reads a file",
      parameters: { type: "object", properties: {} },
      serverId: "mcp-server",
      autoApprove: true,
    };

    expect(def.serverId).toBe("mcp-server");
    expect(def.autoApprove).toBe(true);
  });
});

describe("SerializedToolCall type", () => {
  it("can create a serialized tool call", () => {
    const serialized: SerializedToolCall = {
      id: "tc_123",
      request: {
        id: "call_123",
        type: "function",
        function: { name: "test", arguments: "{}" },
      },
      state: "completed",
      timestamp: Date.now(),
      approvedAt: Date.now(),
      executionStartedAt: Date.now(),
      executionCompletedAt: Date.now(),
      result: { success: true, data: "result" },
      autoApproved: false,
    };

    expect(serialized.id).toBe("tc_123");
    expect(serialized.state).toBe("completed");
  });

  it("can have minimal fields", () => {
    const serialized: SerializedToolCall = {
      id: "tc_1",
      request: {
        id: "c_1",
        type: "function",
        function: { name: "t", arguments: "{}" },
      },
      state: "pending",
      timestamp: 0,
    };

    expect(serialized.approvedAt).toBeUndefined();
    expect(serialized.result).toBeUndefined();
  });
});

describe("ToolResultMessage type", () => {
  it("can create a tool result message", () => {
    const message: ToolResultMessage = {
      role: "tool",
      tool_call_id: "call_123",
      content: '{"result": "success"}',
      message_id: "msg_456",
    };

    expect(message.role).toBe("tool");
    expect(message.tool_call_id).toBe("call_123");
    expect(message.content).toContain("success");
  });
});

describe("ToolExecutionOptions type", () => {
  it("can create options with timeout", () => {
    const options: ToolExecutionOptions = {
      timeout: 30000,
    };

    expect(options.timeout).toBe(30000);
  });

  it("can create options with retries", () => {
    const options: ToolExecutionOptions = {
      retries: 3,
    };

    expect(options.retries).toBe(3);
  });

  it("can create options with AbortSignal", () => {
    const controller = new AbortController();
    const options: ToolExecutionOptions = {
      signal: controller.signal,
    };

    expect(options.signal).toBeDefined();
  });

  it("can have all options", () => {
    const controller = new AbortController();
    const options: ToolExecutionOptions = {
      timeout: 5000,
      retries: 2,
      signal: controller.signal,
    };

    expect(options.timeout).toBe(5000);
    expect(options.retries).toBe(2);
    expect(options.signal).toBeDefined();
  });
});

describe("ToolExecutor type", () => {
  it("can create an executor function", async () => {
    const executor: ToolExecutor = async (args, options) => {
      return { result: args.input };
    };

    const result = await executor({ input: "test" });
    expect(result.result).toBe("test");
  });

  it("can accept options in executor", async () => {
    const executor: ToolExecutor = async (args, options) => {
      return { timeout: options?.timeout };
    };

    const result = await executor({}, { timeout: 1000 });
    expect(result.timeout).toBe(1000);
  });
});

describe("LocalTool type", () => {
  it("can create a local tool", () => {
    const tool: LocalTool = {
      definition: {
        name: "local_tool",
        description: "A local tool",
        parameters: { type: "object", properties: {} },
      },
      executor: async () => ({}),
    };

    expect(tool.definition.name).toBe("local_tool");
    expect(typeof tool.executor).toBe("function");
  });
});

describe("ToolRegistryEntry type", () => {
  it("can create a registry entry", () => {
    const entry: ToolRegistryEntry = {
      definition: {
        name: "registered_tool",
        description: "A registered tool",
        parameters: { type: "object", properties: {} },
      },
      executor: async () => ({ status: "ok" }),
    };

    expect(entry.definition.name).toBe("registered_tool");
    expect(typeof entry.executor).toBe("function");
  });
});
