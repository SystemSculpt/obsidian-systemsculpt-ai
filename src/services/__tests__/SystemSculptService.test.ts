import { App, TFile } from "obsidian";
import { SystemSculptService } from "../SystemSculptService";
import { resolvePiTextExecutionPlan } from "../pi-native/PiTextRuntime";
import { executeLocalPiStream } from "../LocalPiStreamExecutor";
import { SystemSculptEnvironment } from "../api/SystemSculptEnvironment";

const licenseService = {
  validateLicense: jest.fn().mockResolvedValue(true),
  updateBaseUrl: jest.fn(),
};
const modelManagementService = {
  getModels: jest.fn().mockResolvedValue([]),
  getModelInfo: jest.fn(async (modelId: string) => ({
    isCustom: false,
    actualModelId: modelId.includes("@@") ? modelId.replace("@@", "/") : modelId,
    modelSource: "pi_local",
    model: {
      id: modelId,
      provider: modelId.split("@@")[0] || modelId.split("/")[0] || "openai",
      piExecutionModelId: modelId.includes("@@") ? modelId.replace("@@", "/") : modelId,
      piRemoteAvailable: false,
      piLocalAvailable: true,
      piAuthMode: "local",
    },
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

jest.mock("../PromptBuilder", () => ({
  PromptBuilder: {
    buildSystemPrompt: jest.fn().mockResolvedValue("System prompt"),
  },
}));

jest.mock("../LocalPiStreamExecutor", () => ({
  executeLocalPiStream: jest.fn(),
}));

jest.mock("../pi-native/PiTextRuntime", () => ({
  resolvePiTextExecutionPlan: jest.fn(),
}));

jest.mock("../../utils/debugLogger", () => ({
  DebugLogger: {
    getInstance: jest.fn().mockReturnValue({
      logAPIRequest: jest.fn(),
    }),
  },
}));

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
    error: jest.fn(),
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

const createPlugin = () => {
  const app = new App();
  app.metadataCache.getFirstLinkpathDest = jest.fn(() => null);
  app.vault.getAbstractFileByPath = jest.fn(() => null);

  return {
    app,
    manifest: {
      version: "4.13.0",
    },
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
  } as any;
};

async function collectEvents(generator: AsyncGenerator<any, void, unknown>) {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("SystemSculptService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSculptService.clearInstance();
    (resolvePiTextExecutionPlan as jest.Mock).mockResolvedValue({
      mode: "local",
      actualModelId: "openai/gpt-4o",
    });
  });

  it("initializes with the resolved base url and updates dependent services", () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");

    plugin.settings.serverUrl = "https://new.endpoint";
    service.updateSettings(plugin.settings);

    expect(licenseService.updateBaseUrl).toHaveBeenCalled();
    expect(modelManagementService.updateBaseUrl).toHaveBeenCalled();
    expect(documentUploadService.updateConfig).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1",
      "license",
      "4.13.0"
    );
    expect(audioUploadService.updateConfig).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1",
      "license"
    );
  });

  it("builds local Pi request previews from the prepared chat payload", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const { requestBody, preparedMessages, actualModelId } = await service.buildRequestPreview({
      messages: [{ role: "user", content: "Hello", message_id: "msg_1" } as any],
      model: "openai@@gpt-4o",
    });

    expect(resolvePiTextExecutionPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "openai@@gpt-4o",
        piExecutionModelId: "openai/gpt-4o",
      })
    );
    expect(requestBody).toEqual({
      modelId: "openai/gpt-4o",
      context: {
        messages: preparedMessages,
      },
      transport: "pi-rpc",
    });
    expect(actualModelId).toBe("openai/gpt-4o");
  });

  it("delegates streaming to the local Pi executor with session metadata", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    const onPiSessionReady = jest.fn();
    const streamed = [
      { type: "meta", key: "inline-footnote", value: "Running through Pi RPC session." },
      { type: "content", text: "hello" },
    ];

    (executeLocalPiStream as jest.Mock).mockImplementation(async function* (input: any) {
      expect(input.sessionFile).toBe("/tmp/pi-session.jsonl");
      expect(input.onSessionReady).toBe(onPiSessionReady);
      expect(input.prepared.actualModelId).toBe("openai/gpt-4o");
      for (const event of streamed) {
        yield event;
      }
    });

    const events = await collectEvents(
      service.streamMessage({
        messages: [{ role: "user", content: "Hello", message_id: "msg_1" } as any],
        model: "openai@@gpt-4o",
        sessionFile: "/tmp/pi-session.jsonl",
        onPiSessionReady,
      })
    );

    expect(events).toEqual(streamed);
    expect(executeLocalPiStream).toHaveBeenCalledTimes(1);
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

  it("delegates license validation, model retrieval, and uploads", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    await service.validateLicense(true);
    await service.getModels();
    await service.uploadDocument(new TFile({ path: "doc.pdf", name: "doc.pdf" }));
    await service.uploadAudio(new TFile({ path: "audio.wav", name: "audio.wav" }));

    expect(licenseService.validateLicense).toHaveBeenCalledWith(true);
    expect(modelManagementService.getModels).toHaveBeenCalled();
    expect(documentUploadService.uploadDocument).toHaveBeenCalled();
    expect(audioUploadService.uploadAudio).toHaveBeenCalled();
  });

  it("fetches credits balance from the SystemSculpt API", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
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
      )
    ) as any;

    const balance = await service.getCreditsBalance();

    expect(balance).toMatchObject({
      totalRemaining: 9000,
      includedPerMonth: 10000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
    });
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

  it("parses annual upgrade savings details from the credits balance", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
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
      )
    ) as any;

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

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
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
      )
    ) as any;

    const usage = await service.getCreditsUsage({
      limit: 25,
      before: "2026-02-12T00:00:00.000Z",
      endpoints: ["audio/transcriptions/jobs/start"],
    });

    expect(usage.items).toHaveLength(1);
    expect(usage.items[0]).toMatchObject({
      endpoint: "audio/transcriptions/jobs/start",
      creditsCharged: 3,
      rawUsd: 0.002553,
      billingCreditsExact: 2.553,
    });
    expect((usage.items[0] as any)?.provider).toBeUndefined();
    expect((usage.items[0] as any)?.model).toBeUndefined();
    expect(usage.nextBefore).toBe("2026-02-11T00:00:00.000Z");
  });

  it("uses the development-aware API base url helper", () => {
    (SystemSculptEnvironment.resolveBaseUrl as jest.Mock).mockReturnValueOnce(
      "https://api.systemsculpt.test/api/v1"
    );
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");
  });
});
