import { StudioSystemSculptApiAdapter } from "../StudioSystemSculptApiAdapter";

function createPluginStub() {
  return {
    manifest: {
      version: "4.13.0",
    },
    settings: {
      serverUrl: "https://api.systemsculpt.com",
      licenseKey: "license_test",
      selectedModelId: "openai/gpt-5-mini",
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
    },
    aiService: {
      requestAgentSession: jest.fn(),
      getCreditsBalance: jest.fn(async () => ({ totalRemaining: 100 })),
    },
  } as any;
}

describe("StudioSystemSculptApiAdapter", () => {
  it("serializes 3-way fan-out text turns and scopes chat sessions by run + node", async () => {
    const adapter = new StudioSystemSculptApiAdapter(createPluginStub(), {} as any);
    const seenChatIds: string[] = [];
    let inFlightTurns = 0;
    let maxInFlightTurns = 0;

    (adapter as any).sessionClient = {
      updateConfig: jest.fn(),
      startOrContinueTurn: jest.fn(async (args: { chatId: string }) => {
        seenChatIds.push(args.chatId);
        inFlightTurns += 1;
        maxInFlightTurns = Math.max(maxInFlightTurns, inFlightTurns);
        return { ok: true } as Response;
      }),
    };

    (adapter as any).streamer = {
      streamResponse: jest.fn(() =>
        (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 16));
          yield { type: "content" as const, text: "ok" };
          inFlightTurns -= 1;
        })()
      ),
    };

    const [first, second, third] = await Promise.all([
      adapter.generateText({
        prompt: "first",
        systemPrompt: "system",
        modelId: "openai/gpt-5-mini",
        runId: "run_test",
        nodeId: "node_a",
        projectPath: "Studio/Test.systemsculpt",
      }),
      adapter.generateText({
        prompt: "second",
        systemPrompt: "system",
        modelId: "openai/gpt-5-mini",
        runId: "run_test",
        nodeId: "node_b",
        projectPath: "Studio/Test.systemsculpt",
      }),
      adapter.generateText({
        prompt: "third",
        systemPrompt: "system",
        modelId: "openai/gpt-5-mini",
        runId: "run_test",
        nodeId: "node_c",
        projectPath: "Studio/Test.systemsculpt",
      }),
    ]);

    expect(first).toEqual({ text: "ok", modelId: "openai/gpt-5-mini" });
    expect(second).toEqual({ text: "ok", modelId: "openai/gpt-5-mini" });
    expect(third).toEqual({ text: "ok", modelId: "openai/gpt-5-mini" });
    expect(maxInFlightTurns).toBe(1);
    expect(inFlightTurns).toBe(0);
    expect(seenChatIds).toEqual([
      "studio:run_test:node_a",
      "studio:run_test:node_b",
      "studio:run_test:node_c",
    ]);
  });

  it("surfaces lock_until details for turn_in_flight conflicts", async () => {
    const adapter = new StudioSystemSculptApiAdapter(createPluginStub(), {} as any);
    (adapter as any).sessionClient = {
      updateConfig: jest.fn(),
      startOrContinueTurn: jest.fn(async () => ({
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            error: {
              code: "turn_in_flight",
              lock_until: "2026-02-23 06:14:32.832+00",
            },
          }),
      })),
    };

    await expect(
      adapter.generateText({
        prompt: "first",
        systemPrompt: "system",
        modelId: "openai/gpt-5-mini",
        runId: "run_test",
        nodeId: "node_a",
        projectPath: "Studio/Test.systemsculpt",
      })
    ).rejects.toThrow("lock_until=2026-02-23 06:14:32.832+00");
  });
});
