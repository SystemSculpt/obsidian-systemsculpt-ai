import { App, TFile } from "obsidian";
import { SystemSculptService } from "../SystemSculptService";
import { PlatformContext } from "../PlatformContext";
import { SystemSculptEnvironment } from "../api/SystemSculptEnvironment";
import { DebugLogger } from "../../utils/debugLogger";
import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { deterministicId } from "../../utils/id";

const licenseService = {
  validateLicense: jest.fn().mockResolvedValue(true),
  updateBaseUrl: jest.fn(),
};
const modelManagementService = {
  getModels: jest.fn().mockResolvedValue([]),
  getModelInfo: jest.fn(async (modelId: string) => ({
    isCustom: false,
    actualModelId: modelId,
  })),
  preloadModels: jest.fn().mockResolvedValue(undefined),
  updateBaseUrl: jest.fn(),
};
const documentUploadService = {
  uploadDocument: jest.fn().mockResolvedValue({ documentId: "doc", status: "ok" }),
  updateConfig: jest.fn(),
};
const audioUploadService = {
  uploadAudio: jest.fn().mockResolvedValue({ documentId: "audio", status: "ok" }),
  updateBaseUrl: jest.fn(),
};
const contextFileService = {
  prepareMessagesWithContext: jest.fn(async (messages: any[]) => messages),
};

jest.mock("../StreamingService", () => ({
  StreamingService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../LicenseService", () => ({
  LicenseService: jest.fn().mockImplementation(() => licenseService),
}));

jest.mock("../ModelManagementService", () => ({
  ModelManagementService: jest.fn().mockImplementation(() => modelManagementService),
}));

jest.mock("../ContextFileService", () => ({
  ContextFileService: jest.fn().mockImplementation(() => contextFileService),
}));

jest.mock("../DocumentUploadService", () => ({
  DocumentUploadService: jest.fn().mockImplementation(() => documentUploadService),
}));

jest.mock("../AudioUploadService", () => ({
  AudioUploadService: jest.fn().mockImplementation(() => audioUploadService),
}));

jest.mock("../../views/chatview/MCPService", () => ({
  MCPService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../utils/debugLogger", () => ({
  DebugLogger: {
    getInstance: jest.fn().mockReturnValue({
      logAPIRequest: jest.fn(),
    }),
  },
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
      supportsStreaming: jest.fn(() => false),
      preferredTransport: jest.fn(() => "fetch"),
    })),
  },
}));

jest.mock("../../utils/streaming", () => ({
  postJsonStreaming: jest.fn(async () => new Response("{}", { status: 200 })),
  sanitizeFetchHeadersForUrl: jest.fn((url: string, headers: Record<string, string>) => headers),
}));

const createPlugin = () => {
  const app = new App();
  app.metadataCache.getFirstLinkpathDest = jest.fn(() => null);
  app.vault.getAbstractFileByPath = jest.fn(() => null);

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
      getProviderAdapter: jest.fn(() => ({
        getChatEndpoint: jest.fn(() => "https://custom.endpoint/chat"),
        getHeaders: jest.fn(() => ({})),
        buildRequestBody: jest.fn(() => ({
          messages: [],
          stream: false,
        })),
        transformStreamResponse: jest.fn(async (response) => ({
          stream: response.body,
          headers: response.headers,
        })),
      })),
    },
  } as any;
};

describe("SystemSculptService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSculptService.clearInstance();
  });

  it("initializes with resolved base url and updates sub-services", () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");

    plugin.settings.serverUrl = "https://new.endpoint";
    service.updateSettings(plugin.settings);

    expect(licenseService.updateBaseUrl).toHaveBeenCalled();
    expect(modelManagementService.updateBaseUrl).toHaveBeenCalled();
    expect(documentUploadService.updateConfig).toHaveBeenCalled();
    expect(audioUploadService.updateBaseUrl).toHaveBeenCalled();
  });

  it("normalizes vendor model ids for the server", () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    expect((service as any).normalizeServerModelId("openai/gpt-4o")).toBe("openrouter/openai/gpt-4o");
    expect((service as any).normalizeServerModelId("openrouter/openai/gpt-4o")).toBe("openrouter/openai/gpt-4o");
    expect((service as any).normalizeServerModelId("groq/openai/gpt-4o")).toBe("groq/openai/gpt-4o");
    expect((service as any).normalizeServerModelId("custom-model")).toBe("custom-model");
  });

  it("counts image context files", () => {
    const plugin = createPlugin();
    const imageFile = new TFile({ path: "assets/image.png", name: "image.png", extension: "png" });
    plugin.app.metadataCache.getFirstLinkpathDest = jest.fn((path: string) =>
      path === "image.png" ? imageFile : null
    );

    const service = SystemSculptService.getInstance(plugin);
    const count = (service as any).countImageContextFiles(
      new Set(["[[image.png]]", "doc:example.pdf", "notes.md"])
    );

    expect(count).toBe(1);
  });

  it("delegates license validation and model retrieval", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    await service.validateLicense(true);
    await service.getModels();

    expect(licenseService.validateLicense).toHaveBeenCalled();
    expect(modelManagementService.getModels).toHaveBeenCalled();
  });

  it("delegates document and audio uploads", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    await service.uploadDocument(new TFile({ path: "doc.pdf", name: "doc.pdf" }));
    await service.uploadAudio(new TFile({ path: "audio.wav", name: "audio.wav" }));

    expect(documentUploadService.uploadDocument).toHaveBeenCalled();
    expect(audioUploadService.uploadAudio).toHaveBeenCalled();
  });

  it("adds required entries for all tool properties in systemsculpt requests", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    const toolCallManager = {
      getOpenAITools: jest.fn().mockResolvedValue([
        {
          type: "function",
          function: {
            name: "mcp-filesystem_read",
            description: "Read",
            parameters: {
              properties: {
                paths: { type: "array" },
                offset: { type: "number" },
                length: { type: "number" },
              },
            },
          },
        },
      ]),
    };

    const { requestBody } = await service.buildRequestPreview({
      messages: [],
      model: "systemsculpt/ai-agent",
      agentMode: true,
      toolCallManager,
    });

    const required = requestBody.tools[0].function.parameters.required;
    expect(requestBody.tools[0].function.parameters.type).toBe("object");
    expect(required).toEqual(expect.arrayContaining(["paths", "offset", "length"]));
    expect(requestBody.tools[0].function.strict).toBeUndefined();
  });

  it("includes session_id in request preview when provided", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const { requestBody } = await service.buildRequestPreview({
      messages: [],
      model: "systemsculpt/ai-agent",
      sessionId: "chat-123",
    });

    expect(requestBody.session_id).toBe(deterministicId("chat-123", "sess"));
  });

  it("handles custom provider completion", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    global.fetch = jest.fn().mockResolvedValue(response) as any;

    const result = await (service as any).handleCustomProviderCompletion(
      { id: "custom", name: "Custom", type: "openai-compatible" },
      [],
      "model",
      []
    );

    expect(DebugLogger.getInstance).toHaveBeenCalled();
    expect(StreamingErrorHandler.handleStreamError).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it("retries OpenRouter custom provider on provider-level 429", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    (plugin.customProviderService.getProviderAdapter as jest.Mock).mockReturnValue({
      getChatEndpoint: jest.fn(() => "https://openrouter.ai/api/v1/chat/completions"),
      getHeaders: jest.fn(() => ({
        Authorization: "Bearer key",
        "HTTP-Referer": "https://systemsculpt.com",
        "X-Title": "SystemSculpt AI",
      })),
      buildRequestBody: jest.fn((messages: any[], modelId: string) => ({
        model: modelId,
        messages,
        stream: false,
        tools: [
          {
            type: "function",
            function: { name: "noop", description: "noop", parameters: { type: "object", properties: {} } },
          },
        ],
      })),
      transformStreamResponse: jest.fn(async (response: Response) => ({
        stream: response.body,
        headers: response.headers,
      })),
    });

    const chatBodies: any[] = [];
    global.fetch = jest.fn(async (url: string, options?: any) => {
      if (url.includes("/models/moonshotai/kimi-k2.5/endpoints")) {
        return new Response(
          JSON.stringify({
            data: {
              endpoints: [
                {
                  tag: "fireworks",
                  provider_name: "Fireworks",
                  supported_parameters: ["tools"],
                  status: 0,
                },
                {
                  tag: "novita",
                  provider_name: "Novita",
                  supported_parameters: ["tools"],
                  status: -2,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (options?.body) {
        chatBodies.push(JSON.parse(String(options.body)));
      }

      // First attempt: provider-level rate limit from Fireworks
      if (chatBodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Provider returned error",
              code: 429,
              metadata: {
                provider_name: "Fireworks",
                raw: "moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly.",
              },
            },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const result = await (service as any).handleCustomProviderCompletion(
      { id: "openrouter", name: "OpenRouter", type: "openai-compatible", endpoint: "https://openrouter.ai/api/v1", apiKey: "key" },
      [],
      "moonshotai/kimi-k2.5",
      []
    );

    expect(result.status).toBe(200);
    expect(chatBodies.length).toBe(2);
    expect(chatBodies[0].provider).toBeUndefined();
    expect(chatBodies[1].provider?.order).toEqual(["novita"]);
  });

  it("uses development base url when configured", () => {
    (SystemSculptEnvironment.resolveBaseUrl as jest.Mock).mockReturnValueOnce("https://api.systemsculpt.test/api/v1");
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");
  });
});
