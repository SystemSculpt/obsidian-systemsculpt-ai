import {
  AnthropicStreamParser,
  buildAnthropicMessagesRequestBody,
  executeAnthropicRemoteStream,
  toAnthropicMessages,
  toAnthropicTools,
} from "../AnthropicRemoteStreamExecutor";
import { ANTHROPIC_API_VERSION } from "../../../constants/anthropic";
import type { StreamEvent } from "../../../streaming/types";

const mockResolveEndpoint = jest.fn(() => "https://api.anthropic.com/v1");
const mockResolveApiKey = jest.fn(async () => "sk-ant-test-key");
const mockRequest = jest.fn();

jest.mock("../RemoteProviderCatalog", () => ({
  resolveConfiguredRemoteProviderEndpoint: (_plugin: unknown, ...args: any[]) =>
    mockResolveEndpoint(...args),
}));

jest.mock("../../../studio/piAuth/StudioPiAuthStorage", () => ({
  resolveStudioPiProviderApiKey: (...args: any[]) => mockResolveApiKey(...args),
}));

jest.mock("../../PlatformRequestClient", () => ({
  PlatformRequestClient: jest.fn().mockImplementation(() => ({
    request: (...args: any[]) => mockRequest(...args),
  })),
}));

jest.mock("../../StreamingErrorHandler", () => ({
  StreamingErrorHandler: {
    handleStreamError: jest.fn(async () => {
      throw new Error("stream-error-handled");
    }),
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makePrepared(overrides: Record<string, any> = {}): any {
  return {
    resolvedModel: {
      sourceProviderId: "anthropic",
      provider: "anthropic",
      top_provider: { context_length: 200000, max_completion_tokens: null, is_moderated: false },
    },
    actualModelId: "claude-sonnet-4-6",
    preparedMessages: [{ role: "user", content: "Hello" }],
    finalSystemPrompt: "",
    tools: [],
    ...overrides,
  };
}

function makeInput(overrides: Record<string, any> = {}): any {
  return {
    plugin: { settings: {} },
    prepared: makePrepared(overrides.prepared),
    ...overrides,
  };
}

/** Build a fake streaming Response whose body streams the given SSE text. */
function makeStreamingResponse(
  sse: string,
  init: { ok?: boolean; status?: number } = {},
): Response {
  const encoder = new TextEncoder();
  // Split into a couple chunks to exercise incremental decoding.
  const mid = Math.floor(sse.length / 2);
  const chunks = [sse.slice(0, mid), sse.slice(mid)];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Map(),
    body,
  } as unknown as Response;
}

async function collect(gen: AsyncGenerator<StreamEvent, void, unknown>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function pushAll(parser: AnthropicStreamParser, sse: string): StreamEvent[] {
  const events = parser.push(sse);
  return [...events, ...parser.flush()];
}

// ────────────────────────────────────────────────────────────────────────────
// buildAnthropicMessagesRequestBody
// ────────────────────────────────────────────────────────────────────────────

describe("buildAnthropicMessagesRequestBody", () => {
  it("builds a streaming body with model, messages, and stream:true", () => {
    const body = buildAnthropicMessagesRequestBody(makeInput());
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("includes system from finalSystemPrompt when non-empty", () => {
    const body = buildAnthropicMessagesRequestBody(
      makeInput({ prepared: makePrepared({ finalSystemPrompt: "You are helpful." }) }),
    );
    expect(body.system).toBe("You are helpful.");
    // System must not be injected into messages.
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("omits the system key when finalSystemPrompt is empty or whitespace", () => {
    const empty = buildAnthropicMessagesRequestBody(
      makeInput({ prepared: makePrepared({ finalSystemPrompt: "" }) }),
    );
    expect("system" in empty).toBe(false);

    const whitespace = buildAnthropicMessagesRequestBody(
      makeInput({ prepared: makePrepared({ finalSystemPrompt: "   " }) }),
    );
    expect("system" in whitespace).toBe(false);
  });

  it("defaults max_tokens to 8192 when no completion cap is declared", () => {
    const body = buildAnthropicMessagesRequestBody(makeInput());
    expect(body.max_tokens).toBe(8192);
  });

  it("uses top_provider.max_completion_tokens when it is a positive number", () => {
    const body = buildAnthropicMessagesRequestBody(
      makeInput({
        prepared: makePrepared({
          resolvedModel: {
            top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: false },
          },
        }),
      }),
    );
    expect(body.max_tokens).toBe(64000);
  });

  it("falls back to default max_tokens when the declared cap is non-positive", () => {
    const body = buildAnthropicMessagesRequestBody(
      makeInput({
        prepared: makePrepared({
          resolvedModel: {
            top_provider: { context_length: 200000, max_completion_tokens: 0, is_moderated: false },
          },
        }),
      }),
    );
    expect(body.max_tokens).toBe(8192);
  });

  it("translates tools and omits the tools key when none are provided", () => {
    const withTools = buildAnthropicMessagesRequestBody(
      makeInput({
        prepared: makePrepared({
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
        }),
      }),
    );
    expect(withTools.tools).toEqual([
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);

    const withoutTools = buildAnthropicMessagesRequestBody(makeInput());
    expect("tools" in withoutTools).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// toAnthropicMessages
// ────────────────────────────────────────────────────────────────────────────

describe("toAnthropicMessages", () => {
  it("drops system messages (system is a top-level field)", () => {
    const result = toAnthropicMessages([
      { role: "system", content: "be terse" } as any,
      { role: "user", content: "hi" } as any,
    ]);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("passes through user and assistant text turns", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "What is 2+2?" } as any,
      { role: "assistant", content: "4" } as any,
    ]);
    expect(result).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ]);
  });

  it("converts assistant tool_calls into tool_use blocks with parsed input", () => {
    const result = toAnthropicMessages([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "toolu_01",
            request: {
              id: "toolu_01",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          },
        ],
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "Paris" } }],
      },
    ]);
  });

  it("includes a leading text block when an assistant has both text and tool_calls", () => {
    const result = toAnthropicMessages([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "toolu_02",
            function: { name: "lookup", arguments: '{"q":"x"}' },
          },
        ],
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_02", name: "lookup", input: { q: "x" } },
        ],
      },
    ]);
  });

  it("converts a tool message into a user tool_result block keyed by tool_use_id", () => {
    const result = toAnthropicMessages([
      {
        role: "tool",
        tool_call_id: "toolu_01",
        name: "get_weather",
        content: '{"temp":20}',
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: '{"temp":20}' }],
      },
    ]);
  });

  it("merges adjacent tool results into a single user turn", () => {
    const result = toAnthropicMessages([
      { role: "tool", tool_call_id: "toolu_a", content: "result-a" } as any,
      { role: "tool", tool_call_id: "toolu_b", content: "result-b" } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "result-a" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "result-b" },
        ],
      },
    ]);
  });

  it("does not merge a tool result into a preceding non-tool-result user turn", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "hello" } as any,
      { role: "tool", tool_call_id: "toolu_a", content: "result-a" } as any,
    ]);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "result-a" }],
      },
    ]);
  });

  it("maps a multimodal user image part into an Anthropic base64 image block", () => {
    const result = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ]);
  });

  it("skips remote (non-base64) image URLs that the base64 source cannot carry", () => {
    const result = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      } as any,
    ]);
    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "look" }] }]);
  });

  it("never emits empty content for a turn (falls back to a single space)", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "" } as any,
      { role: "assistant", content: "" } as any,
    ]);
    expect(result).toEqual([
      { role: "user", content: " " },
      { role: "assistant", content: " " },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// toAnthropicTools
// ────────────────────────────────────────────────────────────────────────────

describe("toAnthropicTools", () => {
  it("maps OpenAI function tools to Anthropic input_schema tools", () => {
    const result = toAnthropicTools([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      },
    ]);
    expect(result).toEqual([
      {
        name: "search",
        description: "Search the web",
        input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
  });

  it("handles tools already in the flattened {name, description, parameters} shape", () => {
    const result = toAnthropicTools([
      {
        name: "calc",
        description: "Do math",
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
    ]);
    expect(result).toEqual([
      {
        name: "calc",
        description: "Do math",
        input_schema: { type: "object", properties: { expr: { type: "string" } } },
      },
    ]);
  });

  it("defaults input_schema to an empty object schema when parameters are missing", () => {
    const result = toAnthropicTools([{ type: "function", function: { name: "noargs" } }]);
    expect(result).toEqual([
      { name: "noargs", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("skips entries without a usable name", () => {
    const result = toAnthropicTools([
      { type: "function", function: { description: "no name" } },
      null,
      "nonsense",
    ] as any);
    expect(result).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AnthropicStreamParser
// ────────────────────────────────────────────────────────────────────────────

describe("AnthropicStreamParser", () => {
  it("parses a text transcript into content events and a stop-reason meta", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\n");

    const parser = new AnthropicStreamParser();
    const events = pushAll(parser, sse);

    expect(events).toEqual([
      { type: "content", text: "Hello" },
      { type: "content", text: ", world" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("emits reasoning events for thinking deltas", () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}',
      '',
    ].join("\n");

    const parser = new AnthropicStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "reasoning", text: "hmm " },
      { type: "reasoning", text: "let me think" },
    ]);
  });

  it("assembles a tool_use transcript into a final tool-call with concatenated JSON args", () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_99","name":"get_weather","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
    ].join("\n");

    const parser = new AnthropicStreamParser();
    const events = pushAll(parser, sse);

    // First a delta with empty args at block start, then accumulating deltas,
    // and finally the assembled tool call.
    expect(events[0]).toEqual({
      type: "tool-call",
      phase: "delta",
      call: { id: "toolu_99", type: "function", function: { name: "get_weather", arguments: "" } },
    });

    const finalEvent = events.find((e) => e.type === "tool-call" && e.phase === "final");
    expect(finalEvent).toEqual({
      type: "tool-call",
      phase: "final",
      call: {
        id: "toolu_99",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    });

    expect(events[events.length - 1]).toEqual({
      type: "meta",
      key: "stop-reason",
      value: "toolUse",
    });
  });

  it("maps max_tokens stop reason to length", () => {
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n';
    const parser = new AnthropicStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "meta", key: "stop-reason", value: "length" },
    ]);
  });

  it("maps stop_sequence stop reason to stop", () => {
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"stop_sequence"}}\n\n';
    const parser = new AnthropicStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("ignores ping events and produces no output for them", () => {
    const sse = 'event: ping\ndata: {"type":"ping"}\n\n';
    const parser = new AnthropicStreamParser();
    expect(pushAll(parser, sse)).toEqual([]);
  });

  it("buffers an SSE event split across two push calls", () => {
    const parser = new AnthropicStreamParser();
    // Cut the data line in half mid-JSON, and even mid-event-name.
    const first = 'event: content_block_de';
    const second =
      'lta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunked"}}\n\n';

    const firstEvents = parser.push(first);
    expect(firstEvents).toEqual([]);

    const secondEvents = parser.push(second);
    expect(secondEvents).toEqual([{ type: "content", text: "chunked" }]);
  });

  it("buffers when a chunk cuts the JSON payload in half", () => {
    const parser = new AnthropicStreamParser();
    const part1 =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_';
    const part2 = 'delta","text":"split"}}\n\n';

    expect(parser.push(part1)).toEqual([]);
    expect(parser.push(part2)).toEqual([{ type: "content", text: "split" }]);
  });

  it("throws a SystemSculptError carrying the message on an error event", () => {
    const sse =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const parser = new AnthropicStreamParser();
    expect(() => parser.push(sse)).toThrow("Overloaded");
  });

  it("handles \\r\\n line endings", () => {
    const sse =
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"crlf"}}\r\n\r\n';
    const parser = new AnthropicStreamParser();
    expect(pushAll(parser, sse)).toEqual([{ type: "content", text: "crlf" }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// executeAnthropicRemoteStream
// ────────────────────────────────────────────────────────────────────────────

describe("executeAnthropicRemoteStream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEndpoint.mockReturnValue("https://api.anthropic.com/v1");
    mockResolveApiKey.mockResolvedValue("sk-ant-test-key");
  });

  it("throws when no endpoint is configured", async () => {
    mockResolveEndpoint.mockReturnValue("");
    const gen = executeAnthropicRemoteStream(makeInput());
    await expect(gen.next()).rejects.toThrow(
      /No remote endpoint configured for provider "anthropic"/,
    );
  });

  it("throws the connect message when no API key is available", async () => {
    mockResolveApiKey.mockResolvedValue("");
    const gen = executeAnthropicRemoteStream(makeInput());
    await expect(gen.next()).rejects.toThrow(
      /Connect anthropic in Providers before using this model/,
    );
  });

  it("POSTs to the /messages endpoint with Anthropic headers and yields events", async () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
    ].join("\n");

    mockRequest.mockResolvedValue(makeStreamingResponse(sse));

    const events = await collect(executeAnthropicRemoteStream(makeInput()));

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockRequest.mock.calls[0][0];
    expect(callArgs.url).toBe("https://api.anthropic.com/v1/messages");
    expect(callArgs.method).toBe("POST");
    expect(callArgs.stream).toBe(true);
    expect(callArgs.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(callArgs.headers["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
    expect(callArgs.headers["content-type"]).toBe("application/json");
    expect(callArgs.headers.Authorization).toBeUndefined();
    expect(callArgs.body.model).toBe("claude-sonnet-4-6");
    expect(callArgs.body.stream).toBe(true);

    expect(events).toEqual([
      { type: "content", text: "hi" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("trims a trailing slash on the endpoint before appending /messages", async () => {
    mockResolveEndpoint.mockReturnValue("https://proxy.example.com/v1/");
    mockRequest.mockResolvedValue(makeStreamingResponse('event: ping\ndata: {"type":"ping"}\n\n'));

    await collect(executeAnthropicRemoteStream(makeInput()));

    expect(mockRequest.mock.calls[0][0].url).toBe("https://proxy.example.com/v1/messages");
  });

  it("redacts the api key in the debug onRequest headers", async () => {
    const debug = { onRequest: jest.fn() };
    mockRequest.mockResolvedValue(makeStreamingResponse('event: ping\ndata: {"type":"ping"}\n\n'));

    await collect(executeAnthropicRemoteStream(makeInput({ debug })));

    const debugCall = debug.onRequest.mock.calls[0][0];
    expect(debugCall.headers["x-api-key"]).toBe("[redacted]");
    expect(debugCall.headers["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
  });

  it("fires debug callbacks in order", async () => {
    const callOrder: string[] = [];
    const debug = {
      onRequest: jest.fn(() => callOrder.push("request")),
      onResponse: jest.fn(() => callOrder.push("response")),
      onStreamEvent: jest.fn(() => callOrder.push("streamEvent")),
      onStreamEnd: jest.fn(() => callOrder.push("streamEnd")),
    };
    const sse =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n';
    mockRequest.mockResolvedValue(makeStreamingResponse(sse));

    await collect(executeAnthropicRemoteStream(makeInput({ debug })));

    expect(callOrder).toEqual(["request", "response", "streamEvent", "streamEnd"]);
    expect(debug.onStreamEnd).toHaveBeenCalledWith(
      expect.objectContaining({ completed: true, aborted: false }),
    );
  });

  it("delegates to StreamingErrorHandler when the response is not ok", async () => {
    mockRequest.mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: "bad key" } }),
    });

    const gen = executeAnthropicRemoteStream(makeInput());
    await expect(collect(gen)).rejects.toThrow("stream-error-handled");

    const { StreamingErrorHandler } = require("../../StreamingErrorHandler");
    expect(StreamingErrorHandler.handleStreamError).toHaveBeenCalledTimes(1);
    const [, isCustomProvider, context] = StreamingErrorHandler.handleStreamError.mock.calls[0];
    expect(isCustomProvider).toBe(true);
    expect(context).toEqual({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
    });
  });

  it("streams an assistant tool call end-to-end", async () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_7","name":"lookup","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"hi\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
    ].join("\n");

    mockRequest.mockResolvedValue(makeStreamingResponse(sse));

    const events = await collect(executeAnthropicRemoteStream(makeInput()));
    const finalCall = events.find((e) => e.type === "tool-call" && e.phase === "final");
    expect(finalCall).toEqual({
      type: "tool-call",
      phase: "final",
      call: { id: "toolu_7", type: "function", function: { name: "lookup", arguments: '{"q":"hi"}' } },
    });
    expect(events[events.length - 1]).toEqual({
      type: "meta",
      key: "stop-reason",
      value: "toolUse",
    });
  });

  it("stops yielding and reports aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const debug = { onStreamEnd: jest.fn() };
    mockRequest.mockResolvedValue(
      makeStreamingResponse(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"nope"}}\n\n',
      ),
    );

    const events = await collect(
      executeAnthropicRemoteStream(makeInput({ signal: controller.signal, debug })),
    );

    expect(events).toEqual([]);
    expect(debug.onStreamEnd).toHaveBeenCalledWith(
      expect.objectContaining({ completed: false, aborted: true }),
    );
  });
});
