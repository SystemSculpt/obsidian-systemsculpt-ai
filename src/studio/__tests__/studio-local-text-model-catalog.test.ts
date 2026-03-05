import {
  buildStudioPiLoginCommand,
  listStudioPiProviderAuthRecords,
  listStudioLocalTextModelOptions,
  migrateStudioPiProviderApiKeys,
  normalizeStudioLocalPiModelId,
  runStudioLocalPiTextGeneration,
  type PiCommandResult,
  type StudioPiCommandRunner,
} from "../StudioLocalTextModelCatalog";

function createPiRunner(result: PiCommandResult): jest.MockedFunction<StudioPiCommandRunner> {
  return jest.fn(async () => result);
}

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

  it("maps pi --list-models output into searchable local model options", async () => {
    const runCommand = createPiRunner({
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: [
        "provider            model                       context  max-out  thinking  images",
        "openai              gpt-5                       400K     128K     yes       yes",
        "google-antigravity  gpt-oss-120b-medium        131.1K   32.8K    no        no",
        "openai-codex        gpt-5.2-codex              272K     128K     yes       yes",
      ].join("\n"),
    });

    const options = await listStudioLocalTextModelOptions(plugin, runCommand);

    expect(runCommand).toHaveBeenCalledWith(plugin, ["--list-models"], 60_000);
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
          "no",
        ],
      },
      {
        value: "openai/gpt-5",
        label: "gpt-5",
        description: "context 400K • max out 128K • thinking yes • images yes",
        badge: "openai",
        keywords: ["openai/gpt-5", "openai", "gpt-5", "400K", "128K", "yes", "yes"],
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
          "yes",
        ],
      },
    ]);
  });

  it("throws an actionable error when pi model listing fails", async () => {
    const runCommand = createPiRunner({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "pi: command not found",
    });

    await expect(listStudioLocalTextModelOptions(plugin, runCommand)).rejects.toThrow(
      "pi: command not found"
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

  it("executes local pi text generation and parses ndjson assistant output", async () => {
    const runCommand = createPiRunner({
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: [
        "Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.",
        '{"type":"session","version":3}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello local pi"}],"stopReason":"stop"}}',
        '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"hello local pi"}],"stopReason":"stop"}]}',
      ].join("\n"),
    });

    const result = await runStudioLocalPiTextGeneration(
      {
        plugin,
        modelId: "google/gemini-2.5-flash",
        prompt: "Say hello",
        systemPrompt: "Be brief",
      },
      runCommand
    );

    expect(runCommand).toHaveBeenCalledWith(
      plugin,
      [
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--model",
        "google/gemini-2.5-flash",
        "--system-prompt",
        "Be brief",
        "Say hello",
      ],
      300_000
    );
    expect(result).toEqual({
      text: "hello local pi",
      modelId: "google/gemini-2.5-flash",
    });
  });

  it("passes Pi thinking level when reasoning effort is configured", async () => {
    const runCommand = createPiRunner({
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: [
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello local pi"}],"stopReason":"stop"}}',
      ].join("\n"),
    });

    const result = await runStudioLocalPiTextGeneration(
      {
        plugin,
        modelId: "google/gemini-2.5-flash",
        prompt: "Say hello",
        reasoningEffort: "xhigh",
      },
      runCommand
    );

    expect(runCommand).toHaveBeenCalledWith(
      plugin,
      [
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--model",
        "google/gemini-2.5-flash",
        "--thinking",
        "xhigh",
        "Say hello",
      ],
      300_000
    );
    expect(result).toEqual({
      text: "hello local pi",
      modelId: "google/gemini-2.5-flash",
    });
  });

  it("surfaces pi runtime errors from assistant output", async () => {
    const runCommand = createPiRunner({
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: [
        '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Bad API key"}}',
        '{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Bad API key"}]}',
      ].join("\n"),
    });

    await expect(
      runStudioLocalPiTextGeneration(
        {
          plugin,
          modelId: "google/gemini-2.5-flash",
          prompt: "Say hello",
        },
        runCommand
      )
    ).rejects.toThrow("Bad API key");
  });

  it("extracts a meaningful message from stack-like stderr output", async () => {
    const runCommand = createPiRunner({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: [
        "file:///opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:556",
        "            throw new Error(`No API key found for openai-codex.\\n\\n` +",
        "                  ^",
        "",
        "Error: No API key found for openai-codex.",
        "",
        "Use /login or set an API key environment variable. See /docs/providers.md",
        "    at AgentSession.prompt (file:///opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:556:19)",
      ].join("\n"),
    });

    await expect(
      runStudioLocalPiTextGeneration(
        {
          plugin,
          modelId: "openai-codex/gpt-5.3-codex",
          prompt: "Say hello",
        },
        runCommand
      )
    ).rejects.toThrow("No API key found for openai-codex.");
  });

  it("parses message_update text deltas when final assistant message is missing", async () => {
    const runCommand = createPiRunner({
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: [
        '{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello "}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"local pi"}}',
      ].join("\n"),
    });

    const result = await runStudioLocalPiTextGeneration(
      {
        plugin,
        modelId: "google/gemini-2.5-flash",
        prompt: "Say hello",
      },
      runCommand
    );

    expect(result).toEqual({
      text: "hello local pi",
      modelId: "google/gemini-2.5-flash",
    });
  });

  it("retries once when local pi exits successfully but emits no assistant text", async () => {
    const runCommand = jest
      .fn<ReturnType<StudioPiCommandRunner>, Parameters<StudioPiCommandRunner>>()
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdout: '{"type":"turn_start"}',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdout: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello local pi"}],"stopReason":"stop"}}',
      });

    const result = await runStudioLocalPiTextGeneration(
      {
        plugin,
        modelId: "google/gemini-2.5-flash",
        prompt: "Say hello",
      },
      runCommand
    );

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      text: "hello local pi",
      modelId: "google/gemini-2.5-flash",
    });
  });
});
