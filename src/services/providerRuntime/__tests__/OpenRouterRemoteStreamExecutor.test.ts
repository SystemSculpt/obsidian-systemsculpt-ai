import { executeOpenRouterRemoteStream } from "../OpenRouterRemoteStreamExecutor";

const mockResolveEndpoint = jest.fn(() => "https://openrouter.ai/api/v1");
const mockResolveApiKey = jest.fn(async () => "sk-test-key");
const mockRequest = jest.fn();
const mockStreamResponse = jest.fn();

jest.mock("../RemoteProviderCatalog", () => ({
  resolveRemoteProviderEndpoint: (...args: any[]) => mockResolveEndpoint(...args),
}));

jest.mock("../../../studio/piAuth/StudioPiAuthStorage", () => ({
  resolveStudioPiProviderApiKey: (...args: any[]) => mockResolveApiKey(...args),
}));

jest.mock("../../PlatformRequestClient", () => ({
  PlatformRequestClient: jest.fn().mockImplementation(() => ({
    request: (...args: any[]) => mockRequest(...args),
  })),
}));

jest.mock("../../StreamingService", () => ({
  StreamingService: jest.fn().mockImplementation(() => ({
    streamResponse: (...args: any[]) => mockStreamResponse(...args),
  })),
}));

jest.mock("../../StreamingErrorHandler", () => ({
  StreamingErrorHandler: {
    handleStreamError: jest.fn(),
  },
}));

jest.mock("../../../utils/tooling", () => ({
  ...jest.requireActual("../../../utils/tooling"),
  transformToolsForModel: jest.fn((_model: string, _endpoint: string, tools: any[]) => tools),
}));

function makeInput(overrides: Record<string, any> = {}): any {
  return {
    plugin: { settings: {} },
    prepared: {
      resolvedModel: {
        sourceProviderId: "openrouter",
        provider: "openrouter",
      },
      actualModelId: "openai/gpt-5.4-mini",
      preparedMessages: [
        { role: "user", content: "Hello" },
      ],
      tools: [],
    },
    ...overrides,
  };
}

describe("OpenRouterRemoteStreamExecutor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEndpoint.mockReturnValue("https://openrouter.ai/api/v1");
    mockResolveApiKey.mockResolvedValue("sk-test-key");
  });

  it("throws when no endpoint is configured for the provider", async () => {
    mockResolveEndpoint.mockReturnValue("");

    const gen = executeOpenRouterRemoteStream(makeInput());
    await expect(gen.next()).rejects.toThrow(
      /No remote endpoint configured for provider "openrouter"/
    );
  });

  it("throws when no API key is available", async () => {
    mockResolveApiKey.mockResolvedValue("");

    const gen = executeOpenRouterRemoteStream(makeInput());
    await expect(gen.next()).rejects.toThrow(
      /Connect openrouter in Providers before using this model/
    );
  });

  it("sends a streaming POST to the chat completions endpoint", async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {
      yield { type: "content", content: "hi" };
    })());

    const gen = executeOpenRouterRemoteStream(makeInput());
    const events = [];
    for await (const event of gen) {
      events.push(event);
    }

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockRequest.mock.calls[0][0];
    expect(callArgs.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(callArgs.method).toBe("POST");
    expect(callArgs.stream).toBe(true);
    expect(callArgs.headers.Authorization).toBe("Bearer sk-test-key");
    expect(callArgs.headers["HTTP-Referer"]).toBe("https://systemsculpt.com");
    expect(callArgs.body.model).toBe("openai/gpt-5.4-mini");
    expect(callArgs.body.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(callArgs.body.stream).toBe(true);

    expect(events).toEqual([{ type: "content", content: "hi" }]);
  });

  it("includes tools in the request body when provided", async () => {
    const tools = [{ type: "function", function: { name: "test_tool" } }];
    const input = makeInput();
    input.prepared.tools = tools;

    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {})());

    const gen = executeOpenRouterRemoteStream(input);
    for await (const _ of gen) {}

    const body = mockRequest.mock.calls[0][0].body;
    expect(body.tools).toEqual(tools);
  });

  it("normalizes completed tool calls before sending continuation messages", async () => {
    const input = makeInput();
    input.prepared.preparedMessages = [
      { role: "user", content: "Write the fixture", message_id: "user-1" },
      {
        role: "assistant",
        content: "",
        message_id: "assistant-1",
        tool_calls: [
          {
            id: "functions.mcp-filesystem_write_file:0",
            messageId: "assistant-1",
            request: {
              id: "functions.mcp-filesystem_write_file:0",
              type: "function",
              function: {
                name: "mcp-filesystem_write_file",
                arguments: "{\"path\":\"fixture.md\",\"content\":\"ok\"}",
              },
            },
            state: "completed",
            result: {
              success: true,
              data: { path: "fixture.md" },
            },
            timestamp: 123,
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "functions.mcp-filesystem_write_file:0",
        name: "mcp-filesystem_write_file",
        content: "{\"path\":\"fixture.md\"}",
        message_id: "tool-1",
      },
    ];

    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {})());

    const gen = executeOpenRouterRemoteStream(input);
    for await (const _ of gen) {}

    const messages = mockRequest.mock.calls[0][0].body.messages;
    expect(messages).toEqual([
      { role: "user", content: "Write the fixture" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: expect.stringMatching(/^call_/),
            type: "function",
            function: {
              name: "mcp-filesystem_write_file",
              arguments: "{\"path\":\"fixture.md\",\"content\":\"ok\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "{\"path\":\"fixture.md\"}",
        tool_call_id: messages[1].tool_calls[0].id,
      },
    ]);
  });

  it("includes reasoning_effort when specified", async () => {
    const input = makeInput({ reasoningEffort: "high" });

    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {})());

    const gen = executeOpenRouterRemoteStream(input);
    for await (const _ of gen) {}

    const body = mockRequest.mock.calls[0][0].body;
    expect(body.reasoning_effort).toBe("high");
  });

  it("does not include reasoning_effort when not specified", async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {})());

    const gen = executeOpenRouterRemoteStream(makeInput());
    for await (const _ of gen) {}

    const body = mockRequest.mock.calls[0][0].body;
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("fires debug callbacks in order", async () => {
    const callOrder: string[] = [];
    const debug = {
      onRequest: jest.fn(() => callOrder.push("request")),
      onResponse: jest.fn(() => callOrder.push("response")),
      onStreamEvent: jest.fn(() => callOrder.push("streamEvent")),
      onStreamEnd: jest.fn(() => callOrder.push("streamEnd")),
    };

    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {
      yield { type: "content", content: "hi" };
    })());

    const input = makeInput({ debug });
    const gen = executeOpenRouterRemoteStream(input);
    for await (const _ of gen) {}

    expect(callOrder).toEqual(["request", "response", "streamEvent", "streamEnd"]);
  });

  it("redacts the Authorization header in debug callbacks", async () => {
    const debug = { onRequest: jest.fn() };

    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {})());

    const input = makeInput({ debug });
    const gen = executeOpenRouterRemoteStream(input);
    for await (const _ of gen) {}

    const debugCall = debug.onRequest.mock.calls[0][0];
    expect(debugCall.headers.Authorization).toBe("Bearer [redacted]");
  });

  it("resolves provider id from sourceProviderId first, then provider field", async () => {
    const input = makeInput();
    input.prepared.resolvedModel = {
      sourceProviderId: "",
      provider: "custom-provider",
    };

    mockResolveEndpoint.mockReturnValue("https://custom.api/v1");
    mockRequest.mockResolvedValue({ ok: true, status: 200, headers: new Map() });
    mockStreamResponse.mockReturnValue((async function* () {})());

    const gen = executeOpenRouterRemoteStream(input);
    for await (const _ of gen) {}

    expect(mockResolveEndpoint).toHaveBeenCalledWith("custom-provider");
    expect(mockResolveApiKey).toHaveBeenCalledWith("custom-provider", expect.anything());
  });
});
