import { Platform } from "obsidian";
import { StudioApiExecutionAdapter } from "../StudioApiExecutionAdapter";

function createPluginStub() {
  const modelsById = {
    "systemsculpt@@systemsculpt/ai-agent": {
      id: "systemsculpt@@systemsculpt/ai-agent",
      name: "SystemSculpt AI Agent",
      provider: "systemsculpt",
      sourceMode: "systemsculpt",
      sourceProviderId: "systemsculpt",
      piExecutionModelId: "systemsculpt/ai-agent",
      piRemoteAvailable: true,
      piLocalAvailable: false,
      piAuthMode: "hosted",
      supported_parameters: ["tools"],
    },
  } as const;

  const streamMessage = jest.fn(
    async function* (): AsyncGenerator<{ type: "content"; text: string }> {
      yield { type: "content", text: "hosted " };
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
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
      customProviders: [],
    },
    modelService: {
      getModels: jest.fn(async () => Object.values(modelsById)),
      getCachedModels: jest.fn(() => Object.values(modelsById)),
      getModelById: jest.fn(async (id: string) => modelsById[id as keyof typeof modelsById]),
    },
    aiService: {
      getCreditsBalance: jest.fn(async () => ({ totalRemaining: 100 })),
      streamMessage,
    },
  } as any;
}

function createProjectWithNodes(nodes: Array<Record<string, unknown>>) {
  return {
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
      nodes,
      edges: [],
      entryNodeIds: nodes.map((node) => String(node.id)),
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
  };
}

describe("StudioApiExecutionAdapter", () => {
  beforeEach(() => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  it("routes Studio text generation through the hosted SystemSculpt stream contract", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    const result = await adapter.generateText({
      prompt: "Summarize this transcript.",
      modelId: "systemsculpt@@systemsculpt/ai-agent",
      systemPrompt: "Focus on action items.",
      reasoningEffort: "xhigh",
      runId: "run_hosted",
      nodeId: "node_hosted",
      projectPath: "Studio/Test.systemsculpt",
    });

    expect(plugin.aiService.streamMessage).toHaveBeenCalledWith({
      messages: [
        {
          role: "user",
          content: "Summarize this transcript.",
          message_id: "studio_run_hosted_node_hosted_user",
        },
      ],
      model: "systemsculpt@@systemsculpt/ai-agent",
      systemPromptOverride: "Focus on action items.",
      reasoningEffort: "xhigh",
      allowTools: false,
    });
    expect(result).toEqual({
      text: "hosted result",
      modelId: "systemsculpt@@systemsculpt/ai-agent",
    });
  });

  it("surfaces hosted Studio text generation failures directly", async () => {
    const plugin = createPluginStub();
    plugin.aiService.streamMessage.mockImplementation(
      async function* (): AsyncGenerator<{ type: "content"; text: string }> {
        throw new Error("Hosted credits check failed");
      }
    );
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    await expect(
      adapter.generateText({
        prompt: "Summarize this transcript.",
        modelId: "systemsculpt@@systemsculpt/ai-agent",
        runId: "run_hosted",
        nodeId: "node_hosted",
        projectPath: "Studio/Test.systemsculpt",
      })
    ).rejects.toThrow("SystemSculpt text generation failed: Hosted credits check failed");
  });

  it("normalizes invalid reasoning values by omitting them from the hosted request", async () => {
    const plugin = createPluginStub();
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    await adapter.generateText({
      prompt: "Summarize this transcript.",
      modelId: "systemsculpt@@systemsculpt/ai-agent",
      reasoningEffort: "LOUD" as any,
      runId: "run_hosted",
      nodeId: "node_reasoning",
      projectPath: "Studio/Test.systemsculpt",
    });

    const streamOptions = plugin.aiService.streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.allowTools).toBe(false);
    expect(streamOptions?.reasoningEffort).toBeUndefined();
  });

  it("requires SystemSculpt credits when the Studio graph contains API-backed nodes", async () => {
    const plugin = createPluginStub();
    plugin.aiService.getCreditsBalance = jest.fn(async () => ({ totalRemaining: 0 }));
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    const estimate = await adapter.estimateRunCredits(
      createProjectWithNodes([
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
      ])
    );

    expect(estimate).toEqual({
      ok: false,
      reason: "Insufficient SystemSculpt credits for API-dependent Studio nodes.",
    });
    expect(plugin.aiService.getCreditsBalance).toHaveBeenCalledTimes(1);
  });

  it("requires SystemSculpt credits when the Studio graph contains hosted text nodes", async () => {
    const plugin = createPluginStub();
    plugin.aiService.getCreditsBalance = jest.fn(async () => ({ totalRemaining: 0 }));
    const adapter = new StudioApiExecutionAdapter(plugin, {} as any);

    const estimate = await adapter.estimateRunCredits(
      createProjectWithNodes([
        {
          id: "text_hosted",
          kind: "studio.text_generation",
          version: "1.0.0",
          title: "Hosted text",
          position: { x: 0, y: 0 },
          config: {
            modelId: "systemsculpt@@systemsculpt/ai-agent",
          },
          continueOnError: false,
          disabled: false,
        },
      ])
    );

    expect(estimate).toEqual({
      ok: false,
      reason: "Insufficient SystemSculpt credits for API-dependent Studio nodes.",
    });
    expect(plugin.aiService.getCreditsBalance).toHaveBeenCalledTimes(1);
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
