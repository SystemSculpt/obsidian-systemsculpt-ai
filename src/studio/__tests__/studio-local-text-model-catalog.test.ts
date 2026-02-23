import {
  listStudioLocalTextModelOptions,
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
});
