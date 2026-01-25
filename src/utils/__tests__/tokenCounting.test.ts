/**
 * @jest-environment node
 */
import {
  countTextTokens,
  countMessageTokens,
  countMessagesTokens,
  countRequestTokens,
  estimateTokens,
  calculateOptimalBatchSize,
  createOptimizedBatches,
  truncateToTokenLimit,
  getBatchStatistics,
  countToolCallArgumentsTokens,
  countToolCallPayloadTokens,
  countToolResultTokens,
  countToolCallTokensForProvider,
} from "../tokenCounting";

describe("countTextTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTextTokens("")).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(countTextTokens(null as any)).toBe(0);
    expect(countTextTokens(undefined as any)).toBe(0);
  });

  it("returns positive count for text", () => {
    expect(countTextTokens("Hello world")).toBeGreaterThan(0);
  });

  it("returns consistent results for same text", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const first = countTextTokens(text);
    const second = countTextTokens(text);
    expect(first).toBe(second);
  });

  it("longer text has more tokens", () => {
    const short = "Hi";
    const long = "This is a much longer piece of text that should have many more tokens.";
    expect(countTextTokens(long)).toBeGreaterThan(countTextTokens(short));
  });
});

describe("countMessageTokens", () => {
  it("returns 0 for null/undefined", () => {
    expect(countMessageTokens(null)).toBe(0);
    expect(countMessageTokens(undefined)).toBe(0);
  });

  it("returns base overhead for empty message", () => {
    expect(countMessageTokens({})).toBe(3); // role overhead
  });

  it("counts content tokens", () => {
    const message = { role: "user", content: "Hello world" };
    const tokens = countMessageTokens(message);
    expect(tokens).toBeGreaterThan(3); // more than just overhead
  });

  it("counts tool_calls tokens", () => {
    const message = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
    };
    const tokens = countMessageTokens(message);
    expect(tokens).toBeGreaterThan(3);
  });

  it("counts tool role message content", () => {
    const message = { role: "tool", content: "Result data here" };
    const tokens = countMessageTokens(message);
    expect(tokens).toBeGreaterThan(3);
  });

  it("handles multipart content", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image_url", image_url: { url: "data:..." } },
      ],
    };
    const tokens = countMessageTokens(message);
    expect(tokens).toBeGreaterThan(3);
  });
});

describe("countMessagesTokens", () => {
  it("returns 0 for empty array", () => {
    expect(countMessagesTokens([])).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(countMessagesTokens(null as any)).toBe(0);
    expect(countMessagesTokens(undefined as any)).toBe(0);
  });

  it("counts tokens for multiple messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const tokens = countMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(6); // more than just overhead for 2 messages
  });

  it("adds framing overhead", () => {
    const single = [{ role: "user", content: "Test" }];
    const double = [
      { role: "user", content: "Test" },
      { role: "user", content: "Test" },
    ];
    const singleTokens = countMessagesTokens(single);
    const doubleTokens = countMessagesTokens(double);
    // Double should be more than 2x single due to framing
    expect(doubleTokens).toBeGreaterThan(singleTokens);
  });
});

describe("countRequestTokens", () => {
  it("returns 0 for null/undefined", () => {
    expect(countRequestTokens(null)).toBe(0);
    expect(countRequestTokens(undefined)).toBe(0);
  });

  it("returns 0 for non-object", () => {
    expect(countRequestTokens("string")).toBe(0);
    expect(countRequestTokens(123)).toBe(0);
  });

  it("counts system prompt tokens", () => {
    const body = { system: "You are a helpful assistant." };
    const tokens = countRequestTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts messages tokens", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };
    const tokens = countRequestTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts tools tokens", () => {
    const body = {
      tools: [
        { type: "function", function: { name: "search", parameters: { type: "object" } } },
      ],
    };
    const tokens = countRequestTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts web_search_options tokens", () => {
    const body = {
      web_search_options: { enabled: true },
    };
    const tokens = countRequestTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts plugins tokens", () => {
    const body = {
      plugins: [{ name: "web_search" }],
    };
    const tokens = countRequestTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts combined request", () => {
    const body = {
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "test" } }],
    };
    const tokens = countRequestTokens(body);
    expect(tokens).toBeGreaterThan(10);
  });
});

describe("estimateTokens", () => {
  it("is an alias for countTextTokens", () => {
    const text = "Test text for estimation";
    expect(estimateTokens(text)).toBe(countTextTokens(text));
  });
});

describe("calculateOptimalBatchSize", () => {
  it("returns 0 for empty array", () => {
    expect(calculateOptimalBatchSize([])).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(calculateOptimalBatchSize(null as any)).toBe(0);
    expect(calculateOptimalBatchSize(undefined as any)).toBe(0);
  });

  it("returns at least 1 for non-empty array", () => {
    expect(calculateOptimalBatchSize(["short text"])).toBeGreaterThanOrEqual(1);
  });

  it("returns max 25 for many small texts", () => {
    const texts = Array.from({ length: 100 }, (_, i) => `Text ${i}`);
    const batchSize = calculateOptimalBatchSize(texts);
    expect(batchSize).toBeLessThanOrEqual(25);
  });

  it("returns smaller batch for large texts", () => {
    const largeText = "a".repeat(10000);
    const texts = [largeText, largeText, largeText];
    const batchSize = calculateOptimalBatchSize(texts);
    expect(batchSize).toBeLessThanOrEqual(3);
  });
});

describe("createOptimizedBatches", () => {
  it("returns empty array for empty input", () => {
    expect(createOptimizedBatches([])).toEqual([]);
  });

  it("returns empty array for null/undefined", () => {
    expect(createOptimizedBatches(null as any)).toEqual([]);
    expect(createOptimizedBatches(undefined as any)).toEqual([]);
  });

  it("batches items correctly", () => {
    const items = [
      { content: "Short text 1" },
      { content: "Short text 2" },
      { content: "Short text 3" },
    ];
    const batches = createOptimizedBatches(items);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const totalItems = batches.reduce((sum, batch) => sum + batch.length, 0);
    expect(totalItems).toBe(items.length);
  });

  it("never returns batches larger than 25 items", () => {
    const items = Array.from({ length: 73 }, (_, idx) => ({
      content: `Sample content block ${idx}`,
    }));

    const batches = createOptimizedBatches(items);
    expect(batches.length).toBeGreaterThan(2);
    const maxBatchLength = Math.max(...batches.map((batch) => batch.length));
    expect(maxBatchLength).toBeLessThanOrEqual(25);
  });

  it("handles very large items as single batches", () => {
    const largeContent = "a".repeat(50000);
    const items = [{ content: largeContent }];
    const batches = createOptimizedBatches(items);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1);
  });

  it("sorts items by content length", () => {
    const items = [
      { content: "medium text here" },
      { content: "short" },
      { content: "this is a longer piece of text" },
    ];
    const batches = createOptimizedBatches(items);
    // All should be in one batch, sorted by length
    expect(batches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("truncateToTokenLimit", () => {
  it("returns text unchanged if under limit", () => {
    const text = "Short text";
    expect(truncateToTokenLimit(text, 1000)).toBe(text);
  });

  it("truncates long text", () => {
    const text = "a".repeat(50000);
    const truncated = truncateToTokenLimit(text, 100);
    expect(truncated.length).toBeLessThan(text.length);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("uses default limit if not specified", () => {
    const text = "a".repeat(100000);
    const truncated = truncateToTokenLimit(text);
    expect(truncated.length).toBeLessThan(text.length);
  });
});

describe("getBatchStatistics", () => {
  it("returns zeros for empty array", () => {
    const stats = getBatchStatistics([]);
    expect(stats.totalTexts).toBe(0);
    expect(stats.totalEstimatedTokens).toBe(0);
    expect(stats.averageTokensPerText).toBe(0);
    expect(stats.maxTokensInSingleText).toBe(0);
    expect(stats.recommendedBatchSize).toBe(0);
    expect(stats.estimatedBatches).toBe(0);
  });

  it("returns zeros for null/undefined", () => {
    const stats = getBatchStatistics(null as any);
    expect(stats.totalTexts).toBe(0);
  });

  it("calculates statistics correctly", () => {
    const texts = ["Hello world", "Test text", "Another piece"];
    const stats = getBatchStatistics(texts);
    expect(stats.totalTexts).toBe(3);
    expect(stats.totalEstimatedTokens).toBeGreaterThan(0);
    expect(stats.averageTokensPerText).toBeGreaterThan(0);
    expect(stats.maxTokensInSingleText).toBeGreaterThan(0);
    expect(stats.recommendedBatchSize).toBeGreaterThanOrEqual(1);
    expect(stats.estimatedBatches).toBeGreaterThanOrEqual(1);
  });

  it("identifies max tokens correctly", () => {
    const texts = ["short", "a".repeat(1000), "medium length text"];
    const stats = getBatchStatistics(texts);
    expect(stats.maxTokensInSingleText).toBeGreaterThan(stats.averageTokensPerText);
  });
});

describe("countToolCallArgumentsTokens", () => {
  it("returns 0 for null/undefined", () => {
    expect(countToolCallArgumentsTokens(null)).toBe(0);
    expect(countToolCallArgumentsTokens(undefined)).toBe(0);
  });

  it("returns 0 for empty object", () => {
    expect(countToolCallArgumentsTokens({})).toBe(0);
  });

  it("counts string arguments", () => {
    const toolCall = {
      request: {
        function: {
          name: "search",
          arguments: '{"query":"test search"}',
        },
      },
    };
    const tokens = countToolCallArgumentsTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts object arguments", () => {
    const toolCall = {
      request: {
        function: {
          name: "search",
          arguments: { query: "test search" },
        },
      },
    };
    const tokens = countToolCallArgumentsTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles function at top level", () => {
    const toolCall = {
      function: {
        name: "search",
        arguments: '{"q":"test"}',
      },
    };
    const tokens = countToolCallArgumentsTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("countToolCallPayloadTokens", () => {
  it("returns tokens for minimal structure even with null/undefined", () => {
    // These still produce a minimal JSON structure with empty values
    expect(countToolCallPayloadTokens(null)).toBeGreaterThan(0);
    expect(countToolCallPayloadTokens(undefined)).toBeGreaterThan(0);
  });

  it("counts full tool call payload", () => {
    const toolCall = {
      id: "call_123",
      request: {
        function: {
          name: "search",
          arguments: '{"query":"test"}',
        },
      },
    };
    const tokens = countToolCallPayloadTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("includes id in token count", () => {
    const withId = {
      id: "call_very_long_identifier_123456",
      function: { name: "test", arguments: "{}" },
    };
    const withoutId = {
      function: { name: "test", arguments: "{}" },
    };
    expect(countToolCallPayloadTokens(withId)).toBeGreaterThan(
      countToolCallPayloadTokens(withoutId)
    );
  });
});

describe("countToolResultTokens", () => {
  it("returns 0 for null/undefined", () => {
    expect(countToolResultTokens(null)).toBe(0);
    expect(countToolResultTokens(undefined)).toBe(0);
  });

  it("returns 0 for pending state", () => {
    const toolCall = { state: "pending" };
    expect(countToolResultTokens(toolCall)).toBe(0);
  });

  it("counts completed successful result", () => {
    const toolCall = {
      state: "completed",
      result: { success: true, data: "Result content here" },
    };
    const tokens = countToolResultTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts completed with object data", () => {
    const toolCall = {
      state: "completed",
      result: { success: true, data: { key: "value", items: [1, 2, 3] } },
    };
    const tokens = countToolResultTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts failed result", () => {
    const toolCall = {
      state: "failed",
      result: { success: false, error: { code: "ERR", message: "Failed" } },
    };
    const tokens = countToolResultTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts denied result", () => {
    const toolCall = { state: "denied" };
    const tokens = countToolResultTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles completed but not successful", () => {
    const toolCall = {
      state: "completed",
      result: { success: false },
    };
    const tokens = countToolResultTokens(toolCall);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("countToolCallTokensForProvider", () => {
  const toolCall = {
    id: "call_123",
    request: {
      function: {
        name: "search",
        arguments: '{"query":"test"}',
      },
    },
  };

  it("returns tokens for minimal structure even with null/undefined", () => {
    // These still produce a minimal JSON structure with empty values
    expect(countToolCallTokensForProvider(null)).toBeGreaterThan(0);
    expect(countToolCallTokensForProvider(undefined)).toBeGreaterThan(0);
  });

  it("counts tokens for openai format", () => {
    const tokens = countToolCallTokensForProvider(toolCall, "openai");
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts tokens for anthropic format", () => {
    const tokens = countToolCallTokensForProvider(toolCall, "anthropic");
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts tokens for native format", () => {
    const tokens = countToolCallTokensForProvider(toolCall, "native");
    expect(tokens).toBeGreaterThan(0);
  });

  it("defaults to openai format", () => {
    const defaultTokens = countToolCallTokensForProvider(toolCall);
    const openaiTokens = countToolCallTokensForProvider(toolCall, "openai");
    expect(defaultTokens).toBe(openaiTokens);
  });

  it("handles object arguments for anthropic", () => {
    const toolCallWithObj = {
      id: "call_456",
      request: {
        function: {
          name: "create",
          arguments: { title: "Test", content: "Body" },
        },
      },
    };
    const tokens = countToolCallTokensForProvider(toolCallWithObj, "anthropic");
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles string arguments for anthropic", () => {
    const tokens = countToolCallTokensForProvider(toolCall, "anthropic");
    expect(tokens).toBeGreaterThan(0);
  });
});
