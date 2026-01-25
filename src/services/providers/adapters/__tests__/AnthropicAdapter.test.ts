import { AnthropicAdapter } from "../AnthropicAdapter";
import type { CustomProvider } from "../../../../types/llm";
import type { ChatMessage } from "../../../../types";
import { ANTHROPIC_MODELS, ANTHROPIC_API_VERSION } from "../../../../constants/anthropic";

// Mock error logger
jest.mock("../../../../utils/errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  },
}));

// Mock tooling utilities
jest.mock("../../../../utils/tooling", () => ({
  normalizeOpenAITools: jest.fn((tools: any[]) => tools.filter((t: any) => t?.function?.name)),
  normalizeJsonSchema: jest.fn((schema: any) => schema || { type: "object", properties: {} }),
}));

// Mock anthropic constants
jest.mock("../../../../constants/anthropic", () => ({
  ANTHROPIC_MODELS: [
    {
      id: "claude-3-opus-20240229",
      name: "Claude 3 Opus",
      contextWindow: 200000,
      maxOutput: 4096,
      capabilities: ["vision"],
      supportsStreaming: true,
      supportsTools: true,
      aliases: ["claude-3-opus"],
    },
    {
      id: "claude-3-sonnet-20240229",
      name: "Claude 3 Sonnet",
      contextWindow: 200000,
      maxOutput: 4096,
      capabilities: [],
      supportsStreaming: true,
      supportsTools: true,
      aliases: [],
    },
    {
      id: "claude-3-haiku-20240307",
      name: "Claude 3 Haiku",
      contextWindow: 200000,
      maxOutput: 4096,
      capabilities: [],
      supportsStreaming: true,
      supportsTools: true,
      aliases: ["claude-3-haiku"],
    },
  ],
  ANTHROPIC_API_VERSION: "2023-06-01",
  ANTHROPIC_STREAM_EVENTS: {
    MESSAGE_START: "message_start",
    CONTENT_BLOCK_START: "content_block_start",
    CONTENT_BLOCK_DELTA: "content_block_delta",
    CONTENT_BLOCK_STOP: "content_block_stop",
    MESSAGE_DELTA: "message_delta",
    MESSAGE_STOP: "message_stop",
  },
  correctAnthropicEndpoint: jest.fn((endpoint: string) => {
    // Simulate endpoint correction logic
    const needsCorrection = endpoint.includes("api.anthropic.com") && !endpoint.includes("/v1");
    return {
      correctedEndpoint: needsCorrection ? endpoint.replace("api.anthropic.com", "api.anthropic.com") : endpoint,
      wasCorrected: false,
      originalEndpoint: endpoint,
    };
  }),
  resolveAnthropicModelId: jest.fn((modelId: string) => {
    // Handle aliases
    if (modelId === "claude-3-opus") return "claude-3-opus-20240229";
    if (modelId === "claude-3-haiku") return "claude-3-haiku-20240307";
    return modelId;
  }),
}));

const baseProvider: CustomProvider = {
  id: "anthropic",
  name: "Anthropic",
  endpoint: "https://api.anthropic.com",
  apiKey: "test-anthropic-key",
  isEnabled: true,
};

describe("AnthropicAdapter", () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AnthropicAdapter(baseProvider);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates instance with provider", () => {
      expect(adapter).toBeDefined();
    });

    it("accepts optional plugin parameter", () => {
      const mockPlugin = { getSettingsManager: jest.fn() } as any;
      const adapterWithPlugin = new AnthropicAdapter(baseProvider, mockPlugin);
      expect(adapterWithPlugin).toBeDefined();
    });
  });

  describe("getCapabilities", () => {
    it("returns correct capabilities", () => {
      const capabilities = adapter.getCapabilities();

      expect(capabilities.supportsModelsEndpoint).toBe(false);
      expect(capabilities.supportsStreaming).toBe(true);
      expect(capabilities.supportsTools).toBe(true);
      expect(capabilities.requiresApiVersion).toBe("2023-06-01");
    });
  });

  describe("getModels", () => {
    it("returns hardcoded ANTHROPIC_MODELS list", async () => {
      const models = await adapter.getModels();

      expect(models.length).toBe(3);
      expect(models[0].id).toBe("claude-3-opus-20240229");
      expect(models[0].name).toBe("Claude 3 Opus");
      expect(models[0].contextWindow).toBe(200000);
    });

    it("includes model capabilities", async () => {
      const models = await adapter.getModels();
      const opusModel = models.find((m) => m.id === "claude-3-opus-20240229");

      expect(opusModel?.capabilities).toContain("vision");
      expect(opusModel?.supportsStreaming).toBe(true);
      expect(opusModel?.supportsTools).toBe(true);
    });

    it("includes model aliases", async () => {
      const models = await adapter.getModels();
      const opusModel = models.find((m) => m.id === "claude-3-opus-20240229");

      expect(opusModel?.aliases).toContain("claude-3-opus");
    });
  });

  describe("getHeaders", () => {
    it("returns required Anthropic headers", () => {
      const headers = adapter.getHeaders();

      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["x-api-key"]).toBe("test-anthropic-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("uses provider apiKey", () => {
      const customProvider = { ...baseProvider, apiKey: "custom-key-123" };
      const customAdapter = new AnthropicAdapter(customProvider);

      const headers = customAdapter.getHeaders();
      expect(headers["x-api-key"]).toBe("custom-key-123");
    });
  });

  describe("getChatEndpoint", () => {
    it("returns correct messages endpoint", () => {
      const endpoint = adapter.getChatEndpoint();
      expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
    });

    it("handles endpoint with trailing slash", () => {
      const provider = { ...baseProvider, endpoint: "https://api.anthropic.com/" };
      const customAdapter = new AnthropicAdapter(provider);

      const endpoint = customAdapter.getChatEndpoint();
      expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
    });

    it("removes /v1 suffix before adding path", () => {
      const provider = { ...baseProvider, endpoint: "https://api.anthropic.com/v1" };
      const customAdapter = new AnthropicAdapter(provider);

      const endpoint = customAdapter.getChatEndpoint();
      expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
    });

    it("handles /v1/ with trailing slash", () => {
      const provider = { ...baseProvider, endpoint: "https://api.anthropic.com/v1/" };
      const customAdapter = new AnthropicAdapter(provider);

      const endpoint = customAdapter.getChatEndpoint();
      expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
    });
  });

  describe("transformMessages", () => {
    it("extracts system message as separate systemPrompt", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.systemPrompt).toBe("You are a helpful assistant.");
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("transforms user messages correctly", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello, Claude!" }];

      const result = adapter.transformMessages(messages);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toEqual([{ type: "text", text: "Hello, Claude!" }]);
    });

    it("transforms assistant messages correctly", () => {
      const messages: ChatMessage[] = [{ role: "assistant", content: "Hello! How can I help?" }];

      const result = adapter.transformMessages(messages);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("assistant");
      expect(result.messages[0].content).toEqual([{ type: "text", text: "Hello! How can I help?" }]);
    });

    it("handles empty content as empty string", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "" }];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content).toBe("");
    });

    it("converts tool messages to tool_result format", () => {
      const messages: ChatMessage[] = [
        {
          role: "tool",
          content: '{"result": "success"}',
          tool_call_id: "call_123",
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content[0].type).toBe("tool_result");
      expect(result.messages[0].content[0].tool_use_id).toBe("call_123");
      expect(result.messages[0].content[0].content).toBe('{"result": "success"}');
    });

    it("provides default content for empty tool responses", () => {
      const messages: ChatMessage[] = [
        {
          role: "tool",
          content: "",
          tool_call_id: "call_456",
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content[0].content).toContain("Tool executed successfully");
    });

    it("marks tool result as error when content contains error", () => {
      const messages: ChatMessage[] = [
        {
          role: "tool",
          content: '{"error": "Something went wrong"}',
          tool_call_id: "call_789",
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content[0].is_error).toBe(true);
    });

    it("converts assistant tool_calls to tool_use format", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Let me check that for you.",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location": "NYC"}',
              },
            },
          ],
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("assistant");
      expect(result.messages[0].content.length).toBe(2);
      expect(result.messages[0].content[0].type).toBe("text");
      expect(result.messages[0].content[1].type).toBe("tool_use");
      expect(result.messages[0].content[1].name).toBe("get_weather");
      expect(result.messages[0].content[1].input).toEqual({ location: "NYC" });
    });

    it("handles tool_calls with object arguments", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_def",
              type: "function",
              function: {
                name: "search",
                arguments: { query: "test" },
              },
            },
          ],
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content[0].input).toEqual({ query: "test" });
    });

    it("handles multipart content with text and images", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          ],
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content.length).toBe(2);
      expect(result.messages[0].content[0].type).toBe("text");
      expect(result.messages[0].content[1].type).toBe("image");
      expect(result.messages[0].content[1].source.type).toBe("base64");
      expect(result.messages[0].content[1].source.media_type).toBe("image/png");
      expect(result.messages[0].content[1].source.data).toBe("abc123");
    });

    it("handles regular image URLs", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/image.png" } },
          ],
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content[0].type).toBe("image");
      expect(result.messages[0].content[0].source.type).toBe("url");
      expect(result.messages[0].content[0].source.url).toBe("https://example.com/image.png");
    });

    it("handles array content on tool messages", () => {
      const messages: ChatMessage[] = [
        {
          role: "tool",
          content: [{ type: "text", text: "array content" }] as any,
          tool_call_id: "call_arr",
        },
      ];

      const result = adapter.transformMessages(messages);

      expect(result.messages[0].content[0].content).toBe('[{"type":"text","text":"array content"}]');
    });
  });

  describe("buildRequestBody", () => {
    it("builds basic request body with model and messages", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const body = adapter.buildRequestBody(messages, "claude-3-opus-20240229");

      expect(body.model).toBe("claude-3-opus-20240229");
      expect(body.messages).toBeDefined();
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(4096);
    });

    it("resolves model aliases to canonical IDs", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const body = adapter.buildRequestBody(messages, "claude-3-opus");

      expect(body.model).toBe("claude-3-opus-20240229");
    });

    it("includes system prompt when present", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ];

      const body = adapter.buildRequestBody(messages, "claude-3-haiku-20240307");

      expect(body.system).toBe("Be helpful");
    });

    it("omits system field when no system prompt", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const body = adapter.buildRequestBody(messages, "claude-3-haiku-20240307");

      expect(body.system).toBeUndefined();
    });

    it("respects streaming parameter", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const bodyStreaming = adapter.buildRequestBody(messages, "claude-3-haiku-20240307", undefined, true);
      const bodyNonStreaming = adapter.buildRequestBody(messages, "claude-3-haiku-20240307", undefined, false);

      expect(bodyStreaming.stream).toBe(true);
      expect(bodyNonStreaming.stream).toBe(false);
    });

    it("uses custom maxTokens from extras", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const body = adapter.buildRequestBody(messages, "claude-3-haiku-20240307", undefined, true, {
        maxTokens: 8192,
      });

      expect(body.max_tokens).toBe(8192);
    });

    it("ensures max_tokens is at least 1", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const body = adapter.buildRequestBody(messages, "claude-3-haiku-20240307", undefined, true, {
        maxTokens: 0,
      });

      expect(body.max_tokens).toBe(1);
    });

    it("includes tools when provided", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "What's the weather?" }];
      const tools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a location",
            parameters: { type: "object", properties: { location: { type: "string" } } },
          },
        },
      ];

      const body = adapter.buildRequestBody(messages, "claude-3-haiku-20240307", tools);

      expect(body.tools).toBeDefined();
      expect(body.tool_choice).toEqual({ type: "auto" });
    });

    it("skips empty tools array", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];

      const body = adapter.buildRequestBody(messages, "claude-3-haiku-20240307", []);

      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });
  });

  describe("handleError", () => {
    it("handles 401 authentication error", () => {
      const error = { status: 401, data: {} };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Invalid Anthropic API key");
    });

    it("handles 400 credit error", () => {
      const error = {
        status: 400,
        data: { error: { message: "Insufficient credit balance" } },
      };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Insufficient credits");
    });

    it("handles 400 generic error", () => {
      const error = {
        status: 400,
        data: { error: { message: "Invalid model" } },
      };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Invalid model");
    });

    it("handles 429 rate limit error", () => {
      const error = { status: 429, data: {} };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Rate limit exceeded");
    });

    it("handles 404 model not found", () => {
      const error = { status: 404, data: { error: { message: "Model not found" } } };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Model not found");
    });

    it("handles 500 server error", () => {
      const error = { status: 500, data: {} };
      const result = adapter.handleError(error);

      expect(result.message).toContain("temporarily unavailable");
    });

    it("handles 502 gateway error", () => {
      const error = { status: 502, data: {} };
      const result = adapter.handleError(error);

      expect(result.message).toContain("temporarily unavailable");
    });

    it("handles 503 service unavailable", () => {
      const error = { status: 503, data: {} };
      const result = adapter.handleError(error);

      expect(result.message).toContain("temporarily unavailable");
    });

    it("handles network errors", () => {
      const error = { message: "Failed to fetch" };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Network error");
    });

    it("handles unknown errors with default message", () => {
      const error = { status: 418, data: {} };
      const result = adapter.handleError(error);

      expect(result.message).toContain("418");
    });

    it("extracts error message from data", () => {
      const error = {
        status: 422,
        data: { error: { message: "Custom API error message" } },
      };
      const result = adapter.handleError(error);

      expect(result.message).toContain("Custom API error message");
    });
  });

  describe("validateApiKey", () => {
    it("makes request to validate key", async () => {
      const makeRequestSpy = jest.spyOn(adapter as any, "makeRequest").mockResolvedValue({});

      await adapter.validateApiKey();

      expect(makeRequestSpy).toHaveBeenCalledWith(
        expect.stringContaining("/v1/messages"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("claude-3-haiku"),
        })
      );
    });

    it("throws handled error on failure", async () => {
      jest.spyOn(adapter as any, "makeRequest").mockRejectedValue({ status: 401 });

      await expect(adapter.validateApiKey()).rejects.toThrow("Invalid Anthropic API key");
    });
  });

  describe("transformStreamResponse", () => {
    it("passes through OpenAI-style SSE responses", async () => {
      const mockBody = new ReadableStream();
      const response = new Response(mockBody, {
        headers: {
          "content-type": "text/event-stream",
          "x-provider-format": "openai-sse",
        },
      });

      const result = await adapter.transformStreamResponse(response, false);

      expect(result.stream).toBe(mockBody);
      expect(result.headers["X-Provider-Format"]).toBe("openai-sse");
    });

    it("transforms JSON response to SSE format", async () => {
      const jsonResponse = {
        id: "msg_123",
        model: "claude-3-opus-20240229",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
      };
      const response = new Response(JSON.stringify(jsonResponse), {
        headers: { "content-type": "application/json" },
      });

      const result = await adapter.transformStreamResponse(response, false);

      expect(result.headers["Content-Type"]).toBe("text/event-stream");

      // Read the stream to verify transformation
      const reader = result.stream.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const fullOutput = chunks.join("");

      expect(fullOutput).toContain("data:");
      expect(fullOutput).toContain("Hello!");
      expect(fullOutput).toContain("[DONE]");
    });

    it("handles JSON response with tool use", async () => {
      const jsonResponse = {
        id: "msg_456",
        model: "claude-3-opus-20240229",
        content: [
          { type: "tool_use", id: "tool_1", name: "get_weather", input: { location: "NYC" } },
        ],
        stop_reason: "tool_use",
      };
      const response = new Response(JSON.stringify(jsonResponse), {
        headers: { "content-type": "application/json" },
      });

      const result = await adapter.transformStreamResponse(response, false);

      const reader = result.stream.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const fullOutput = chunks.join("");

      expect(fullOutput).toContain("tool_calls");
      expect(fullOutput).toContain("get_weather");
    });

    it("handles max_tokens stop reason", async () => {
      const jsonResponse = {
        id: "msg_789",
        model: "claude-3-opus-20240229",
        content: [{ type: "text", text: "Truncated..." }],
        stop_reason: "max_tokens",
      };
      const response = new Response(JSON.stringify(jsonResponse), {
        headers: { "content-type": "application/json" },
      });

      const result = await adapter.transformStreamResponse(response, false);

      const reader = result.stream.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const fullOutput = chunks.join("");

      expect(fullOutput).toContain('"finish_reason":"length"');
    });

    it("returns empty stream when no body available", async () => {
      const response = new Response(null, {
        headers: { "content-type": "text/plain" },
      });
      // Force body to null
      Object.defineProperty(response, "body", { value: null });
      Object.defineProperty(response, "json", {
        value: () => Promise.reject(new Error("No body"))
      });

      const result = await adapter.transformStreamResponse(response, false);

      const reader = result.stream.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const fullOutput = chunks.join("");

      expect(fullOutput).toContain("[DONE]");
    });
  });

  describe("validateTools (private)", () => {
    it("filters out invalid tools", () => {
      const tools = [
        { function: { name: "valid" } },
        null,
        undefined,
        { function: null },
        { function: { name: "" } },
        "not an object",
        { function: { name: "also_valid" } },
      ];

      const result = (adapter as any).validateTools(tools);

      expect(result.length).toBe(2);
      expect(result[0].function.name).toBe("valid");
      expect(result[1].function.name).toBe("also_valid");
    });

    it("returns empty array for all invalid tools", () => {
      const tools = [null, undefined, {}];

      const result = (adapter as any).validateTools(tools);

      expect(result).toEqual([]);
    });
  });
});
