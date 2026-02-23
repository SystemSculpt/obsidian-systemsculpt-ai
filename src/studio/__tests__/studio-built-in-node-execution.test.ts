import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  readVaultTextMock?: jest.Mock;
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
  const readVaultTextMock = options.readVaultTextMock || jest.fn(async () => "");
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
      readVaultText: readVaultTextMock,
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

  it("json node passes through structured JSON input", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        inputs: {
          json: {
            emails: ["a@example.com", "b@example.com"],
            total: 2,
          },
        },
      })
    );

    expect(result.outputs.json).toEqual({
      emails: ["a@example.com", "b@example.com"],
      total: 2,
    });
  });

  it("note node reads markdown text from the vault and emits text/path/title", async () => {
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).toBeDefined();
    const readVaultTextMock = jest.fn(async () => "Live note body");

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.note",
        config: {
          vaultPath: "Inbox/Launch Plan.md",
          value: "",
        },
        readVaultTextMock,
      })
    );

    expect(readVaultTextMock).toHaveBeenCalledWith("Inbox/Launch Plan.md");
    expect(result.outputs.text).toBe("Live note body");
    expect(result.outputs.path).toBe("Inbox/Launch Plan.md");
    expect(result.outputs.title).toBe("Launch Plan");
  });

  it("note node rejects non-markdown paths", async () => {
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).toBeDefined();

    await expect(
      definition!.execute(
        createContext({
          nodeId: "note-node",
          kind: "studio.note",
          config: {
            vaultPath: "Inbox/Audio.m4a",
          },
        })
      )
    ).rejects.toThrow("only supports markdown files");
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
        sourceMode: "systemsculpt",
        modelId: "openai/gpt-5-mini",
        localModelId: undefined,
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
        sourceMode: "systemsculpt",
        modelId: "openai/gpt-5-mini",
        localModelId: undefined,
      })
    );
    expect(result.outputs.text).toBe("Generated body");
  });

  it("routes text generation to Local Pi when source mode is local_pi", async () => {
    const definition = registry.get("studio.text_generation", "1.0.0");
    expect(definition).toBeDefined();
    const generateTextMock = jest.fn(async () => ({
      text: "Local output",
      modelId: "ollama@@llama3.1:8b",
    }));

    const result = await definition!.execute(
      createContext({
        nodeId: "text-node",
        kind: "studio.text_generation",
        config: {
          sourceMode: "local_pi",
          localModelId: "ollama@@llama3.1:8b",
          modelId: "openai/gpt-5-mini",
        },
        inputs: {
          prompt: "Use local model.",
        },
        generateTextMock,
      })
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Use local model.",
        sourceMode: "local_pi",
        localModelId: "ollama@@llama3.1:8b",
        modelId: "openai/gpt-5-mini",
      })
    );
    expect(result.outputs.text).toBe("Local output");
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

  it("dataset node caches outputs and skips re-running the adapter command while fresh", async () => {
    const definition = registry.get("studio.dataset", "1.0.0");
    expect(definition).toBeDefined();
    const tempRoot = await mkdtemp(join(tmpdir(), "studio-dataset-cache-"));
    const runCliMock = jest
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "{\"rows\":[{\"email\":\"a@example.com\"}]}", stderr: "", timedOut: false });

    try {
      const firstContext = createContext({
        nodeId: "dataset-node",
        kind: "studio.dataset",
        config: {
          workingDirectory: "/Users/systemsculpt/gits/systemsculpt-website",
          customQuery: "SELECT 1;",
          refreshHours: 6,
          timeoutMs: 60_000,
          maxOutputBytes: 512 * 1024,
        },
        runCliMock,
      });
      firstContext.services.resolveAbsolutePath = (path) => join(tempRoot, path);
      firstContext.services.assertFilesystemPath = jest.fn();

      const firstResult = await definition!.execute(firstContext);
      expect(runCliMock).toHaveBeenCalledTimes(1);
      expect(firstResult.outputs.text).toBe("{\"rows\":[{\"email\":\"a@example.com\"}]}");
      expect(firstResult.outputs.email).toEqual(["a@example.com"]);
      expect(runCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "node",
          args: ["scripts/db-query.js", "SELECT 1;"],
        })
      );

      const secondContext = createContext({
        nodeId: "dataset-node",
        kind: "studio.dataset",
        config: {
          workingDirectory: "/Users/systemsculpt/gits/systemsculpt-website",
          customQuery: "SELECT 1;",
          refreshHours: 6,
          timeoutMs: 60_000,
          maxOutputBytes: 512 * 1024,
        },
        runCliMock,
      });
      secondContext.services.resolveAbsolutePath = (path) => join(tempRoot, path);
      secondContext.services.assertFilesystemPath = jest.fn();

      const secondResult = await definition!.execute(secondContext);
      expect(runCliMock).toHaveBeenCalledTimes(1);
      expect(secondResult.outputs.text).toBe("{\"rows\":[{\"email\":\"a@example.com\"}]}");
      expect(secondResult.outputs.email).toEqual(["a@example.com"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("dataset node supports custom adapter args and always exposes query in env", async () => {
    const definition = registry.get("studio.dataset", "1.0.0");
    expect(definition).toBeDefined();
    const tempRoot = await mkdtemp(join(tmpdir(), "studio-dataset-adapter-"));
    const runCliMock = jest
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "{\"ok\":true}", stderr: "", timedOut: false });

    try {
      const context = createContext({
        nodeId: "dataset-node",
        kind: "studio.dataset",
        config: {
          workingDirectory: "/Users/systemsculpt/gits/systemsculpt-website",
          customQuery: "SELECT email FROM users LIMIT 5;",
          adapterCommand: "node",
          adapterArgs: ["scripts/custom-adapter.js", "--query", "{{query}}"],
          refreshHours: 6,
          timeoutMs: 60_000,
          maxOutputBytes: 512 * 1024,
        },
        runCliMock,
      });
      context.services.resolveAbsolutePath = (path) => join(tempRoot, path);
      context.services.assertFilesystemPath = jest.fn();

      const result = await definition!.execute(context);

      expect(result.outputs.text).toBe("{\"ok\":true}");
      expect(result.outputs.ok).toEqual([true]);
      expect(runCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "node",
          args: ["scripts/custom-adapter.js", "--query", "SELECT email FROM users LIMIT 5;"],
          env: expect.objectContaining({
            STUDIO_DATASET_QUERY: "SELECT email FROM users LIMIT 5;",
          }),
        })
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("dataset node derives reusable field outputs from console.table stdout", async () => {
    const definition = registry.get("studio.dataset", "1.0.0");
    expect(definition).toBeDefined();
    const tempRoot = await mkdtemp(join(tmpdir(), "studio-dataset-table-"));
    const runCliMock = jest.fn().mockResolvedValue({
      exitCode: 0,
      stdout: [
        "\u2502 (index) \u2502 email \u2502 revenue \u2502",
        "\u2502 0 \u2502 'a@example.com' \u2502 19900 \u2502",
        "\u2502 1 \u2502 'b@example.com' \u2502 24900 \u2502",
        "",
      ].join("\n"),
      stderr: "",
      timedOut: false,
    });

    try {
      const context = createContext({
        nodeId: "dataset-node",
        kind: "studio.dataset",
        config: {
          workingDirectory: "/Users/systemsculpt/gits/systemsculpt-website",
          customQuery: "SELECT email, revenue FROM users LIMIT 2;",
          refreshHours: 6,
          timeoutMs: 60_000,
          maxOutputBytes: 512 * 1024,
        },
        runCliMock,
      });
      context.services.resolveAbsolutePath = (path) => join(tempRoot, path);
      context.services.assertFilesystemPath = jest.fn();

      const result = await definition!.execute(context);

      expect(result.outputs.email).toEqual(["a@example.com", "b@example.com"]);
      expect(result.outputs.revenue).toEqual([19900, 24900]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
