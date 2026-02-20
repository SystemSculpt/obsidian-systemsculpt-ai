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
  updateConfig: jest.fn(),
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
    buildHeaders: jest.fn((licenseKey?: string) => ({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-SystemSculpt-Client": "obsidian-plugin",
      ...(licenseKey ? { "x-license-key": licenseKey } : {}),
    })),
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
    expect(audioUploadService.updateConfig).toHaveBeenCalled();
    expect(audioUploadService.updateConfig).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1",
      "license"
    );
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

  it("forwards agent request headers through requestAgentV2", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    global.fetch = jest.fn().mockResolvedValue(response) as any;

    await (service as any).requestAgentV2({
      url: "https://api.systemsculpt.com/api/v1/agent/sessions",
      method: "POST",
      headers: {
        "x-plugin-version": "4.8.1",
      },
      body: { modelId: "systemsculpt/ai-agent" },
      stream: false,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.systemsculpt.com/api/v1/agent/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-license-key": "license",
          "x-plugin-version": "4.8.1",
        }),
      })
    );
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

  it("fetches credits balance from the SystemSculpt API", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const response = new Response(
      JSON.stringify({
        included_remaining: 9000,
        add_on_remaining: 0,
        total_remaining: 9000,
        included_per_month: 10000,
        cycle_anchor_at: "2026-02-01T00:00:00.000Z",
        cycle_started_at: "2026-02-01T00:00:00.000Z",
        cycle_ends_at: "2026-03-01T00:00:00.000Z",
        turn_in_flight_until: null,
        purchase_url: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    global.fetch = jest.fn().mockResolvedValue(response) as any;

    const balance = await service.getCreditsBalance();
    expect(balance.totalRemaining).toBe(9000);
    expect(balance.includedPerMonth).toBe(10000);
    expect(balance.cycleEndsAt).toBe("2026-03-01T00:00:00.000Z");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1/credits/balance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-license-key": "license",
        }),
      })
    );
  });

  it("parses annual upgrade savings details from credits balance", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const response = new Response(
      JSON.stringify({
        included_remaining: 9000,
        add_on_remaining: 0,
        total_remaining: 9000,
        included_per_month: 10000,
        cycle_anchor_at: "2026-02-01T00:00:00.000Z",
        cycle_started_at: "2026-02-01T00:00:00.000Z",
        cycle_ends_at: "2026-03-01T00:00:00.000Z",
        turn_in_flight_until: null,
        purchase_url: null,
        billing_cycle: "monthly",
        annual_upgrade_offer: {
          amount_saved_cents: 12900,
          percent_saved: 57,
          annual_price_cents: 9900,
          monthly_equivalent_annual_cents: 22800,
          checkout_path: "/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    global.fetch = jest.fn().mockResolvedValue(response) as any;

    const balance = await service.getCreditsBalance();

    expect(balance.billingCycle).toBe("monthly");
    expect(balance.annualUpgradeOffer).toEqual({
      amountSavedCents: 12900,
      percentSaved: 57,
      annualPriceCents: 9900,
      monthlyEquivalentAnnualCents: 22800,
      checkoutUrl: "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
    });
  });

  it("fetches credits usage history from the SystemSculpt API", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const response = new Response(
      JSON.stringify({
        items: [
          {
            id: "tx_1",
            created_at: "2026-02-11T00:00:00.000Z",
            transaction_type: "agent_turn",
            endpoint: "audio/transcriptions/jobs/start",
            usage_kind: "audio_transcription",
            provider: "groq",
            model: "whisper-large-v3",
            duration_seconds: 23,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            page_count: 0,
            credits_charged: 3,
            included_delta: -3,
            add_on_delta: 0,
            total_delta: -3,
            included_before: 100,
            included_after: 97,
            add_on_before: 0,
            add_on_after: 0,
            total_before: 100,
            total_after: 97,
            raw_usd: 0.002553,
            file_size_bytes: 48203,
            file_format: "wav",
            billing_formula_version: "raw_usd_x_markup_x_credits_per_usd.ceil.v1",
            billing_credits_per_usd: 800,
            billing_markup_multiplier: 1.25,
            billing_credits_exact: 2.553,
          },
        ],
        next_before: "2026-02-11T00:00:00.000Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    global.fetch = jest.fn().mockResolvedValue(response) as any;

    const usage = await service.getCreditsUsage({
      limit: 25,
      before: "2026-02-12T00:00:00.000Z",
      endpoints: ["audio/transcriptions/jobs/start"],
    });

    expect(usage.items).toHaveLength(1);
    expect(usage.items[0]?.endpoint).toBe("audio/transcriptions/jobs/start");
    expect(usage.items[0]?.creditsCharged).toBe(3);
    expect(usage.items[0]?.rawUsd).toBe(0.002553);
    expect(usage.items[0]?.billingCreditsExact).toBe(2.553);
    expect(usage.nextBefore).toBe("2026-02-11T00:00:00.000Z");

    const [requestedUrl] = (global.fetch as jest.Mock).mock.calls[0] ?? [];
    expect(String(requestedUrl)).toContain("https://api.systemsculpt.test/api/v1/credits/usage?");
    expect(String(requestedUrl)).toContain("limit=25");
    expect(String(requestedUrl)).toContain("before=2026-02-12T00%3A00%3A00.000Z");
    expect(String(requestedUrl)).toContain("endpoint=audio%2Ftranscriptions%2Fjobs%2Fstart");
  });

  it("uses development base url when configured", () => {
    (SystemSculptEnvironment.resolveBaseUrl as jest.Mock).mockReturnValueOnce("https://api.systemsculpt.test/api/v1");
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");
  });
});
