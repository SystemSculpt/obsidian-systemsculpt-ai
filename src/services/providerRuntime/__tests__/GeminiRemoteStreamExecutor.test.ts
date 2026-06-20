import {
  GeminiStreamParser,
  buildGeminiRequestBody,
  executeGeminiRemoteStream,
  toGeminiContents,
  toGeminiTools,
} from "../GeminiRemoteStreamExecutor";
import { GEMINI_API_KEY_HEADER, GEMINI_STREAM_ACTION } from "../../../constants/gemini";
import type { StreamEvent } from "../../../streaming/types";

const mockResolveEndpoint = jest.fn(() => "https://generativelanguage.googleapis.com/v1beta");
const mockResolveApiKey = jest.fn(async () => "gem-test-key");
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
      sourceProviderId: "google",
      provider: "google",
      top_provider: { context_length: 1000000, max_completion_tokens: null, is_moderated: false },
    },
    actualModelId: "gemini-3-flash-preview",
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

function pushAll(parser: GeminiStreamParser, sse: string): StreamEvent[] {
  const events = parser.push(sse);
  return [...events, ...parser.flush()];
}

/** Frame a GenerateContentResponse object as an `alt=sse` data frame. */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// ────────────────────────────────────────────────────────────────────────────
// buildGeminiRequestBody
// ────────────────────────────────────────────────────────────────────────────

describe("buildGeminiRequestBody", () => {
  it("builds a body with translated contents (no top-level stream field)", () => {
    const body = buildGeminiRequestBody(makeInput());
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
    // Gemini streams via the :streamGenerateContent action, not a body flag.
    expect("stream" in body).toBe(false);
  });

  it("includes systemInstruction from finalSystemPrompt when non-empty", () => {
    const body = buildGeminiRequestBody(
      makeInput({ prepared: makePrepared({ finalSystemPrompt: "You are helpful." }) }),
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are helpful." }] });
    // System must not be injected into contents.
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
  });

  it("omits systemInstruction when finalSystemPrompt is empty or whitespace", () => {
    const empty = buildGeminiRequestBody(
      makeInput({ prepared: makePrepared({ finalSystemPrompt: "" }) }),
    );
    expect("systemInstruction" in empty).toBe(false);

    const whitespace = buildGeminiRequestBody(
      makeInput({ prepared: makePrepared({ finalSystemPrompt: "   " }) }),
    );
    expect("systemInstruction" in whitespace).toBe(false);
  });

  it("omits generationConfig when no completion cap is declared", () => {
    const body = buildGeminiRequestBody(makeInput());
    expect("generationConfig" in body).toBe(false);
  });

  it("sets generationConfig.maxOutputTokens from a positive completion cap (floored)", () => {
    const body = buildGeminiRequestBody(
      makeInput({
        prepared: makePrepared({
          resolvedModel: {
            top_provider: { context_length: 1000000, max_completion_tokens: 8192.9, is_moderated: false },
          },
        }),
      }),
    );
    expect(body.generationConfig).toEqual({ maxOutputTokens: 8192 });
  });

  it("omits generationConfig when the declared cap is non-positive", () => {
    const body = buildGeminiRequestBody(
      makeInput({
        prepared: makePrepared({
          resolvedModel: {
            top_provider: { context_length: 1000000, max_completion_tokens: 0, is_moderated: false },
          },
        }),
      }),
    );
    expect("generationConfig" in body).toBe(false);
  });

  it("omits thinkingConfig when no reasoning effort is requested (#231)", () => {
    const body = buildGeminiRequestBody(
      makeInput({
        prepared: makePrepared({
          resolvedModel: {
            top_provider: { context_length: 1000000, max_completion_tokens: 8192, is_moderated: false },
          },
        }),
      }),
    );
    expect(body.generationConfig).toEqual({ maxOutputTokens: 8192 });
  });

  it("enables thinking with thought summaries for a requested reasoning effort (#231)", () => {
    // A reasoning-capable Gemini must actually reason; includeThoughts surfaces
    // the thought summaries the parser turns into reasoning events.
    const body = buildGeminiRequestBody(makeInput({ reasoningEffort: "medium" }));
    expect(body.generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
    });
  });

  it("disables thinking (budget 0, no thoughts) when reasoning effort is 'off' (#231)", () => {
    const body = buildGeminiRequestBody(makeInput({ reasoningEffort: "off" }));
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it("merges maxOutputTokens and thinkingConfig when both apply (#231)", () => {
    const body = buildGeminiRequestBody(
      makeInput({
        reasoningEffort: "high",
        prepared: makePrepared({
          resolvedModel: {
            top_provider: { context_length: 1000000, max_completion_tokens: 8192, is_moderated: false },
          },
        }),
      }),
    );
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
    });
  });

  it("translates tools into functionDeclarations and omits tools when none provided", () => {
    const withTools = buildGeminiRequestBody(
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
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
    ]);

    const withoutTools = buildGeminiRequestBody(makeInput());
    expect("tools" in withoutTools).toBe(false);
  });

  it("omits tools when the provided tools yield no usable declarations", () => {
    const body = buildGeminiRequestBody(
      makeInput({
        prepared: makePrepared({
          tools: [{ type: "function", function: { description: "no name" } }],
        }),
      }),
    );
    expect("tools" in body).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// toGeminiContents
// ────────────────────────────────────────────────────────────────────────────

describe("toGeminiContents", () => {
  it("drops system messages (system is a top-level field)", () => {
    const result = toGeminiContents([
      { role: "system", content: "be terse" } as any,
      { role: "user", content: "hi" } as any,
    ]);
    expect(result).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("maps user→user and assistant→model text turns", () => {
    const result = toGeminiContents([
      { role: "user", content: "What is 2+2?" } as any,
      { role: "assistant", content: "4" } as any,
    ]);
    expect(result).toEqual([
      { role: "user", parts: [{ text: "What is 2+2?" }] },
      { role: "model", parts: [{ text: "4" }] },
    ]);
  });

  it("converts assistant tool_calls into functionCall parts with parsed object args", () => {
    const result = toGeminiContents([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_01",
            request: {
              id: "call_01",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          },
        ],
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }],
      },
    ]);
  });

  it("includes a leading text part when an assistant has both text and tool_calls", () => {
    const result = toGeminiContents([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "call_02", function: { name: "lookup", arguments: '{"q":"x"}' } }],
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "model",
        parts: [
          { text: "Let me check." },
          { functionCall: { name: "lookup", args: { q: "x" } } },
        ],
      },
    ]);
  });

  it("uses {} args when assistant tool_call arguments are empty or unparseable", () => {
    const result = toGeminiContents([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "a", arguments: "" } },
          { id: "c2", function: { name: "b", arguments: "not json" } },
        ],
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "model",
        parts: [
          { functionCall: { name: "a", args: {} } },
          { functionCall: { name: "b", args: {} } },
        ],
      },
    ]);
  });

  it("converts a tool message into a user functionResponse keyed by name", () => {
    const result = toGeminiContents([
      {
        role: "tool",
        tool_call_id: "call_01",
        name: "get_weather",
        content: '{"temp":20}',
      } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", response: { temp: 20 } } }],
      },
    ]);
  });

  it("wraps non-object tool content under { result } in the functionResponse", () => {
    const result = toGeminiContents([
      { role: "tool", name: "echo", content: "plain text" } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ functionResponse: { name: "echo", response: { result: "plain text" } } }],
      },
    ]);
  });

  it("derives the functionResponse name from tool_call_id when name is absent", () => {
    const result = toGeminiContents([
      { role: "tool", tool_call_id: "call_xyz", content: "{}" } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ functionResponse: { name: "call_xyz", response: {} } }],
      },
    ]);
  });

  it("merges adjacent tool messages into a single user turn", () => {
    const result = toGeminiContents([
      { role: "tool", name: "a", content: "result-a" } as any,
      { role: "tool", name: "b", content: "result-b" } as any,
    ]);
    expect(result).toEqual([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "a", response: { result: "result-a" } } },
          { functionResponse: { name: "b", response: { result: "result-b" } } },
        ],
      },
    ]);
  });

  it("does not merge a tool result into a preceding plain user turn", () => {
    const result = toGeminiContents([
      { role: "user", content: "hello" } as any,
      { role: "tool", name: "a", content: "result-a" } as any,
    ]);
    expect(result).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "a", response: { result: "result-a" } } }],
      },
    ]);
  });

  it("maps a multimodal user image data URL into an inlineData part", () => {
    const result = toGeminiContents([
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
        parts: [
          { text: "What is this?" },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });

  it("skips remote (non-base64) image URLs that inlineData cannot carry", () => {
    const result = toGeminiContents([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      } as any,
    ]);
    expect(result).toEqual([{ role: "user", parts: [{ text: "look" }] }]);
  });

  it("never emits empty parts for a turn (falls back to a single space)", () => {
    const result = toGeminiContents([
      { role: "user", content: "" } as any,
      { role: "assistant", content: "" } as any,
    ]);
    expect(result).toEqual([
      { role: "user", parts: [{ text: " " }] },
      { role: "model", parts: [{ text: " " }] },
    ]);
  });

  it("falls back to a space part when an image-only turn has no carryable parts", () => {
    const result = toGeminiContents([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
      } as any,
    ]);
    expect(result).toEqual([{ role: "user", parts: [{ text: " " }] }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// toGeminiTools
// ────────────────────────────────────────────────────────────────────────────

describe("toGeminiTools", () => {
  it("maps OpenAI function tools to functionDeclarations", () => {
    const result = toGeminiTools([
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
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
  });

  it("handles tools already in the flattened {name, description, parameters} shape", () => {
    const result = toGeminiTools([
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
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
    ]);
  });

  it("falls back to input_schema when parameters are absent", () => {
    const result = toGeminiTools([
      {
        type: "function",
        function: {
          name: "fromSchema",
          input_schema: { type: "object", properties: { a: { type: "number" } } },
        },
      },
    ]);
    expect(result).toEqual([
      {
        name: "fromSchema",
        parameters: { type: "object", properties: { a: { type: "number" } } },
      },
    ]);
  });

  it("defaults parameters to an empty object schema when none provided", () => {
    const result = toGeminiTools([{ type: "function", function: { name: "noargs" } }]);
    expect(result).toEqual([
      { name: "noargs", parameters: { type: "object", properties: {} } },
    ]);
  });

  it("skips entries without a usable name and non-object entries", () => {
    const result = toGeminiTools([
      { type: "function", function: { description: "no name" } },
      null,
      "nonsense",
    ] as any);
    expect(result).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GeminiStreamParser
// ────────────────────────────────────────────────────────────────────────────

describe("GeminiStreamParser", () => {
  it("parses text-delta frames into content events and a stop-reason meta", () => {
    const sse =
      frame({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ text: ", world" }] } }] }) +
      frame({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });

    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "content", text: "Hello" },
      { type: "content", text: ", world" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("emits reasoning events for thought parts and skips empty text", () => {
    const sse =
      frame({ candidates: [{ content: { parts: [{ thought: true, text: "hmm " }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ thought: true, text: "" }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ thought: true, text: "let me think" }] } }] });

    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "reasoning", text: "hmm " },
      { type: "reasoning", text: "let me think" },
    ]);
  });

  it("emits both delta and final tool-call events for a functionCall part", () => {
    const sse = frame({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }],
          },
        },
      ],
    });

    const parser = new GeminiStreamParser();
    const events = pushAll(parser, sse);

    expect(events).toEqual([
      {
        type: "tool-call",
        phase: "delta",
        call: {
          id: "call_0_get_weather",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      },
      {
        type: "tool-call",
        phase: "final",
        call: {
          id: "call_0_get_weather",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      },
    ]);
  });

  it("serializes missing functionCall args as an empty object", () => {
    const sse = frame({
      candidates: [{ content: { parts: [{ functionCall: { name: "ping" } }] } }],
    });
    const parser = new GeminiStreamParser();
    const finalEvent = pushAll(parser, sse).find(
      (e) => e.type === "tool-call" && e.phase === "final",
    );
    expect(finalEvent).toEqual({
      type: "tool-call",
      phase: "final",
      call: { id: "call_0_ping", type: "function", function: { name: "ping", arguments: "{}" } },
    });
  });

  it("maps STOP to toolUse once a functionCall has been seen", () => {
    const sse =
      frame({
        candidates: [
          { content: { parts: [{ functionCall: { name: "lookup", args: { q: "hi" } } }] } },
        ],
      }) + frame({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });

    const parser = new GeminiStreamParser();
    const events = pushAll(parser, sse);
    expect(events[events.length - 1]).toEqual({
      type: "meta",
      key: "stop-reason",
      value: "toolUse",
    });
  });

  it("maps a bare STOP (no functionCall) to stop", () => {
    const sse = frame({ candidates: [{ finishReason: "STOP" }] });
    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("maps MAX_TOKENS to length", () => {
    const sse = frame({ candidates: [{ finishReason: "MAX_TOKENS" }] });
    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([
      { type: "meta", key: "stop-reason", value: "length" },
    ]);
  });

  it("maps SAFETY/RECITATION/OTHER/unknown finish reasons to stop", () => {
    for (const reason of ["SAFETY", "RECITATION", "OTHER", "SOMETHING_NEW"]) {
      const parser = new GeminiStreamParser();
      expect(pushAll(parser, frame({ candidates: [{ finishReason: reason }] }))).toEqual([
        { type: "meta", key: "stop-reason", value: "stop" },
      ]);
    }
  });

  it("ignores usageMetadata / modelVersion / promptFeedback frames", () => {
    const sse =
      frame({ usageMetadata: { totalTokenCount: 12 }, modelVersion: "gemini-3-flash" }) +
      frame({ promptFeedback: { blockReason: "OTHER" } });
    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([]);
  });

  it("throws a SystemSculptError carrying the message on an error frame", () => {
    const sse = frame({
      error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" },
    });
    const parser = new GeminiStreamParser();
    expect(() => parser.push(sse)).toThrow("Resource exhausted");
  });

  it("buffers an SSE frame split across two push calls (mid-JSON)", () => {
    const parser = new GeminiStreamParser();
    const full = frame({ candidates: [{ content: { parts: [{ text: "chunked" }] } }] });
    const cut = Math.floor(full.length / 2);

    expect(parser.push(full.slice(0, cut))).toEqual([]);
    expect(parser.push(full.slice(cut))).toEqual([{ type: "content", text: "chunked" }]);
  });

  it("joins a single JSON object split across consecutive data lines", () => {
    const json = JSON.stringify({ candidates: [{ content: { parts: [{ text: "split" }] } }] });
    const half = Math.floor(json.length / 2);
    // Two data lines within one frame; the parser joins them before parsing.
    const sse = `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}\n\n`;

    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([{ type: "content", text: "split" }]);
  });

  it("flushes an unterminated frame whose trailing blank line never arrived", () => {
    const parser = new GeminiStreamParser();
    // No terminating blank line — only flush should dispatch it.
    const sse = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "tail" }] } }],
    })}`;
    expect(parser.push(sse)).toEqual([]);
    expect(parser.flush()).toEqual([{ type: "content", text: "tail" }]);
  });

  it("ignores SSE comment lines", () => {
    const sse =
      `: keep-alive\n` + frame({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([{ type: "content", text: "ok" }]);
  });

  it("handles \\r\\n line endings", () => {
    const json = JSON.stringify({ candidates: [{ content: { parts: [{ text: "crlf" }] } }] });
    const sse = `data: ${json}\r\n\r\n`;
    const parser = new GeminiStreamParser();
    expect(pushAll(parser, sse)).toEqual([{ type: "content", text: "crlf" }]);
  });

  it("synthesizes incrementing ids for multiple function calls", () => {
    const sse =
      frame({ candidates: [{ content: { parts: [{ functionCall: { name: "a", args: {} } }] } }] }) +
      frame({ candidates: [{ content: { parts: [{ functionCall: { name: "b", args: {} } }] } }] });
    const parser = new GeminiStreamParser();
    const finals = pushAll(parser, sse).filter(
      (e) => e.type === "tool-call" && e.phase === "final",
    );
    expect(finals.map((e) => (e as any).call.id)).toEqual(["call_0_a", "call_1_b"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// executeGeminiRemoteStream
// ────────────────────────────────────────────────────────────────────────────

describe("executeGeminiRemoteStream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEndpoint.mockReturnValue("https://generativelanguage.googleapis.com/v1beta");
    mockResolveApiKey.mockResolvedValue("gem-test-key");
  });

  it("throws when no endpoint is configured", async () => {
    mockResolveEndpoint.mockReturnValue("");
    const gen = executeGeminiRemoteStream(makeInput());
    await expect(gen.next()).rejects.toThrow(
      /No remote endpoint configured for provider "google"/,
    );
  });

  it("throws the connect message when no API key is available", async () => {
    mockResolveApiKey.mockResolvedValue("");
    const gen = executeGeminiRemoteStream(makeInput());
    await expect(gen.next()).rejects.toThrow(
      /Connect google in Providers before using this model/,
    );
  });

  it("POSTs to the streamGenerateContent endpoint with the api-key header and yields events", async () => {
    const sse =
      frame({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }) +
      frame({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });

    mockRequest.mockResolvedValue(makeStreamingResponse(sse));

    const events = await collect(executeGeminiRemoteStream(makeInput()));

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockRequest.mock.calls[0][0];
    expect(callArgs.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:${GEMINI_STREAM_ACTION}?alt=sse`,
    );
    expect(callArgs.method).toBe("POST");
    expect(callArgs.stream).toBe(true);
    expect(callArgs.headers[GEMINI_API_KEY_HEADER]).toBe("gem-test-key");
    expect(callArgs.headers["content-type"]).toBe("application/json");
    // No Authorization / Bearer / x-api-key auth schemes.
    expect(callArgs.headers.Authorization).toBeUndefined();
    expect(callArgs.headers["x-api-key"]).toBeUndefined();
    // Transport flag only; the request body carries no stream field.
    expect("stream" in callArgs.body).toBe(false);
    expect(callArgs.body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);

    expect(events).toEqual([
      { type: "content", text: "hi" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("trims trailing slashes on the endpoint and url-encodes the model id", async () => {
    mockResolveEndpoint.mockReturnValue("https://proxy.example.com/v1beta/");
    mockRequest.mockResolvedValue(
      makeStreamingResponse(frame({ candidates: [{ finishReason: "STOP" }] })),
    );

    await collect(
      executeGeminiRemoteStream(
        makeInput({ prepared: makePrepared({ actualModelId: "models/gemini-pro" }) }),
      ),
    );

    expect(mockRequest.mock.calls[0][0].url).toBe(
      `https://proxy.example.com/v1beta/models/models%2Fgemini-pro:${GEMINI_STREAM_ACTION}?alt=sse`,
    );
  });

  it("redacts the api key in the debug onRequest headers", async () => {
    const debug = { onRequest: jest.fn() };
    mockRequest.mockResolvedValue(
      makeStreamingResponse(frame({ candidates: [{ finishReason: "STOP" }] })),
    );

    await collect(executeGeminiRemoteStream(makeInput({ debug })));

    const debugCall = debug.onRequest.mock.calls[0][0];
    expect(debugCall.headers[GEMINI_API_KEY_HEADER]).toBe("[redacted]");
    expect(debugCall.headers.Authorization).toBeUndefined();
  });

  it("fires debug callbacks in order", async () => {
    const callOrder: string[] = [];
    const debug = {
      onRequest: jest.fn(() => callOrder.push("request")),
      onResponse: jest.fn(() => callOrder.push("response")),
      onStreamEvent: jest.fn(() => callOrder.push("streamEvent")),
      onStreamEnd: jest.fn(() => callOrder.push("streamEnd")),
    };
    const sse = frame({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
    mockRequest.mockResolvedValue(makeStreamingResponse(sse));

    await collect(executeGeminiRemoteStream(makeInput({ debug })));

    expect(callOrder).toEqual(["request", "response", "streamEvent", "streamEnd"]);
    expect(debug.onStreamEnd).toHaveBeenCalledWith(
      expect.objectContaining({ completed: true, aborted: false }),
    );
  });

  it("delegates to StreamingErrorHandler when the response is not ok", async () => {
    mockRequest.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: "bad key" } }),
    });

    const gen = executeGeminiRemoteStream(makeInput());
    await expect(collect(gen)).rejects.toThrow("stream-error-handled");

    const { StreamingErrorHandler } = require("../../StreamingErrorHandler");
    expect(StreamingErrorHandler.handleStreamError).toHaveBeenCalledTimes(1);
    const [, isCustomProvider, context] = StreamingErrorHandler.handleStreamError.mock.calls[0];
    expect(isCustomProvider).toBe(true);
    expect(context).toEqual({
      provider: "google",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3-flash-preview",
    });
  });

  it("streams an assistant tool call end-to-end (delta + final + toolUse)", async () => {
    const sse =
      frame({
        candidates: [
          { content: { parts: [{ functionCall: { name: "lookup", args: { q: "hi" } } }] } },
        ],
      }) + frame({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });

    mockRequest.mockResolvedValue(makeStreamingResponse(sse));

    const events = await collect(executeGeminiRemoteStream(makeInput()));
    const finalCall = events.find((e) => e.type === "tool-call" && e.phase === "final");
    expect(finalCall).toEqual({
      type: "tool-call",
      phase: "final",
      call: {
        id: "call_0_lookup",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"hi"}' },
      },
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
      makeStreamingResponse(frame({ candidates: [{ content: { parts: [{ text: "nope" }] } }] })),
    );

    const events = await collect(
      executeGeminiRemoteStream(makeInput({ signal: controller.signal, debug })),
    );

    expect(events).toEqual([]);
    expect(debug.onStreamEnd).toHaveBeenCalledWith(
      expect.objectContaining({ completed: false, aborted: true }),
    );
  });
});
