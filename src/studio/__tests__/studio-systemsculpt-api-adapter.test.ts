import type { ManagedTextGenerationOperation } from "../../services/managed/ManagedTextGenerationAdapter";
import { StudioApiExecutionAdapter } from "../StudioApiExecutionAdapter";

function createPlugin() {
  const generateText = jest.fn(async (operation: ManagedTextGenerationOperation) => {
    const messages = await operation.buildMessages();
    return {
      operationId: operation.operationId,
      requestId: "request-1",
      text: messages.map(message => message.content).join(" | "),
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  });
  const plugin = {
    app: {
      vault: {
        getName: () => "studio-test",
        adapter: {},
      },
    },
    getManagedCapabilityGraph: () => ({ admission: {}, transport: {}, textGeneration: { generate: generateText } }),
  };
  Object.defineProperties(plugin, {
    aiService: { get: () => { throw new Error("legacy stream access"); } },
    modelService: { get: () => { throw new Error("model access"); } },
    settings: { value: { textExecutionBackend: "systemsculpt" } },
  });
  return { plugin, generateText };
}

describe("StudioApiExecutionAdapter managed cutover", () => {
  it("uses lazy managed text generation with deterministic per-node operation keys", async () => {
    const { plugin, generateText } = createPlugin();
    const adapter = new StudioApiExecutionAdapter(plugin as never);
    const firstPayload = jest.fn(() => ({ prompt: "Summarize", systemPrompt: "Be concise" }));
    const secondPayload = jest.fn(() => ({ prompt: "Translate" }));

    const first = await adapter.generateText({
      runId: "run-1",
      nodeId: "node-a",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      buildPayload: firstPayload,
    });
    const second = await adapter.generateText({
      runId: "run-1",
      nodeId: "node-b",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      buildPayload: secondPayload,
    });

    expect(first).toEqual({
      text: "Be concise | Summarize",
      operation: { capability: "text_generation", operationId: "studio-text-run-1-node-a" },
    });
    expect(second.operation!.operationId).toBe("studio-text-run-1-node-b");
    expect(generateText.mock.calls.map(call => call[0].purpose)).toEqual([
      "workflow_automation",
      "workflow_automation",
    ]);
  });

  it("routes transcription directly", async () => {
    const { plugin } = createPlugin();
    const adapter = new StudioApiExecutionAdapter(plugin as never);
    const transcribe = jest.fn(async (_source, context) => ({ kind: "transcript", operationId: context.operationId, text: "transcript" }));
    Object.assign(adapter as object, {
      transcription: { transcribe, beginLocalCommit: jest.fn(), completeLocalCommit: jest.fn() },
    });
    const source = {
      identity: "studio:source",
      fingerprint: async () => `sha256:${"c".repeat(64)}`,
      load: async () => ({
        filename: "audio.wav", contentType: "audio/wav", sizeBytes: 1,
        readSlice: async (start: number, end: number) => new Uint8Array([1]).slice(start, end).buffer,
        release: jest.fn(),
      }),
    };
    const transcription = await adapter.transcribeAudio({
      runId: "run-1",
      nodeId: "transcription-a",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      source,
    });

    expect(transcribe).toHaveBeenCalledWith(source, expect.objectContaining({
      operationId: "studio-transcription-run-1-transcription-a",
    }));
    expect(transcription).toEqual({
      text: "transcript",
      operation: { capability: "transcription", operationId: "studio-transcription-run-1-transcription-a" },
    });
  });

  it("finalizes published transcription records", async () => {
    const { plugin } = createPlugin();
    const adapter = new StudioApiExecutionAdapter(plugin as never);
    const transcriptionFinalize = jest.fn(async () => undefined);
    Object.assign(adapter as object, {
      transcription: { finalizePublishedLocalCommit: transcriptionFinalize },
    });

    await adapter.completeLocalCommit([
      { capability: "transcription", operationId: "transcription-op" },
    ]);

    expect(transcriptionFinalize).toHaveBeenCalledWith("transcription-op", undefined);
  });
});
