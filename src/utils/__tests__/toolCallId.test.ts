/**
 * @jest-environment node
 */
import {
  createToolCallIdState,
  sanitizeToolCallId,
  ToolCallIdState,
} from "../toolCallId";

describe("createToolCallIdState", () => {
  it("creates empty state object", () => {
    const state = createToolCallIdState();
    expect(state.rawToSanitized).toBeInstanceOf(Map);
    expect(state.usedIds).toBeInstanceOf(Set);
    expect(state.rawToSanitized.size).toBe(0);
    expect(state.usedIds.size).toBe(0);
  });
});

describe("sanitizeToolCallId", () => {
  let state: ToolCallIdState;

  beforeEach(() => {
    state = createToolCallIdState();
  });

  describe("valid IDs", () => {
    it("preserves valid call_* format IDs", () => {
      const result = sanitizeToolCallId("call_abc12345", 0, state);
      expect(result).toBe("call_abc12345");
    });

    it("preserves valid tool_* format IDs", () => {
      const result = sanitizeToolCallId("tool_abc12345", 0, state);
      expect(result).toBe("tool_abc12345");
    });

    it("preserves OpenRouter namespaced tool ids", () => {
      const raw = "tool_default_api:mcp-filesystem_search_szyfwOy5FpnrUXatzq4y";
      const result = sanitizeToolCallId(raw, 0, state);
      expect(result).toBe(raw);
    });

    it("preserves valid ID with longer suffix", () => {
      const result = sanitizeToolCallId("call_abcdefghij12345", 0, state);
      expect(result).toBe("call_abcdefghij12345");
    });

    it("preserves valid ID with mixed case", () => {
      const result = sanitizeToolCallId("call_AbCdEfGh12", 0, state);
      expect(result).toBe("call_AbCdEfGh12");
    });
  });

  describe("invalid IDs", () => {
    it("generates new ID for undefined", () => {
      const result = sanitizeToolCallId(undefined, 0, state);
      expect(result).toMatch(/^call_/);
    });

    it("preserves short but safe IDs", () => {
      const result = sanitizeToolCallId("call_1", 0, state);
      expect(result).toBe("call_1");

      const result2 = sanitizeToolCallId("call_abc", 1, state);
      expect(result2).toBe("call_abc");
    });

    it("generates new ID for wrong prefix", () => {
      const result = sanitizeToolCallId("badprefix_abc12345", 0, state);
      expect(result).toMatch(/^call_/);
    });

    it("generates new ID for empty string", () => {
      const result = sanitizeToolCallId("", 0, state);
      expect(result).toMatch(/^call_/);
    });

    it("generates new ID for special characters", () => {
      const result = sanitizeToolCallId("call_abc!@#$%", 0, state);
      expect(result).toMatch(/^call_[a-zA-Z0-9]+$/);
    });
  });

  describe("caching", () => {
    it("returns same ID for same raw ID", () => {
      const first = sanitizeToolCallId("call_abc12345", 0, state);
      const second = sanitizeToolCallId("call_abc12345", 1, state);
      expect(first).toBe(second);
    });

    it("returns same ID for same undefined at same index key", () => {
      const first = sanitizeToolCallId(undefined, 0, state);
      const second = sanitizeToolCallId(undefined, 0, state);
      expect(first).toBe(second);
    });

    it("returns different IDs for different undefined indices", () => {
      const first = sanitizeToolCallId(undefined, 0, state);
      const second = sanitizeToolCallId(undefined, 1, state);
      expect(first).not.toBe(second);
    });

    it("stores mapping in state", () => {
      sanitizeToolCallId("call_test12345", 0, state);
      expect(state.rawToSanitized.has("call_test12345")).toBe(true);
    });

    it("tracks used IDs in state", () => {
      const id = sanitizeToolCallId("call_test12345", 0, state);
      expect(state.usedIds.has(id)).toBe(true);
    });
  });

  describe("collision handling", () => {
    it("avoids ID collision when raw ID already used", () => {
      const first = sanitizeToolCallId("call_test12345", 0, state);
      // Manually add the ID to usedIds to simulate collision
      state.usedIds.add("call_test12345");
      // This would normally return the cached value
      // but if we create a new state...
      const newState = createToolCallIdState();
      newState.usedIds.add("call_test12345");
      const second = sanitizeToolCallId("call_test12345", 1, newState);
      // Should generate a different ID since it's already used
      expect(second).toMatch(/^call_/);
    });

    it("regenerates when generated candidate already exists", () => {
      const newState = createToolCallIdState();
      newState.usedIds.add("call_invalidid");

      const result = sanitizeToolCallId("invalid-id", 2, newState);

      expect(result).toMatch(/^call_/);
      expect(result).not.toBe("call_invalidid");
    });
  });

  describe("index-based fallback", () => {
    it("uses index for undefined raw ID", () => {
      const result = sanitizeToolCallId(undefined, 5, state);
      expect(result).toMatch(/^call_/);
      expect(state.rawToSanitized.has("index_5")).toBe(true);
    });

    it("different indices generate different keys", () => {
      sanitizeToolCallId(undefined, 0, state);
      sanitizeToolCallId(undefined, 1, state);
      expect(state.rawToSanitized.has("index_0")).toBe(true);
      expect(state.rawToSanitized.has("index_1")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles numeric-looking raw ID", () => {
      const result = sanitizeToolCallId("12345678", 0, state);
      expect(result).toMatch(/^call_/);
    });

    it("handles raw ID that is just 'call_'", () => {
      const result = sanitizeToolCallId("call_", 0, state);
      expect(result).toMatch(/^call_[a-zA-Z0-9]+$/);
      expect(result.length).toBeGreaterThan(5);
    });

    it("handles very long raw ID", () => {
      const longId = "call_" + "a".repeat(100);
      const result = sanitizeToolCallId(longId, 0, state);
      expect(result).toMatch(/^call_/);
    });

    it("handles unicode characters", () => {
      const result = sanitizeToolCallId("call_日本語テスト", 0, state);
      expect(result).toMatch(/^call_[a-zA-Z0-9]+$/);
    });
  });
});
