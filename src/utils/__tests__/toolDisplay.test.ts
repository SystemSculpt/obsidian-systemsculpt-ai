/** @jest-environment node */
import { getFunctionDataFromToolCall } from "../toolDisplay";

describe("getFunctionDataFromToolCall", () => {
  it("normalizes object and JSON-string arguments", () => {
    expect(getFunctionDataFromToolCall({
      request: { function: { name: "search", arguments: { query: "test" } } },
    } as any)).toEqual({ name: "search", arguments: { query: "test" } });
    expect(getFunctionDataFromToolCall({
      request: { function: { name: "search", arguments: '{"query":"test"}' } },
    } as any)).toEqual({ name: "search", arguments: { query: "test" } });
  });

  it("fails closed to null or an empty argument object", () => {
    expect(getFunctionDataFromToolCall({ request: {} } as any)).toBeNull();
    expect(getFunctionDataFromToolCall({} as any)).toBeNull();
    expect(getFunctionDataFromToolCall({
      request: { function: { name: "search", arguments: "not-json" } },
    } as any)).toEqual({ name: "search", arguments: {} });
  });
});
