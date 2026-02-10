import { App } from "obsidian";
import { SystemSculptService } from "../SystemSculptService";

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
      updateBaseUrl: jest.fn(),
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
});
