import { createHash } from "node:crypto";
import { ManagedJobClient, MANAGED_JOB_PROTOCOL } from "../../services/managed/ManagedJobClient";
import { HostedTransportAdapter } from "../../services/managed/adapters/HostedTransportAdapter";
import { StudioAssetStore } from "../StudioAssetStore";
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
    const transcribe = jest.fn(async (_source, context) => ({ kind: "transcript", operationId: context.operationId, text: "transcript" }));
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

  it("downloads a chunked managed image and saves the verified bytes through Studio output storage", async () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=", "base64"));
    const sha256 = createHash("sha256").update(png).digest("hex");
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: png.byteLength, sha256, width: 1, height: 1 };
    const request = jest.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.subarray(0, 17));
        controller.enqueue(png.subarray(17));
        controller.close();
      },
    }), { headers: {
      "x-request-id": "req-studio-image",
      "x-systemsculpt-contract": "managed-capabilities-v2",
      "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL,
      "x-systemsculpt-image-output-contract": "managed-image-output-v1",
      "x-systemsculpt-capability": "image_generation",
      "x-systemsculpt-output-index": "0",
      "x-systemsculpt-content-sha256": sha256,
      "content-type": "image/png",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment; filename=\"systemsculpt-image-0.png\"",
    } }));
    const jobs = new ManagedJobClient(
      new HostedTransportAdapter({
        baseUrl: "https://systemsculpt.test",
        pluginVersion: "6.2.2",
        licenseKey: () => "license",
        requestClient: { request } as never,
      }),
      undefined,
      () => "req-studio-image",
    );
    const downloaded = await jobs.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata);
    const putAsset = jest.fn(async () => undefined);
    const assetStore = new StudioAssetStore({
      loadProject: jest.fn(async () => ({ projectId: "studio-project" })),
      putAsset,
    } as never);
    const { plugin } = createPlugin();
    const adapter = new StudioApiExecutionAdapter(plugin as never);
    Object.assign(adapter as object, {
      images: {
        generate: jest.fn(async () => ({
          operationId: "studio-image-run-1-image-a",
          jobId: "123e4567-e89b-42d3-a456-426614174000",
          outputs: [downloaded],
        })),
      },
    });

    const result = await adapter.generateImage({
      runId: "run-1",
      nodeId: "image-a",
      projectPath: "SystemSculpt/Studio/New Studio Project.systemsculpt",
      signal: new AbortController().signal,
      buildPayload: async () => ({ prompt: "Draw" }),
      storeOutput: (bytes, mimeType) => assetStore.storeArrayBuffer(
        "SystemSculpt/Studio/New Studio Project.systemsculpt",
        bytes,
        mimeType,
      ),
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ hash: sha256, mimeType: "image/png", sizeBytes: png.byteLength });
    expect(putAsset).toHaveBeenCalledWith(
      "SystemSculpt/Studio/New Studio Project.systemsculpt",
      "studio-project",
      expect.objectContaining({
        contentAddressedPath: `${sha256.slice(0, 2)}/${sha256}.png`,
        bytes: png,
      }),
    );
  });

  it("finalizes published transcription records while preserving image cleanup", async () => {
    const { plugin } = createPlugin();
    const adapter = new StudioApiExecutionAdapter(plugin as never);
    const imageComplete = jest.fn(async () => undefined);
    const transcriptionFinalize = jest.fn(async () => undefined);
    Object.assign(adapter as object, {
      images: { completeLocalCommit: imageComplete },
      transcription: { finalizePublishedLocalCommit: transcriptionFinalize },
    });

    await adapter.completeLocalCommit([
      { capability: "image_generation", operationId: "image-op" },
      { capability: "transcription", operationId: "transcription-op" },
    ]);

    expect(imageComplete).toHaveBeenCalledWith("image-op", undefined);
    expect(transcriptionFinalize).toHaveBeenCalledWith("transcription-op", undefined);
  });
});
