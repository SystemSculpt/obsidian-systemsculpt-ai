import { StudioApiExecutionAdapter } from "../StudioApiExecutionAdapter";

function createPlugin() {
  const generateText = jest.fn(async operation => {
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
    getManagedCapabilityGraph: () => ({ admission: {}, transport: {} }),
    getManagedCapabilityClient: () => ({ generateText }),
  };
  Object.defineProperties(plugin, {
    aiService: { get: () => { throw new Error("legacy stream access"); } },
    modelService: { get: () => { throw new Error("model access"); } },
    settings: { get: () => { throw new Error("provider/settings access"); } },
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
    expect(second.operation.operationId).toBe("studio-text-run-1-node-b");
    expect(generateText.mock.calls.map(call => call[0].purpose)).toEqual([
      "workflow_automation",
      "workflow_automation",
    ]);
  });

  it("stages verified managed image bytes and routes transcription directly", async () => {
    const { plugin } = createPlugin();
    const adapter = new StudioApiExecutionAdapter(plugin as never);
    const imageGenerate = jest.fn(async operation => ({
      operationId: operation.operationId,
      jobId: "job-1",
      outputs: [{
        metadata: { index: 0, mime_type: "image/png", size_bytes: 2, sha256: "a".repeat(64), width: 2, height: 1 },
        bytes: new Uint8Array([1, 2]).buffer,
      }],
    }));
    const transcribe = jest.fn(async (_source, context) => ({ operationId: context.operationId, text: "transcript" }));
    Object.assign(adapter as object, {
      images: { generate: imageGenerate, beginLocalCommit: jest.fn(), completeLocalCommit: jest.fn() },
      transcription: { transcribe, beginLocalCommit: jest.fn(), completeLocalCommit: jest.fn() },
    });
    const storeOutput = jest.fn(async () => ({ hash: "b".repeat(64), mimeType: "image/png", sizeBytes: 2, path: "asset.png" }));

    const image = await adapter.generateImage({
      runId: "run-1",
      nodeId: "image-a",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      buildPayload: async () => ({ prompt: "Draw" }),
      storeOutput,
    });
    const source = {
      identity: "studio:source",
      fingerprint: async () => `sha256:${"c".repeat(64)}`,
      load: async () => ({ filename: "audio.wav", contentType: "audio/wav", bytes: new Uint8Array([1]).buffer }),
    };
    const transcription = await adapter.transcribeAudio({
      runId: "run-1",
      nodeId: "transcription-a",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      source,
    });

    expect(imageGenerate.mock.calls[0][0].operationId).toBe("studio-image-run-1-image-a");
    expect(image.images).toHaveLength(1);
    expect(storeOutput).toHaveBeenCalledWith(expect.any(ArrayBuffer), "image/png");
    expect(transcribe).toHaveBeenCalledWith(source, expect.objectContaining({
      operationId: "studio-transcription-run-1-transcription-a",
    }));
    expect(transcription).toEqual({
      text: "transcript",
      operation: { capability: "transcription", operationId: "studio-transcription-run-1-transcription-a" },
    });
  });
});
