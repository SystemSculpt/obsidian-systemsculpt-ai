import { Platform } from "obsidian";
import { StudioApiExecutionAdapter } from "../StudioApiExecutionAdapter";
import * as StudioLocalTextModelCatalog from "../StudioLocalTextModelCatalog";
import { hasPiTextProviderAuth } from "../../services/pi-native/PiTextAuth";

jest.mock("../../services/pi-native/PiTextAuth", () => {
  const actual = jest.requireActual("../../services/pi-native/PiTextAuth");
  return {
    ...actual,
    hasPiTextProviderAuth: jest.fn().mockResolvedValue(true),
  };
});

jest.mock("../StudioLocalTextModelCatalog", () => {
  const actual = jest.requireActual("../StudioLocalTextModelCatalog");
  return {
    ...actual,
    runStudioLocalPiTextGeneration: jest.fn(actual.runStudioLocalPiTextGeneration),
  };
});

function createPluginStub() {
  const modelsById = {
    "openai@@gpt-5-mini": {
      id: "openai@@gpt-5-mini",
      name: "GPT-5 Mini",
      provider: "openai",
      piExecutionModelId: "openai/gpt-5-mini",
      piRemoteAvailable: true,
      piLocalAvailable: false,
      piAuthMode: "hosted",
    },
    "google@@gemini-2.5-flash": {
      id: "google@@gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "google",
      piExecutionModelId: "google/gemini-2.5-flash",
      piRemoteAvailable: false,
      piLocalAvailable: true,
      piAuthMode: "local",
    },
    "openai-codex@@gpt-5.3-codex": {
      id: "openai-codex@@gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      provider: "openai-codex",
      piExecutionModelId: "openai-codex/gpt-5.3-codex",
      piRemoteAvailable: false,
      piLocalAvailable: true,
      piAuthMode: "local",
    },
    "github-copilot@@gpt-5.2-codex": {
      id: "github-copilot@@gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      provider: "github-copilot",
      piExecutionModelId: "github-copilot/gpt-5.2-codex",
      piRemoteAvailable: false,
      piLocalAvailable: true,
      piAuthMode: "local",
    },
    "ollama@@llama3.1:8b": {
      id: "ollama@@llama3.1:8b",
      name: "Llama 3.1 8B",
      provider: "ollama",
      piExecutionModelId: "ollama/llama3.1:8b",
      piRemoteAvailable: false,
      piLocalAvailable: true,
      piAuthMode: "local",
    },
  } as const;

  const streamMessage = jest.fn(
    async function* (): AsyncGenerator<{ type: "content"; text: string }> {
      yield { type: "content", text: "local " };
      yield { type: "content", text: "result" };
    }
  );
  return {
    manifest: {
      version: "4.13.0",
    },
    settings: {
      serverUrl: "https://api.systemsculpt.com",
      licenseKey: "license_test",
      selectedModelId: "openai@@gpt-5-mini",
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
      customProviders: [],
    },
    modelService: {
      getModels: jest.fn(async () => Object.values(modelsById)),
      getCachedModels: jest.fn(() => Object.values(modelsById)),
      getModelById: jest.fn(async (id: string) => modelsById[id as keyof typeof modelsById]),
    },
    aiService: {
      requestAgentSession: jest.fn(),
      getCreditsBalance: jest.fn(async () => ({ totalRemaining: 100 })),
      streamMessage,
    },
  } as any;
}

describe("StudioApiExecutionAdapter", () => {
  beforeEach(() => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
    (hasPiTextProviderAuth as jest.Mock).mockResolvedValue(true);
  });

  it("routes Studio text generation through the local Pi executor with the Pi execution model id", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);
    const localPiMock = StudioLocalTextModelCatalog
      .runStudioLocalPiTextGeneration as jest.MockedFunction<
      typeof StudioLocalTextModelCatalog.runStudioLocalPiTextGeneration
    >;
    localPiMock.mockResolvedValue({
      text: "local result",
      modelId: "google/gemini-2.5-flash",
    });
    const startOrContinueTurn = jest.fn(async () => {
      throw new Error("SystemSculpt session client should not be called in local mode.");
    });
    (adapter as any).sessionClient = {
      updateConfig: jest.fn(),
      startOrContinueTurn,
    };

    const result = await adapter.generateText({
      prompt: "Summarize this transcript.",
      modelId: "google@@gemini-2.5-flash",
      reasoningEffort: "xhigh",
      runId: "run_local",
      nodeId: "node_local",
      projectPath: "Studio/Test.systemsculpt",
    });

    expect(localPiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin,
        modelId: "google/gemini-2.5-flash",
        prompt: "Summarize this transcript.",
        reasoningEffort: "xhigh",
      })
    );
    expect(plugin.aiService.streamMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "local result",
      modelId: "google@@gemini-2.5-flash",
    });
    localPiMock.mockReset();
  });

  it("serializes concurrent local Pi text generations", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);
    const localPiMock = StudioLocalTextModelCatalog
      .runStudioLocalPiTextGeneration as jest.MockedFunction<
      typeof StudioLocalTextModelCatalog.runStudioLocalPiTextGeneration
    >;
    localPiMock.mockReset();
    let inFlight = 0;
    let maxInFlight = 0;
    localPiMock.mockImplementation(async (options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return {
        text: `local:${options.prompt}`,
        modelId: String(options.modelId),
      };
    });

    const [first, second] = await Promise.all([
      adapter.generateText({
        prompt: "first",
        modelId: "openai-codex@@gpt-5.3-codex",
        runId: "run_local",
        nodeId: "node_a",
        projectPath: "Studio/Test.systemsculpt",
      }),
      adapter.generateText({
        prompt: "second",
        modelId: "openai-codex@@gpt-5.3-codex",
        runId: "run_local",
        nodeId: "node_b",
        projectPath: "Studio/Test.systemsculpt",
      }),
    ]);

    expect(first).toEqual({
      text: "local:first",
      modelId: "openai-codex@@gpt-5.3-codex",
    });
    expect(second).toEqual({
      text: "local:second",
      modelId: "openai-codex@@gpt-5.3-codex",
    });
    expect(localPiMock).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    localPiMock.mockReset();
  });

  it("returns actionable Pi install guidance when the pi CLI binary is missing", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);
    const localPiMock = StudioLocalTextModelCatalog
      .runStudioLocalPiTextGeneration as jest.MockedFunction<
      typeof StudioLocalTextModelCatalog.runStudioLocalPiTextGeneration
    >;
    localPiMock.mockReset();
    localPiMock.mockRejectedValue(new Error("spawn pi ENOENT"));

    let capturedMessage = "";
    await adapter
      .generateText({
        prompt: "Summarize this transcript.",
        modelId: "openai-codex@@gpt-5.3-codex",
        runId: "run_local",
        nodeId: "node_local",
        projectPath: "Studio/Test.systemsculpt",
      })
      .catch((error: unknown) => {
        capturedMessage = error instanceof Error ? error.message : String(error);
      });

    expect(capturedMessage).toContain("bundled Pi runtime is unavailable");
    expect(capturedMessage).toContain("Recovery checklist");
    expect(capturedMessage).toContain("Keep Obsidian open for a few seconds");
    expect(capturedMessage).toContain("rerun Verify Models");
    localPiMock.mockReset();
  });

  it("returns actionable Pi auth guidance when the provider is missing API credentials", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);
    const localPiMock = StudioLocalTextModelCatalog
      .runStudioLocalPiTextGeneration as jest.MockedFunction<
      typeof StudioLocalTextModelCatalog.runStudioLocalPiTextGeneration
    >;
    localPiMock.mockReset();
    localPiMock.mockRejectedValue(new Error("No API key found for openai-codex.\nUse /login..."));

    let capturedMessage = "";
    await adapter
      .generateText({
        prompt: "Summarize this transcript.",
        modelId: "openai-codex@@gpt-5.3-codex",
        runId: "run_local",
        nodeId: "node_local",
        projectPath: "Studio/Test.systemsculpt",
      })
      .catch((error: unknown) => {
        capturedMessage = error instanceof Error ? error.message : String(error);
      });

    expect(capturedMessage).toContain("provider authentication is missing or invalid");
    expect(capturedMessage).toContain("pi /login openai-codex");
    expect(capturedMessage).toContain("Refresh the local Pi model catalog in Studio");
    localPiMock.mockReset();
  });

  it("returns token-type guidance for providers that reject personal access tokens", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);
    const localPiMock = StudioLocalTextModelCatalog
      .runStudioLocalPiTextGeneration as jest.MockedFunction<
      typeof StudioLocalTextModelCatalog.runStudioLocalPiTextGeneration
    >;
    localPiMock.mockReset();
    localPiMock.mockRejectedValue(
      new Error("400 bad request: Personal Access Tokens are not supported for this endpoint")
    );

    let capturedMessage = "";
    await adapter
      .generateText({
        prompt: "Summarize this transcript.",
        modelId: "github-copilot@@gpt-5.2-codex",
        runId: "run_local",
        nodeId: "node_local",
        projectPath: "Studio/Test.systemsculpt",
      })
      .catch((error: unknown) => {
        capturedMessage = error instanceof Error ? error.message : String(error);
      });

    expect(capturedMessage).toContain("credentials are not accepted for this endpoint");
    expect(capturedMessage).toContain("pi /login github-copilot");
    expect(capturedMessage).toContain("rerun the setup wizard verification step");
    localPiMock.mockReset();
  });

  it("requires SystemSculpt credits when the Studio graph contains API-backed nodes", async () => {
    const plugin = createPluginStub();
    plugin.aiService.getCreditsBalance = jest.fn(async () => ({ totalRemaining: 0 }));
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    const estimate = await adapter.estimateRunCredits({
      schema: "studio.project.v1",
      projectId: "proj_test",
      name: "Test",
      createdAt: "2026-02-23T00:00:00.000Z",
      updatedAt: "2026-02-23T00:00:00.000Z",
      engine: {
        apiMode: "systemsculpt_only",
        minPluginVersion: "0.0.0",
      },
      graph: {
        nodes: [
          {
            id: "image_remote",
            kind: "studio.image_generation",
            version: "1.0.0",
            title: "Image",
            position: { x: 0, y: 0 },
            config: {},
            continueOnError: false,
            disabled: false,
          },
        ],
        edges: [],
        entryNodeIds: ["image_remote"],
      },
      permissionsRef: {
        policyVersion: 1,
        policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
      },
      settings: {
        runConcurrency: "adaptive",
        defaultFsScope: "vault",
        retention: {
          maxRuns: 100,
          maxArtifactsMb: 1024,
        },
      },
      migrations: {
        projectSchemaVersion: "1.0.0",
        applied: [],
      },
    });

    expect(estimate).toEqual({
      ok: false,
      reason: "Insufficient SystemSculpt credits for API-dependent Studio nodes.",
    });
    expect(plugin.aiService.getCreditsBalance).toHaveBeenCalledTimes(1);
  });

  it("skips SystemSculpt credit checks when all text nodes run in local Pi mode", async () => {
    const plugin = createPluginStub();
    plugin.aiService.getCreditsBalance = jest.fn(async () => ({ totalRemaining: 0 }));
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    const estimate = await adapter.estimateRunCredits({
      schema: "studio.project.v1",
      projectId: "proj_test",
      name: "Test",
      createdAt: "2026-02-23T00:00:00.000Z",
      updatedAt: "2026-02-23T00:00:00.000Z",
      engine: {
        apiMode: "systemsculpt_only",
        minPluginVersion: "0.0.0",
      },
      graph: {
        nodes: [
          {
            id: "text_local",
            kind: "studio.text_generation",
            version: "1.0.0",
            title: "Local text",
            position: { x: 0, y: 0 },
            config: {
              modelId: "ollama@@llama3.1:8b",
            },
            continueOnError: false,
            disabled: false,
          },
        ],
        edges: [],
        entryNodeIds: ["text_local"],
      },
      permissionsRef: {
        policyVersion: 1,
        policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
      },
      settings: {
        runConcurrency: "adaptive",
        defaultFsScope: "vault",
        retention: {
          maxRuns: 100,
          maxArtifactsMb: 1024,
        },
      },
      migrations: {
        projectSchemaVersion: "1.0.0",
        applied: [],
      },
    });

    expect(estimate).toEqual({ ok: true });
    expect(plugin.aiService.getCreditsBalance).not.toHaveBeenCalled();
  });

  it("uploads attached input images before creating a generation job", async () => {
    const assetStore = {
      readArrayBuffer: jest.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      storeArrayBuffer: jest.fn(async () => ({
        hash: "out-hash",
        mimeType: "image/png",
        sizeBytes: 3,
        path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/aa/out-hash.png",
      })),
    } as any;
    const adapter = new StudioApiExecutionAdapter(createPluginStub(), assetStore);
    const imageClient = {
      createGenerationJob: jest.fn(async () => ({
        job: { id: "job_123" },
        poll_url: "/api/v1/images/generations/jobs/job_123",
      })),
      waitForGenerationJob: jest.fn(async () => ({
        job: { id: "job_123", status: "succeeded" },
        outputs: [
          {
            index: 0,
            mime_type: "image/png",
            size_bytes: 3,
            width: 1024,
            height: 576,
            url: "https://systemsculpt-assets.example.com/output.png",
            url_expires_in_seconds: 1800,
          },
        ],
      })),
      downloadImage: jest.fn(async () => ({
        arrayBuffer: new Uint8Array([9, 8, 7]).buffer,
        contentType: "image/png",
      })),
      prepareInputImageUploads: jest.fn(async () => ({
        input_uploads: [
          {
            index: 0,
            upload: { method: "PUT", url: "https://systemsculpt-assets.example.com/input-0" },
            input_image: {
              type: "uploaded",
              key: "input/key/0",
              mime_type: "image/png",
              size_bytes: 128,
              sha256: "input-hash-0",
            },
          },
        ],
      })),
      uploadPreparedInputImage: jest.fn(async () => undefined),
    } as any;
    (adapter as any).ensureImageClient = jest.fn(() => imageClient);

    await adapter.generateImage({
      prompt: "Generate image with ref",
      modelId: "openai/gpt-5-image-mini",
      count: 1,
      aspectRatio: "16:9",
      inputImages: [
        {
          hash: "input-hash-0",
          mimeType: "image/png",
          sizeBytes: 128,
          path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/00/input-hash-0.png",
        },
      ],
      runId: "run_test",
      projectPath: "Studio/Test.systemsculpt",
    });

    expect(imageClient.prepareInputImageUploads).toHaveBeenCalledWith([
      {
        mime_type: "image/png",
        size_bytes: 128,
        sha256: "input-hash-0",
      },
    ]);
    expect(imageClient.uploadPreparedInputImage).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadUrl: "https://systemsculpt-assets.example.com/input-0",
        mimeType: "image/png",
      })
    );
    expect(imageClient.createGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        input_images: [
          {
            type: "uploaded",
            key: "input/key/0",
            mime_type: "image/png",
            size_bytes: 128,
            sha256: "input-hash-0",
          },
        ],
      }),
      expect.any(Object)
    );
    expect(imageClient.createGenerationJob).toHaveBeenCalledWith(
      expect.not.objectContaining({
        model: expect.anything(),
      }),
      expect.any(Object)
    );
  });

  it("retries transient image polling failures with backoff and a new idempotency key", async () => {
    jest.useFakeTimers();
    try {
      const assetStore = {
        readArrayBuffer: jest.fn(async () => new Uint8Array([1, 2, 3]).buffer),
        storeArrayBuffer: jest.fn(async () => ({
          hash: "out-hash",
          mimeType: "image/png",
          sizeBytes: 3,
          path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/aa/out-hash.png",
        })),
      } as any;
      const adapter = new StudioApiExecutionAdapter(createPluginStub(), assetStore);
      const imageClient = {
        createGenerationJob: jest
          .fn()
          .mockResolvedValueOnce({
            job: { id: "job_retry_1" },
            poll_url: "/api/v1/images/generations/jobs/job_retry_1",
          })
          .mockResolvedValueOnce({
            job: { id: "job_retry_2" },
            poll_url: "/api/v1/images/generations/jobs/job_retry_2",
          }),
        waitForGenerationJob: jest
          .fn()
          .mockRejectedValueOnce(
            new Error(
              "Service is currently unavailable due to high demand. Please try again later. (E003) (abc123)"
            )
          )
          .mockResolvedValueOnce({
            job: { id: "job_retry_2", status: "succeeded" },
            outputs: [
              {
                index: 0,
                mime_type: "image/png",
                size_bytes: 3,
                width: 1024,
                height: 576,
                url: "https://systemsculpt-assets.example.com/output.png",
                url_expires_in_seconds: 1800,
              },
            ],
          }),
        downloadImage: jest.fn(async () => ({
          arrayBuffer: new Uint8Array([9, 8, 7]).buffer,
          contentType: "image/png",
        })),
        prepareInputImageUploads: jest.fn(async () => ({
          input_uploads: [],
        })),
        uploadPreparedInputImage: jest.fn(async () => undefined),
      } as any;
      (adapter as any).ensureImageClient = jest.fn(() => imageClient);

      const runPromise = adapter.generateImage({
        prompt: "Retry this image generation",
        count: 1,
        aspectRatio: "16:9",
        runId: "run_retry",
        projectPath: "Studio/Test.systemsculpt",
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await runPromise;

      expect(result.images).toHaveLength(1);
      expect(imageClient.createGenerationJob).toHaveBeenCalledTimes(2);
      expect(imageClient.waitForGenerationJob).toHaveBeenCalledTimes(2);
      const firstIdempotencyKey = String(imageClient.createGenerationJob.mock.calls[0]?.[1]?.idempotencyKey || "");
      const secondIdempotencyKey = String(imageClient.createGenerationJob.mock.calls[1]?.[1]?.idempotencyKey || "");
      expect(firstIdempotencyKey).toContain("-r1-");
      expect(secondIdempotencyKey).toContain("-r2-");
      expect(secondIdempotencyKey).not.toBe(firstIdempotencyKey);
    } finally {
      jest.useRealTimers();
    }
  });
});
