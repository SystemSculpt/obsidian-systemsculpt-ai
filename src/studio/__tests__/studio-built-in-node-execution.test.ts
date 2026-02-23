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
      storeAsset: async () => ({
        hash: "hash",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        path: "asset.bin",
      }),
      readAsset: async () => new ArrayBuffer(0),
      resolveAbsolutePath: (path) => path,
      readVaultBinary: async () => new ArrayBuffer(0),
      readLocalFileBinary: async () => new ArrayBuffer(0),
      writeTempFile: async () => "/tmp/file.bin",
      deleteLocalFile: async () => {},
      runCli: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      assertFilesystemPath: () => {},
      assertNetworkUrl: () => {},
    },
    log: () => {},
  };
}

describe("Studio built-in prompt/text node execution", () => {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);

  it("prompt template emits structured prompt payload with system+user data", async () => {
    const definition = registry.get("studio.prompt_template", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "prompt-node",
        kind: "studio.prompt_template",
        config: {
          template: "Generate a YouTube title from this transcript.",
        },
        inputs: {
          text: "Today we reviewed a long tutorial about graph workflows.",
        },
      })
    );

    expect(result.outputs.prompt).toEqual({
      systemPrompt: "Generate a YouTube title from this transcript.",
      userMessage: "Today we reviewed a long tutorial about graph workflows.",
      prompt: "Today we reviewed a long tutorial about graph workflows.",
      text: "Today we reviewed a long tutorial about graph workflows.",
    });
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
      })
    );
    expect(result.outputs.text).toBe("Title: Graph Workflow Deep Dive");
  });

  it("rejects text generation when prompt payload is missing systemPrompt", async () => {
    const definition = registry.get("studio.text_generation", "1.0.0");
    expect(definition).toBeDefined();

    await expect(
      definition!.execute(
        createContext({
          nodeId: "text-node",
          kind: "studio.text_generation",
          config: {
            modelId: "openai/gpt-5-mini",
          },
          inputs: {
            prompt: "Plain user prompt",
          },
        })
      )
    ).rejects.toThrow("requires prompt input with both systemPrompt and userMessage");
  });

  it("rejects prompt template execution when text input is missing", async () => {
    const definition = registry.get("studio.prompt_template", "1.0.0");
    expect(definition).toBeDefined();

    await expect(
      definition!.execute(
        createContext({
          nodeId: "prompt-node",
          kind: "studio.prompt_template",
          config: {
            template: "System instruction",
          },
          inputs: {},
        })
      )
    ).rejects.toThrow("requires both a system prompt template result and a text input");
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
    const imageRequest = generateImageMock.mock.calls[0]?.[0];
    expect(typeof imageRequest.prompt).toBe("string");
    expect(String(imageRequest.prompt).length).toBeLessThanOrEqual(7_900);
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
