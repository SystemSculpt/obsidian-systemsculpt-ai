import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import type { StudioNodeExecutionContext, StudioJsonValue } from "../types";

function createContext(options: {
  nodeId: string;
  kind: string;
  config?: Record<string, StudioJsonValue>;
  inputs?: Record<string, StudioJsonValue>;
  generateTextMock?: jest.Mock;
  generateImageMock?: jest.Mock;
  runCliMock?: jest.Mock;
  storeAssetMock?: jest.Mock;
  readAssetMock?: jest.Mock;
  writeTempFileMock?: jest.Mock;
  readLocalFileBinaryMock?: jest.Mock;
  deleteLocalFileMock?: jest.Mock;
}): StudioNodeExecutionContext {
  const generateTextMock =
    options.generateTextMock ||
    jest.fn(async () => ({
      text: "ok",
      modelId: "openai/gpt-5-mini",
    }));
  const generateImageMock =
    options.generateImageMock ||
    jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));
  const runCliMock =
    options.runCliMock || jest.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
  const storeAssetMock =
    options.storeAssetMock ||
    jest.fn(async () => ({
      hash: "hash",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      path: "asset.bin",
    }));
  const readAssetMock = options.readAssetMock || jest.fn(async () => new ArrayBuffer(0));
  const writeTempFileMock = options.writeTempFileMock || jest.fn(async () => "/tmp/file.bin");
  const readLocalFileBinaryMock =
    options.readLocalFileBinaryMock || jest.fn(async () => new ArrayBuffer(0));
  const deleteLocalFileMock = options.deleteLocalFileMock || jest.fn(async () => {});

  return {
    runId: "run_test",
    projectPath: "Studio/Test.systemsculpt",
    node: {
      id: options.nodeId,
      kind: options.kind,
      version: "1.0.0",
      title: options.kind,
      position: { x: 0, y: 0 },
      config: options.config || {},
    },
    inputs: options.inputs || {},
    signal: new AbortController().signal,
    services: {
      api: {
        estimateRunCredits: async () => ({ ok: true }),
        generateText: generateTextMock,
        generateImage: generateImageMock,
        transcribeAudio: jest.fn(async () => ({ text: "" })),
      },
      secretStore: {
        isAvailable: () => false,
        getSecret: async () => "",
      },
      storeAsset: storeAssetMock,
      readAsset: readAssetMock,
      resolveAbsolutePath: (path) => path,
      readVaultBinary: async () => new ArrayBuffer(0),
      readLocalFileBinary: readLocalFileBinaryMock,
      writeTempFile: writeTempFileMock,
      deleteLocalFile: deleteLocalFileMock,
      runCli: runCliMock,
      assertFilesystemPath: () => {},
      assertNetworkUrl: () => {},
    },
    log: () => {},
  };
}

describe("Studio built-in text/image node execution", () => {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);

  it("text node emits configured text for downstream nodes", async () => {
    const definition = registry.get("studio.text", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.text",
        config: {
          value: "Edited note text",
        },
        inputs: {
          text: "Upstream text",
        },
      })
    );

    expect(result.outputs.text).toBe("Edited note text");
  });

  it("text node falls back to upstream text when config is empty", async () => {
    const definition = registry.get("studio.text", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.text",
        config: {
          value: "",
        },
        inputs: {
          text: "Upstream text",
        },
      })
    );

    expect(result.outputs.text).toBe("Upstream text");
  });

  it("text generation consumes structured prompt payload and passes system prompt", async () => {
    const definition = registry.get("studio.text_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateTextMock = jest.fn(async (request) => ({
      text: "Title: Graph Workflow Deep Dive",
      modelId: String(request.modelId || "openai/gpt-5-mini"),
    }));

    const result = await definition!.execute(
      createContext({
        nodeId: "text-node",
        kind: "studio.text_generation",
        config: {
          modelId: "openai/gpt-5-mini",
        },
        inputs: {
          prompt: {
            systemPrompt: "Generate one high-click YouTube title.",
            userMessage:
              "Transcript: We built a ComfyUI-like graph in Obsidian and extracted audio first.",
          },
        },
        generateTextMock,
      })
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          "Transcript: We built a ComfyUI-like graph in Obsidian and extracted audio first.",
        systemPrompt: "Generate one high-click YouTube title.",
        modelId: "openai/gpt-5-mini",
        nodeId: "text-node",
      })
    );
    expect(result.outputs.text).toBe("Title: Graph Workflow Deep Dive");
  });

  it("accepts plain prompt text with system prompt from node config", async () => {
    const definition = registry.get("studio.text_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateTextMock = jest.fn(async () => ({
      text: "Generated body",
      modelId: "openai/gpt-5-mini",
    }));

    const result = await definition!.execute(
      createContext({
        nodeId: "text-node",
        kind: "studio.text_generation",
        config: {
          modelId: "openai/gpt-5-mini",
          systemPrompt: "Follow these rules for {{prompt}}",
        },
        inputs: {
          prompt: "Plain user prompt",
        },
        generateTextMock,
      })
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Plain user prompt",
        systemPrompt: "Follow these rules for Plain user prompt",
        modelId: "openai/gpt-5-mini",
      })
    );
    expect(result.outputs.text).toBe("Generated body");
  });

  it("materializes structured prompts for image generation and enforces prompt budget", async () => {
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateTextMock = jest.fn(async () => ({
      text: "x".repeat(11_500),
      modelId: "openai/gpt-5-mini",
    }));
    const generateImageMock = jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));

    await definition!.execute(
      createContext({
        nodeId: "image-node",
        kind: "studio.image_generation",
        config: {
          modelId: "google/nano-banana-pro",
          count: 1,
          aspectRatio: "16:9",
        },
        inputs: {
          prompt: {
            systemPrompt: "Generate one thumbnail-ready image prompt only.",
            userMessage: `Transcript: ${"automation strategy ".repeat(1_600)}`,
          },
        },
        generateTextMock,
        generateImageMock,
      })
    );

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "image-node",
      })
    );
    const imageRequest = generateImageMock.mock.calls[0]?.[0];
    expect(typeof imageRequest.prompt).toBe("string");
    expect(String(imageRequest.prompt).length).toBeLessThanOrEqual(7_900);
  });

  it("materializes plain image prompts when system prompt is configured on the node", async () => {
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateTextMock = jest.fn(async () => ({
      text: "Final composed image prompt",
      modelId: "openai/gpt-5-mini",
    }));
    const generateImageMock = jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));

    await definition!.execute(
      createContext({
        nodeId: "image-node",
        kind: "studio.image_generation",
        config: {
          systemPrompt: "Use this style guide for {{prompt}}",
        },
        inputs: {
          prompt: "Make a cinematic frame",
        },
        generateTextMock,
        generateImageMock,
      })
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Make a cinematic frame",
        systemPrompt: expect.stringContaining("Use this style guide for Make a cinematic frame"),
      })
    );
    const imageRequest = generateImageMock.mock.calls[0]?.[0];
    expect(imageRequest.prompt).toBe("Final composed image prompt");
  });

  it("truncates oversized plain image prompts before API submission", async () => {
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateTextMock = jest.fn(async () => ({
      text: "unused",
      modelId: "openai/gpt-5-mini",
    }));
    const generateImageMock = jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));

    await definition!.execute(
      createContext({
        nodeId: "image-node",
        kind: "studio.image_generation",
        inputs: {
          prompt: "z".repeat(12_000),
        },
        generateTextMock,
        generateImageMock,
      })
    );

    expect(generateTextMock).not.toHaveBeenCalled();
    const imageRequest = generateImageMock.mock.calls[0]?.[0];
    expect(typeof imageRequest.prompt).toBe("string");
    expect(String(imageRequest.prompt).length).toBeLessThanOrEqual(7_900);
  });

  it("passes prompt-embedded input images through to image generation API", async () => {
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateImageMock = jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));

    await definition!.execute(
      createContext({
        nodeId: "image-node",
        kind: "studio.image_generation",
        inputs: {
          prompt: {
            systemPrompt: "Prompt system",
            userMessage: "Prompt user",
            input_images: [
              {
                path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/ab/asset-a.png",
                mimeType: "image/png",
                hash: "hash-asset-a",
                sizeBytes: 128,
              },
            ],
          },
        },
        generateImageMock,
      })
    );

    const imageRequest = generateImageMock.mock.calls[0]?.[0];
    expect(imageRequest.inputImages).toEqual([
      {
        path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/ab/asset-a.png",
        mimeType: "image/png",
        hash: "hash-asset-a",
        sizeBytes: 128,
      },
    ]);
  });

  it("resolves direct image-path inputs into stored image assets before generation", async () => {
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateImageMock = jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));
    const context = createContext({
      nodeId: "image-node",
      kind: "studio.image_generation",
      inputs: {
        prompt: "Generate image prompt",
        images: [
          "/Users/systemsculpt/Downloads/reference.png",
          "SystemSculpt/Assets/reference.webp",
        ],
      },
      generateImageMock,
    });
    context.services.readLocalFileBinary = jest.fn(async () => new ArrayBuffer(4));
    context.services.readVaultBinary = jest.fn(async () => new ArrayBuffer(6));
    context.services.storeAsset = jest
      .fn()
      .mockResolvedValueOnce({
        path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/aa/local.png",
        mimeType: "image/png",
        hash: "hash-local",
        sizeBytes: 4,
      })
      .mockResolvedValueOnce({
        path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/bb/vault.webp",
        mimeType: "image/webp",
        hash: "hash-vault",
        sizeBytes: 6,
      });

    await definition!.execute(context);

    expect(context.services.readLocalFileBinary).toHaveBeenCalledWith(
      "/Users/systemsculpt/Downloads/reference.png"
    );
    expect(context.services.readVaultBinary).toHaveBeenCalledWith("SystemSculpt/Assets/reference.webp");
    const imageRequest = generateImageMock.mock.calls[0]?.[0];
    expect(imageRequest.inputImages).toEqual([
      {
        path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/aa/local.png",
        mimeType: "image/png",
        hash: "hash-local",
        sizeBytes: 4,
      },
      {
        path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/bb/vault.webp",
        mimeType: "image/webp",
        hash: "hash-vault",
        sizeBytes: 6,
      },
    ]);
  });

  it("fails loudly when legacy local provider config is still present", async () => {
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateImageMock = jest.fn(async () => ({ images: [], modelId: "openai/gpt-5-image-mini" }));

    await expect(
      definition!.execute(
        createContext({
          nodeId: "image-node",
          kind: "studio.image_generation",
          config: {
            provider: "local_macos_image_generation",
          },
          inputs: {
            prompt: "Generate locally",
          },
          generateImageMock,
        })
      )
    ).rejects.toThrow("configured for removed provider");
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("media ingest resolves slot-indexed path from image output arrays", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "media-node",
        kind: "studio.media_ingest",
        config: {
          __studio_source_output_index: 1,
          sourcePath: "/tmp/fallback.png",
        },
        inputs: {
          media: [
            { path: "SystemSculpt/Assets/first.png", mimeType: "image/png" },
            { path: "SystemSculpt/Assets/second.png", mimeType: "image/png" },
          ],
        },
      })
    );

    expect(result.outputs.path).toBe("SystemSculpt/Assets/second.png");
    expect(result.outputs.preview_path).toBe("");
    expect(result.outputs.preview_error).toBe("");
  });

  it("media ingest keeps pinned generated-media source paths stable across reruns", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "media-node",
        kind: "studio.media_ingest",
        config: {
          __studio_managed_by: "studio.image_generation_output.v1",
          __studio_source_output_index: 0,
          sourcePath: "SystemSculpt/Assets/pinned.png",
        },
        inputs: {
          media: [{ path: "SystemSculpt/Assets/newest.png", mimeType: "image/png" }],
        },
      })
    );

    expect(result.outputs.path).toBe("SystemSculpt/Assets/pinned.png");
    expect(result.outputs.preview_path).toBe("");
    expect(result.outputs.preview_error).toBe("");
  });

  it("media ingest stages preview assets for absolute local videos", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();
    const context = createContext({
      nodeId: "media-node",
      kind: "studio.media_ingest",
      config: {
        sourcePath: "/Users/systemsculpt/Downloads/demo.mp4",
      },
    });
    context.services.readLocalFileBinary = jest.fn(async () => new ArrayBuffer(8));
    context.services.storeAsset = jest.fn(async (_bytes, _mimeType) => ({
      hash: "hash",
      mimeType: "video/mp4",
      sizeBytes: 8,
      path: "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/aa/demo.mp4",
    }));

    const result = await definition!.execute(context);

    expect(context.services.readLocalFileBinary).toHaveBeenCalledWith(
      "/Users/systemsculpt/Downloads/demo.mp4"
    );
    expect(context.services.storeAsset).toHaveBeenCalledWith(expect.any(ArrayBuffer), "video/mp4");
    expect(result.outputs.path).toBe("/Users/systemsculpt/Downloads/demo.mp4");
    expect(result.outputs.preview_path).toBe(
      "SystemSculpt/Studio/Test.systemsculpt-assets/assets/sha256/aa/demo.mp4"
    );
    expect(result.outputs.preview_error).toBe("");
  });

  it("media ingest continues when large local preview staging fails", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();
    const context = createContext({
      nodeId: "media-node",
      kind: "studio.media_ingest",
      config: {
        sourcePath: "/Users/systemsculpt/Downloads/huge.mp4",
      },
    });
    context.services.readLocalFileBinary = jest.fn(async () => {
      throw new RangeError("File size (6197945410) is greater than 2 GiB");
    });
    context.services.storeAsset = jest.fn(async (_bytes, _mimeType) => ({
      hash: "hash",
      mimeType: "video/mp4",
      sizeBytes: 8,
      path: "should-not-be-used",
    }));

    const result = await definition!.execute(context);

    expect(result.outputs.path).toBe("/Users/systemsculpt/Downloads/huge.mp4");
    expect(result.outputs.preview_path).toBe("");
    expect(String(result.outputs.preview_error || "")).toContain("greater than 2 GiB");
    expect(context.services.storeAsset).not.toHaveBeenCalled();
  });
});
