import {
  buildStudioPiLoginCommand,
  listStudioPiProviderAuthRecords,
  listStudioLocalTextModelOptions,
  migrateStudioPiProviderApiKeys,
  normalizeStudioLocalPiModelId,
  runStudioLocalPiTextGeneration,
} from "../StudioLocalTextModelCatalog";
import { PiRpcProcessClient } from "../../services/pi/PiRpcProcessClient";

jest.mock("../../services/pi-native/PiLocalAgentExecutor", () => ({
  runPiLocalTextGeneration: jest.fn(),
}));

jest.mock("../../services/pi/PiRpcProcessClient", () => ({
  PiRpcProcessClient: jest.fn(),
}));

const PiRpcProcessClientMock = PiRpcProcessClient as jest.MockedClass<typeof PiRpcProcessClient>;

describe("StudioLocalTextModelCatalog", () => {
  const plugin = {
    app: {
      vault: {
        adapter: {
          getBasePath: () => "/tmp",
        },
      },
    },
  } as any;

  beforeEach(() => {
    PiRpcProcessClientMock.mockReset();
  });

  it("maps Pi's available model catalog into searchable local model options", async () => {
    PiRpcProcessClientMock.mockImplementation(
      () =>
        ({
          start: jest.fn().mockResolvedValue(undefined),
          stop: jest.fn().mockResolvedValue(undefined),
          getAvailableModels: jest.fn().mockResolvedValue([
        {
          provider: "openai",
          id: "gpt-5",
          name: "gpt-5",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          provider: "google-antigravity",
          id: "gpt-oss-120b-medium",
          name: "gpt-oss-120b-medium",
          contextWindow: 131_100,
          maxTokens: 32_800,
          reasoning: false,
          input: ["text"],
        },
        {
          provider: "openai-codex",
          id: "gpt-5.2-codex",
          name: "gpt-5.2-codex",
          contextWindow: 272_000,
          maxTokens: 128_000,
          reasoning: true,
          input: ["text", "image"],
        },
          ]),
        }) as any
    );

    const options = await listStudioLocalTextModelOptions(plugin);

    expect(PiRpcProcessClientMock).toHaveBeenCalledTimes(1);
    expect(options).toEqual([
      {
        value: "google-antigravity/gpt-oss-120b-medium",
        label: "gpt-oss-120b-medium",
        description: "context 131.1K • max out 32.8K • thinking no • images no",
        badge: "google-antigravity",
        keywords: [
          "google-antigravity/gpt-oss-120b-medium",
          "google-antigravity",
          "gpt-oss-120b-medium",
          "131.1K",
          "32.8K",
          "no",
        ],
      },
      {
        value: "openai/gpt-5",
        label: "gpt-5",
        description: "context 400K • max out 128K • thinking yes • images yes",
        badge: "openai",
        keywords: ["openai/gpt-5", "openai", "gpt-5", "400K", "128K", "yes"],
      },
      {
        value: "openai-codex/gpt-5.2-codex",
        label: "gpt-5.2-codex",
        description: "context 272K • max out 128K • thinking yes • images yes",
        badge: "openai-codex",
        keywords: [
          "openai-codex/gpt-5.2-codex",
          "openai-codex",
          "gpt-5.2-codex",
          "272K",
          "128K",
          "yes",
        ],
      },
    ]);
  });

  it("throws an actionable error when the Pi SDK catalog lookup fails", async () => {
    PiRpcProcessClientMock.mockImplementation(
      () =>
        ({
          start: jest.fn().mockResolvedValue(undefined),
          stop: jest.fn().mockResolvedValue(undefined),
          getAvailableModels: jest.fn().mockRejectedValue(new Error("Pi SDK unavailable")),
        }) as any
    );

    await expect(listStudioLocalTextModelOptions(plugin)).rejects.toThrow(
      "Pi SDK unavailable"
    );
  });

  it("normalizes local pi model IDs from canonical and provider/model forms", () => {
    expect(normalizeStudioLocalPiModelId("google@@gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(normalizeStudioLocalPiModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
    expect(() => normalizeStudioLocalPiModelId("bad-model-id")).toThrow(
      'Choose a model in "provider/model" format.'
    );
  });

  it("builds provider login command with safe provider normalization", () => {
    expect(buildStudioPiLoginCommand("github-copilot")).toBe("pi /login github-copilot");
    expect(buildStudioPiLoginCommand("  OpenAI-Codex  ")).toBe("pi /login openai-codex");
    expect(buildStudioPiLoginCommand("bad provider!")).toBe("pi /login");
  });

  it("lists provider auth records with credential metadata but no secrets", async () => {
    const credentials: Record<string, any> = {
      "openai-codex": {
        type: "oauth",
        expires: 1_733_071_111_000,
      },
      openai: {
        type: "api_key",
      },
    };
    const storage = {
      getOAuthProviders: () => [
        { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
      ],
      login: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      get: (provider: string) => credentials[provider],
      hasAuth: (provider: string) => provider in credentials || provider === "openrouter",
      has: (provider: string) => provider in credentials,
      list: () => Object.keys(credentials),
    } as any;

    const records = await listStudioPiProviderAuthRecords(
      {
        providerHints: ["openrouter", "bad provider!"],
      },
      storage
    );

    const codex = records.find((record) => record.provider === "openai-codex");
    expect(codex).toBeDefined();
    expect(codex?.source).toBe("oauth");
    expect(codex?.credentialType).toBe("oauth");
    expect(codex?.supportsOAuth).toBe(true);
    expect(codex?.displayName).toBe("OpenAI Codex");
    expect(codex?.oauthExpiresAt).toBe(1_733_071_111_000);

    const openai = records.find((record) => record.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.source).toBe("api_key");
    expect(openai?.credentialType).toBe("api_key");

    const openrouter = records.find((record) => record.provider === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter?.source).toBe("environment_or_fallback");
    expect(openrouter?.hasStoredCredential).toBe(false);
    expect(openrouter?.credentialType).toBe("none");
  });

  it("backfills known provider labels and OAuth support from the registry when Pi runtime metadata is absent", async () => {
    const storage = {
      getOAuthProviders: () => [],
      login: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      get: () => undefined,
      hasAuth: () => false,
      has: () => false,
      list: () => ["openai-codex", "anthropic", "openai"],
    } as any;

    const records = await listStudioPiProviderAuthRecords({}, storage);

    expect(records.find((record) => record.provider === "openai-codex")).toEqual(
      expect.objectContaining({
        displayName: "OpenAI Codex (ChatGPT OAuth)",
        supportsOAuth: true,
      })
    );
    expect(records.find((record) => record.provider === "anthropic")).toEqual(
      expect.objectContaining({
        displayName: "Anthropic",
        supportsOAuth: true,
      })
    );
    expect(records.find((record) => record.provider === "openai")).toEqual(
      expect.objectContaining({
        displayName: "OpenAI",
        supportsOAuth: false,
      })
    );
  });

  it("migrates API keys idempotently and skips existing credentials", async () => {
    const credentials: Record<string, any> = {
      "openai-codex": {
        type: "oauth",
      },
      openai: {
        type: "api_key",
      },
    };
    const storage = {
      getOAuthProviders: () => [],
      login: jest.fn(),
      set: jest.fn((provider: string, credential: any) => {
        credentials[provider] = credential;
      }),
      remove: jest.fn(),
      get: (provider: string) => credentials[provider],
      hasAuth: (provider: string) => provider in credentials,
      has: (provider: string) => provider in credentials,
      list: () => Object.keys(credentials),
    } as any;

    const report = await migrateStudioPiProviderApiKeys(
      [
        { providerId: "openai", apiKey: "sk-existing", origin: "provider:openai" },
        { providerId: "openai-codex", apiKey: "oauth-should-skip", origin: "provider:openai-codex" },
        { providerId: "minimax", apiKey: "mm-new-key", origin: "provider:minimax" },
        { providerId: "anthropic", apiKey: "   ", origin: "provider:anthropic" },
        { providerId: "bad provider!", apiKey: "broken", origin: "provider:broken" },
      ],
      storage
    );

    expect(report.migrated).toEqual([
      {
        provider: "minimax",
        origin: "provider:minimax",
      },
    ]);
    expect(credentials.minimax).toEqual({
      type: "api_key",
      key: "mm-new-key",
    });
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "openai", reason: "existing_api_key" }),
        expect.objectContaining({ provider: "openai-codex", reason: "existing_oauth" }),
        expect.objectContaining({ provider: "anthropic", reason: "empty_key" }),
        expect.objectContaining({ provider: "bad provider!", reason: "invalid_provider" }),
      ])
    );
    expect(report.errors).toEqual([]);
  });

  it("delegates local text generation to the native Pi agent executor", async () => {
    const { runPiLocalTextGeneration } = jest.requireMock("../../services/pi-native/PiLocalAgentExecutor") as {
      runPiLocalTextGeneration: jest.Mock;
    };
    runPiLocalTextGeneration.mockResolvedValue({
      text: "hello local pi",
      modelId: "google/gemini-2.5-flash",
    });

    const result = await runStudioLocalPiTextGeneration({
      plugin,
      modelId: "google/gemini-2.5-flash",
      prompt: "Say hello",
      systemPrompt: "Be brief",
      reasoningEffort: "xhigh",
    } as any);

    expect(runPiLocalTextGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin,
        modelId: "google/gemini-2.5-flash",
        prompt: "Say hello",
        systemPrompt: "Be brief",
      })
    );
    expect(result).toEqual({
      text: "hello local pi",
      modelId: "google/gemini-2.5-flash",
    });
  });
});
