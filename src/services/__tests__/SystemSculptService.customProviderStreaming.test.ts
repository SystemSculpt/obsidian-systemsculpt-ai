import { App } from "obsidian";
import { SystemSculptService } from "../SystemSculptService";
import { ERROR_CODES, SystemSculptError } from "../../utils/errors";

var licenseService: any;
var modelManagementService: any;
var documentUploadService: any;
var audioUploadService: any;
var contextFileService: any;
var streamResponseMock: jest.Mock;
var agentStartOrContinueMock: jest.Mock;
var postJsonStreamingMock: jest.Mock;

jest.mock("../StreamingService", () => ({
  StreamingService: jest.fn().mockImplementation(() => {
    streamResponseMock = jest.fn(async function* () {
      yield { type: "content", text: "hello" } as any;
    });

    return {
      generateRequestId: jest.fn(() => "req-1"),
      streamResponse: streamResponseMock,
    };
  }),
}));

jest.mock("../LicenseService", () => ({
  LicenseService: jest.fn().mockImplementation(() => {
    licenseService = {
      validateLicense: jest.fn().mockResolvedValue(true),
      updateBaseUrl: jest.fn(),
    };
    return licenseService;
  }),
}));

jest.mock("../ModelManagementService", () => ({
  ModelManagementService: jest.fn().mockImplementation(() => {
    modelManagementService = {
      getModels: jest.fn().mockResolvedValue([]),
      getModelInfo: jest.fn(async (_modelId: string) => ({
        isCustom: true,
        provider: {
          id: "p1",
          name: "LM Studio",
          endpoint: "http://localhost:1234/v1",
          apiKey: "",
          isEnabled: true,
        },
        actualModelId: "local-model",
      })),
      preloadModels: jest.fn().mockResolvedValue(undefined),
      updateBaseUrl: jest.fn(),
    };
    return modelManagementService;
  }),
}));

jest.mock("../ContextFileService", () => ({
  ContextFileService: jest.fn().mockImplementation(() => {
    contextFileService = {
      prepareMessagesWithContext: jest.fn(async (messages: any[]) => messages),
    };
    return contextFileService;
  }),
}));

jest.mock("../DocumentUploadService", () => ({
  DocumentUploadService: jest.fn().mockImplementation(() => {
    documentUploadService = {
      uploadDocument: jest.fn().mockResolvedValue({ documentId: "doc", status: "ok" }),
      updateConfig: jest.fn(),
    };
    return documentUploadService;
  }),
}));

jest.mock("../AudioUploadService", () => ({
  AudioUploadService: jest.fn().mockImplementation(() => {
    audioUploadService = {
      uploadAudio: jest.fn().mockResolvedValue({ documentId: "audio", status: "ok" }),
      updateConfig: jest.fn(),
    };
    return audioUploadService;
  }),
}));

jest.mock("../../views/chatview/MCPService", () => ({
  MCPService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../agent-v2/AgentSessionClient", () => ({
  AgentSessionClient: jest.fn().mockImplementation(() => {
    agentStartOrContinueMock = jest.fn();
    return {
      startOrContinueTurn: agentStartOrContinueMock,
      updateConfig: jest.fn(),
    };
  }),
}));

jest.mock("../StreamingErrorHandler", () => ({
  StreamingErrorHandler: {
    handleStreamError: jest.fn(),
  },
}));

jest.mock("../api/SystemSculptEnvironment", () => ({
  SystemSculptEnvironment: {
    resolveBaseUrl: jest.fn(() => "https://api.systemsculpt.test/api/v1"),
  },
}));

jest.mock("../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      isMobile: jest.fn(() => false),
      supportsStreaming: jest.fn(() => true),
      preferredTransport: jest.fn(() => "fetch"),
    })),
  },
}));

jest.mock("../../utils/streaming", () => ({
  postJsonStreaming: (...args: any[]) => {
    if (!postJsonStreamingMock) {
      postJsonStreamingMock = jest.fn(async () => new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    }
    return postJsonStreamingMock(...args);
  },
  sanitizeFetchHeadersForUrl: jest.fn((url: string, headers: Record<string, string>) => headers),
}));

const createPlugin = () => {
  const app = new App();
  app.metadataCache.getFirstLinkpathDest = jest.fn(() => null);
  app.vault.getAbstractFileByPath = jest.fn(() => null);

  const adapter = {
    getChatEndpoint: jest.fn(() => "http://localhost:1234/v1/chat/completions"),
    getHeaders: jest.fn(() => ({})),
    buildRequestBody: jest.fn(() => ({
      model: "local-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })),
    transformStreamResponse: jest.fn(async (response: Response) => ({
      stream: response.body!,
      headers: { "Content-Type": "text/event-stream" },
    })),
  };

  return {
    app,
    settings: {
      serverUrl: "",
      licenseKey: "license",
      selectedModelId: "",
      embeddingsEnabled: false,
      workflowEngine: { templates: {} },
    },
    modelService: {
      getModels: jest.fn().mockResolvedValue([]),
    },
    customProviderService: {
      getProviderAdapter: jest.fn(() => adapter),
    },
    __adapter: adapter,
  } as any;
};

describe("SystemSculptService (custom provider streaming)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSculptService.clearInstance();
  });

  it("routes custom-provider model streaming through postJsonStreaming + adapter (not AgentSessionClient)", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const events: any[] = [];
    const stream = service.streamMessage({
      messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
      model: "lm studio@@local-model",
      agentMode: true,
      toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
      sessionId: "chat-1",
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(plugin.customProviderService.getProviderAdapter).toHaveBeenCalled();
    expect(postJsonStreamingMock).toHaveBeenCalled();
    expect(streamResponseMock).toHaveBeenCalledWith(
      expect.any(Response),
      expect.objectContaining({ isCustomProvider: true })
    );
    expect(agentStartOrContinueMock).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "content", text: "hello" }]);
  });

  it("retries with reduced context when the provider reports a context length overflow before any output", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    streamResponseMock
      .mockImplementationOnce(async function* () {
        throw new Error(
          "The number of tokens to keep from the initial prompt is greater than the context length."
        );
      })
      .mockImplementationOnce(async function* () {
        yield { type: "content", text: "ok" } as any;
      });

    const events: any[] = [];
    const stream = service.streamMessage({
      messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
      model: "lm studio@@local-model",
      agentMode: true,
      toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
      contextFiles: new Set(["a.md"]),
      sessionId: "chat-1",
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(postJsonStreamingMock).toHaveBeenCalledTimes(2);
    expect(streamResponseMock).toHaveBeenCalledTimes(2);

    // The retry should attempt to drop context files to fit the model's context window.
    const prepareCalls = (contextFileService.prepareMessagesWithContext as jest.Mock).mock.calls;
    expect(prepareCalls.length).toBeGreaterThanOrEqual(2);
    const firstContextFiles = prepareCalls[0]?.[1];
    const secondContextFiles = prepareCalls[1]?.[1];
    expect(firstContextFiles?.size).toBe(1);
    expect(secondContextFiles?.size).toBe(0);

    const contentEvents = events.filter((e) => e?.type === "content");
    expect(contentEvents).toEqual([{ type: "content", text: "ok" }]);
  });

  it("retries SystemSculpt PI turns on upstream rate-limit errors before any output", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    modelManagementService.getModelInfo.mockResolvedValue({
      isCustom: false,
      actualModelId: "systemsculpt/ai-agent",
    });

    streamResponseMock
      .mockImplementationOnce(async function* () {
        throw new SystemSculptError(
          "Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly.",
          ERROR_CODES.QUOTA_EXCEEDED,
          429,
          {
            shouldRetry: true,
            retryAfterSeconds: 0,
            isRateLimited: true,
          }
        );
      })
      .mockImplementationOnce(async function* () {
        yield { type: "content", text: "recovered" } as any;
      });

    agentStartOrContinueMock
      .mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
      .mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

    const events: any[] = [];
    const stream = service.streamMessage({
      messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
      model: "systemsculpt@@systemsculpt/ai-agent",
      agentMode: true,
      toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
      sessionId: "chat-1",
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(agentStartOrContinueMock).toHaveBeenCalledTimes(2);
    expect(streamResponseMock).toHaveBeenCalledTimes(2);
    expect(postJsonStreamingMock?.mock.calls.length ?? 0).toBe(0);
    expect(events.some((event) => event?.type === "meta" && event?.key === "inline-footnote")).toBe(true);
    const contentEvents = events.filter((e) => e?.type === "content");
    expect(contentEvents).toEqual([{ type: "content", text: "recovered" }]);
  });

  it("does not start a new PI turn after aborting during retry backoff", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    const abortController = new AbortController();

    modelManagementService.getModelInfo.mockResolvedValue({
      isCustom: false,
      actualModelId: "systemsculpt/ai-agent",
    });

    streamResponseMock
      .mockImplementationOnce(async function* () {
        throw new SystemSculptError(
          "Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly.",
          ERROR_CODES.QUOTA_EXCEEDED,
          429,
          {
            shouldRetry: true,
            retryAfterSeconds: 5,
            isRateLimited: true,
          }
        );
      })
      .mockImplementationOnce(async function* () {
        yield { type: "content", text: "unexpected-second-attempt" } as any;
      });

    agentStartOrContinueMock
      .mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
      .mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

    jest
      .spyOn(service as any, "waitForRetryWindow")
      .mockImplementation(async (_delayMs: number, signal?: AbortSignal) => {
        if (signal && !signal.aborted) {
          abortController.abort();
        }
      });

    const events: any[] = [];
    const stream = service.streamMessage({
      messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
      model: "systemsculpt@@systemsculpt/ai-agent",
      agentMode: true,
      toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
      sessionId: "chat-1",
      signal: abortController.signal,
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(agentStartOrContinueMock).toHaveBeenCalledTimes(1);
    const contentEvents = events.filter((e) => e?.type === "content");
    expect(contentEvents).toEqual([]);
    expect(events.some((event) => event?.type === "meta" && event?.key === "inline-footnote")).toBe(false);
  });

  it("does not start a new PI turn when abort arrives immediately after retry wait resolves", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    const abortController = new AbortController();

    modelManagementService.getModelInfo.mockResolvedValue({
      isCustom: false,
      actualModelId: "systemsculpt/ai-agent",
    });

    streamResponseMock
      .mockImplementationOnce(async function* () {
        throw new SystemSculptError(
          "Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly.",
          ERROR_CODES.QUOTA_EXCEEDED,
          429,
          {
            shouldRetry: true,
            retryAfterSeconds: 0,
            isRateLimited: true,
          }
        );
      })
      .mockImplementationOnce(async function* () {
        yield { type: "content", text: "unexpected-second-attempt" } as any;
      });

    agentStartOrContinueMock
      .mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
      .mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

    const originalWaitForRetryWindow = (service as any).waitForRetryWindow.bind(service);
    let waitCallCount = 0;
    jest
      .spyOn(service as any, "waitForRetryWindow")
      .mockImplementation(async (delayMs: number, signal?: AbortSignal) => {
        waitCallCount += 1;
        // Simulate the user aborting right after the backoff wait resolves.
        if (waitCallCount === 1) {
          setTimeout(() => abortController.abort(), 0);
          return;
        }
        await originalWaitForRetryWindow(delayMs, signal);
      });

    const events: any[] = [];
    const stream = service.streamMessage({
      messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
      model: "systemsculpt@@systemsculpt/ai-agent",
      agentMode: true,
      toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
      sessionId: "chat-1",
      signal: abortController.signal,
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(agentStartOrContinueMock).toHaveBeenCalledTimes(1);
    const contentEvents = events.filter((e) => e?.type === "content");
    expect(contentEvents).toEqual([]);
  });

  it("does not retry PI turns for non-transient quota exhaustion errors", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    modelManagementService.getModelInfo.mockResolvedValue({
      isCustom: false,
      actualModelId: "systemsculpt/ai-agent",
    });

    streamResponseMock.mockImplementationOnce(async function* () {
      throw new SystemSculptError(
        "Quota exhausted. Add credits to continue.",
        ERROR_CODES.QUOTA_EXCEEDED,
        402
      );
    });

    agentStartOrContinueMock.mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const run = async () => {
      const stream = service.streamMessage({
        messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
        model: "systemsculpt@@systemsculpt/ai-agent",
        agentMode: true,
        toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
        sessionId: "chat-1",
      });

      for await (const _event of stream) {
      }
    };

    await expect(run()).rejects.toBeInstanceOf(SystemSculptError);
    expect(agentStartOrContinueMock).toHaveBeenCalledTimes(1);
    expect(streamResponseMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry PI turns for hard-quota 429 responses", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    modelManagementService.getModelInfo.mockResolvedValue({
      isCustom: false,
      actualModelId: "systemsculpt/ai-agent",
    });

    streamResponseMock.mockImplementationOnce(async function* () {
      throw new SystemSculptError(
        "OpenAI provider error: insufficient_quota. Add credits to continue.",
        ERROR_CODES.QUOTA_EXCEEDED,
        429,
        {
          statusCode: 429,
          upstreamMessage: "insufficient_quota",
        }
      );
    });

    agentStartOrContinueMock.mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const run = async () => {
      const stream = service.streamMessage({
        messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
        model: "systemsculpt@@systemsculpt/ai-agent",
        agentMode: true,
        toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
        sessionId: "chat-1",
      });

      for await (const _event of stream) {
      }
    };

    await expect(run()).rejects.toBeInstanceOf(SystemSculptError);
    expect(agentStartOrContinueMock).toHaveBeenCalledTimes(1);
    expect(streamResponseMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry SystemSculpt PI turns once output has already streamed", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    modelManagementService.getModelInfo.mockResolvedValue({
      isCustom: false,
      actualModelId: "systemsculpt/ai-agent",
    });

    streamResponseMock.mockImplementationOnce(async function* () {
      yield { type: "content", text: "partial" } as any;
      throw new SystemSculptError(
        "Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly.",
        ERROR_CODES.QUOTA_EXCEEDED,
        429,
        {
          shouldRetry: true,
          retryAfterSeconds: 0,
          isRateLimited: true,
        }
      );
    });

    agentStartOrContinueMock.mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const events: any[] = [];
    const run = async () => {
      const stream = service.streamMessage({
        messages: [{ role: "user", content: "hi", message_id: "u1" } as any],
        model: "systemsculpt@@systemsculpt/ai-agent",
        agentMode: true,
        toolCallManager: { getOpenAITools: jest.fn().mockResolvedValue([]) },
        sessionId: "chat-1",
      });

      for await (const event of stream) {
        events.push(event);
      }
    };

    await expect(run()).rejects.toBeInstanceOf(SystemSculptError);
    expect(agentStartOrContinueMock).toHaveBeenCalledTimes(1);
    expect(streamResponseMock).toHaveBeenCalledTimes(1);
    const contentEvents = events.filter((e) => e?.type === "content");
    expect(contentEvents).toEqual([{ type: "content", text: "partial" }]);
  });
});
