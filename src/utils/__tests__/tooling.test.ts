/**
 * @jest-environment node
 */
import {
  isValidManagedTool,
  normalizeManagedTools,
  mapAssistantToolCallsForManagedApi,
  buildToolResultMessagesFromToolCalls,
  normalizeJsonSchema,
} from "../tooling";

describe("isValidManagedTool", () => {
  it("returns true for valid tool", () => {
    const tool = {
      type: "function",
      function: { name: "search", description: "Search" },
    };
    expect(isValidManagedTool(tool)).toBe(true);
  });

  it("returns false for missing type", () => {
    const tool = { function: { name: "search" } };
    expect(isValidManagedTool(tool)).toBe(false);
  });

  it("returns false for wrong type", () => {
    const tool = { type: "other", function: { name: "search" } };
    expect(isValidManagedTool(tool)).toBe(false);
  });

  it("returns false for missing function", () => {
    const tool = { type: "function" };
    expect(isValidManagedTool(tool)).toBe(false);
  });

  it("returns false for missing function name", () => {
    const tool = { type: "function", function: {} };
    expect(isValidManagedTool(tool)).toBe(false);
  });

  it("returns false for empty function name", () => {
    const tool = { type: "function", function: { name: "" } };
    expect(isValidManagedTool(tool)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isValidManagedTool(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isValidManagedTool(undefined)).toBe(false);
  });
});

describe("normalizeManagedTools", () => {
  it("returns empty array for empty input", () => {
    expect(normalizeManagedTools([])).toEqual([]);
  });

  it("returns empty array for null input", () => {
    expect(normalizeManagedTools(null as any)).toEqual([]);
  });

  it("filters out invalid tools", () => {
    const tools = [
      { type: "function", function: { name: "valid" } },
      { type: "invalid" },
      { type: "function", function: {} },
    ];
    const result = normalizeManagedTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("valid");
  });

  it("removes duplicate tool names", () => {
    const tools = [
      { type: "function", function: { name: "search" } },
      { type: "function", function: { name: "search" } },
    ];
    const result = normalizeManagedTools(tools);
    expect(result).toHaveLength(1);
  });

  it("trims tool names", () => {
    const tools = [{ type: "function", function: { name: "  search  " } }];
    const result = normalizeManagedTools(tools);
    expect(result[0].function.name).toBe("search");
  });

  it("preserves description", () => {
    const tools = [
      { type: "function", function: { name: "search", description: "Search stuff" } },
    ];
    const result = normalizeManagedTools(tools);
    expect(result[0].function.description).toBe("Search stuff");
  });

  it("defaults description to empty string", () => {
    const tools = [{ type: "function", function: { name: "search" } }];
    const result = normalizeManagedTools(tools);
    expect(result[0].function.description).toBe("");
  });

  it("preserves parameters", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ];
    const result = normalizeManagedTools(tools);
    expect(result[0].function.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  it("defaults parameters to empty object", () => {
    const tools = [{ type: "function", function: { name: "search" } }];
    const result = normalizeManagedTools(tools);
    expect(result[0].function.parameters).toEqual({});
  });

  it("drops unsupported strict metadata", () => {
    const tools = [
      { type: "function", function: { name: "search", strict: true } },
    ];
    const result = normalizeManagedTools(tools);
    expect(result[0].function).not.toHaveProperty("strict");
  });
});

describe("mapAssistantToolCallsForManagedApi", () => {
  it("returns empty array for empty input", () => {
    expect(mapAssistantToolCallsForManagedApi([])).toEqual([]);
  });

  it("returns empty array for non-array input", () => {
    expect(mapAssistantToolCallsForManagedApi(null as any)).toEqual([]);
  });

  it("maps tool call with request property", () => {
    const toolCalls = [
      {
        request: {
          id: "call_123",
          function: { name: "search", arguments: { q: "test" } },
        },
      },
    ];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("call_123");
    expect(result[0].function.name).toBe("search");
    expect(result[0].function.arguments).toBe('{"q":"test"}');
  });

  it("maps tool call without request wrapper", () => {
    const toolCalls = [
      { id: "call_456", function: { name: "read", arguments: '{"path":"/"}' } },
    ];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("call_456");
    expect(result[0].function.name).toBe("read");
  });

  it("preserves canonical names for managed transport", () => {
    const result = mapAssistantToolCallsForManagedApi([
      { id: "canonical", function: { name: "search", arguments: "{}" } },
    ]);
    expect(result[0].function.name).toBe("search");
  });

  it("generates deterministic ID when missing", () => {
    const toolCalls = [{ function: { name: "search", arguments: {} } }];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result[0].id).toMatch(/^call_/);
  });

  it("filters out tool calls without name", () => {
    const toolCalls = [
      { function: { arguments: {} } },
      { function: { name: "valid" } },
    ];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("valid");
  });

  it("stringifies object arguments", () => {
    const toolCalls = [
      { function: { name: "test", arguments: { key: "value" } } },
    ];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result[0].function.arguments).toBe('{"key":"value"}');
  });

  it("preserves string arguments", () => {
    const toolCalls = [
      { function: { name: "test", arguments: '{"pre":"stringified"}' } },
    ];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result[0].function.arguments).toBe('{"pre":"stringified"}');
  });

  it("preserves provider metadata fields on tool calls", () => {
    const toolCalls = [
      {
        id: "call_meta",
        thought_signature: "top-sig",
        extra_field: "keep-me",
        function: {
          name: "test",
          arguments: { key: "value" },
          thought_signature: "fn-sig",
        },
      },
    ];
    const result = mapAssistantToolCallsForManagedApi(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].thought_signature).toBe("top-sig");
    expect(result[0].extra_field).toBe("keep-me");
    expect(result[0].function.thought_signature).toBe("fn-sig");
  });
});

describe("buildToolResultMessagesFromToolCalls", () => {
  it("returns empty array for empty input", () => {
    expect(buildToolResultMessagesFromToolCalls([])).toEqual([]);
  });

  it("returns empty array for null input", () => {
    expect(buildToolResultMessagesFromToolCalls(null as any)).toEqual([]);
  });

  it("builds message for completed successful tool call", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "completed",
        result: { success: true, data: "Result data" },
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toBe("call_123");
    expect(result[0].content).toBe("Result data");
  });

  it("provides fallback content when successful tool call returns undefined", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "completed",
        result: { success: true },
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Tool executed successfully");
  });

  it("JSON stringifies object data", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "completed",
        result: { success: true, data: { key: "value" } },
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result[0].content).toBe('{"key":"value"}');
  });

  it("builds error message for failed tool call", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "failed",
        result: { success: false, error: { code: "ERR", message: "Failed" } },
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result[0].content).toContain("ERR");
    expect(result[0].content).toContain("Failed");
  });

  it("skips unsupported legacy tool states", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "denied",
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it("skips pending tool calls", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "pending",
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it("generates message_id for each result", () => {
    const toolCalls = [
      {
        id: "call_123",
        state: "completed",
        result: { success: true, data: "test" },
      },
    ];
    const result = buildToolResultMessagesFromToolCalls(toolCalls);
    expect(result[0].message_id).toMatch(/^tool_/);
  });
});

describe("normalizeJsonSchema", () => {
  it("returns default object schema for null input", () => {
    const result = normalizeJsonSchema(null);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  it("returns default object schema for undefined input", () => {
    const result = normalizeJsonSchema(undefined);
    expect(result.type).toBe("object");
  });

  it("preserves valid object schema", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const result = normalizeJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.properties.name).toEqual({ type: "string" });
    expect(result.required).toContain("name");
  });

  it("converts non-object type to object", () => {
    const schema = { type: "string" };
    const result = normalizeJsonSchema(schema);
    expect(result.type).toBe("object");
  });

  it("handles schema with oneOf", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    };
    const result = normalizeJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.properties.a).toBeDefined();
    expect(result.properties.b).toBeDefined();
  });

  it("handles schema with anyOf", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { x: { type: "boolean" } } },
      ],
    };
    const result = normalizeJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.properties.x).toBeDefined();
  });

  it("handles schema with allOf", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { p1: { type: "string" } }, required: ["p1"] },
        { type: "object", properties: { p2: { type: "number" } }, required: ["p2"] },
      ],
    };
    const result = normalizeJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.properties.p1).toBeDefined();
    expect(result.properties.p2).toBeDefined();
    expect(result.required).toContain("p1");
    expect(result.required).toContain("p2");
  });

  it("preserves description", () => {
    const schema = {
      type: "object",
      description: "My schema",
      properties: {},
    };
    const result = normalizeJsonSchema(schema);
    expect(result.description).toBe("My schema");
  });

  it("preserves title", () => {
    const schema = {
      type: "object",
      title: "MySchema",
      properties: {},
    };
    const result = normalizeJsonSchema(schema);
    expect(result.title).toBe("MySchema");
  });

  it("handles additionalProperties boolean", () => {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    const result = normalizeJsonSchema(schema);
    expect(result.additionalProperties).toBe(false);
  });
});
