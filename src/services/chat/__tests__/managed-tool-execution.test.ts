import {
  isServerExecutedManagedToolCall,
  isServerExecutedManagedToolName,
  readManagedToolCallFunction,
} from "../ManagedToolExecution";

describe("managed server tool ownership", () => {
  it("recognizes only the canonical server-owned tool name", () => {
    expect(isServerExecutedManagedToolName("web_search")).toBe(true);
    expect(isServerExecutedManagedToolName("read")).toBe(false);
    expect(isServerExecutedManagedToolName(null)).toBe(false);
  });

  it("uses the durable marker first and the name as a legacy fallback", () => {
    expect(isServerExecutedManagedToolCall({ executedOn: "server" })).toBe(true);
    expect(isServerExecutedManagedToolCall({
      request: { function: { name: "web_search" } },
    })).toBe(true);
    expect(isServerExecutedManagedToolCall({ name: "web_search" })).toBe(true);
    expect(isServerExecutedManagedToolCall({
      function: { name: "web_search" },
    })).toBe(true);
    expect(isServerExecutedManagedToolCall({
      request: { function: { name: "read" } },
    })).toBe(false);
    expect(isServerExecutedManagedToolCall({ request: {} })).toBe(false);
  });

  it("normalizes current, older nested, and oldest flat persisted functions", () => {
    expect(readManagedToolCallFunction({
      request: {
        function: {
          name: " read ",
          arguments: "{\"path\":\"Current.md\"}",
        },
      },
    })).toEqual({
      name: "read",
      arguments: "{\"path\":\"Current.md\"}",
    });
    expect(readManagedToolCallFunction({
      function: {
        name: "search",
        arguments: { query: "older" },
      },
    })).toEqual({
      name: "search",
      arguments: "{\"query\":\"older\"}",
    });
    expect(readManagedToolCallFunction({
      name: "web_search",
      arguments: { query: "oldest" },
    })).toEqual({
      name: "web_search",
      arguments: "{\"query\":\"oldest\"}",
    });
  });

  it("fails closed when legacy arguments are missing or not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(readManagedToolCallFunction({ name: "read" })).toBeNull();
    expect(readManagedToolCallFunction({ name: "read", arguments: () => undefined })).toBeNull();
    expect(readManagedToolCallFunction({ name: "read", arguments: circular })).toBeNull();
  });

  it.each([
    null,
    undefined,
    "web_search",
    [],
    1,
    {},
    { name: "" },
    { name: 1 },
    { request: { function: { name: " " } } },
  ])("does not invent a function for malformed persisted value %p", (value) => {
    expect(readManagedToolCallFunction(value)).toBeNull();
  });

  it.each([null, undefined, "web_search", [], 1])(
    "rejects malformed persisted call value %p",
    (value) => {
      expect(isServerExecutedManagedToolCall(value)).toBe(false);
    },
  );
});
