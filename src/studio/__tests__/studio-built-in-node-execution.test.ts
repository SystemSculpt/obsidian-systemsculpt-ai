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
  readVaultBinaryMock?: jest.Mock;
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
  const readVaultBinaryMock = options.readVaultBinaryMock || jest.fn(async () => new ArrayBuffer(0));
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
      readVaultBinary: readVaultBinaryMock,
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

function tinyPngBytes(): ArrayBuffer {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00,
    0x02, 0x00, 0x01, 0xe5, 0x27, 0xd4, 0xa2, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]).buffer;
}

function captionBoardBaseSvgBytes(): ArrayBuffer {
  return new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#1c2f27"/></svg>'
  ).buffer;
}

describe("Studio built-in text/image node execution", () => {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);

  it("text node emits configured text for downstream nodes", async () => {
    const definition = registry.get("studio.text_output", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.text_output",
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
    const definition = registry.get("studio.text_output", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.text_output",
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

  it("json node emits configured JSON when input is not connected", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        config: {
          value: {
            from: "mike@systemsculpt.com",
            subject: "Payout ready",
          },
        },
      })
    );

    expect(result.outputs.json).toEqual({
      from: "mike@systemsculpt.com",
      subject: "Payout ready",
    });
  });

  it("json node defaults to an empty object for brand-new nodes", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        config: {},
        inputs: {},
      })
    );

    expect(result.outputs.json).toEqual({});
  });

  it("json node parses valid JSON text input into structured output", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        inputs: {
          text: "{\"from\":\"SystemSculpt <no-reply@systemsculpt.com>\",\"to\":[\"mike@example.com\"]}",
        },
      })
    );

    expect(result.outputs.json).toEqual({
      from: "SystemSculpt <no-reply@systemsculpt.com>",
      to: ["mike@example.com"],
    });
  });

  it("json node accepts fenced JSON text payloads", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        inputs: {
          text: "```json\n{\"subject\":\"Campaign test\",\"reply_to\":\"mike@example.com\"}\n```",
        },
      })
    );

    expect(result.outputs.json).toEqual({
      subject: "Campaign test",
      reply_to: "mike@example.com",
    });
  });

  it("json node auto-repairs unescaped html attribute quotes inside JSON strings", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        inputs: {
          text:
            '{"subject":"Campaign test","html":"<p>Hi</p><p><a href="https://systemsculpt.com/business/apply">Apply</a></p>"}',
        },
      })
    );

    expect(result.outputs.json).toEqual({
      subject: "Campaign test",
      html: '<p>Hi</p><p><a href="https://systemsculpt.com/business/apply">Apply</a></p>',
    });
  });

  it("json node extracts and parses wrapped JSON content", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        inputs: {
          text: 'Here is your payload:\n{"subject":"Campaign test","to":["mike@example.com"]}\nThanks!',
        },
      })
    );

    expect(result.outputs.json).toEqual({
      subject: "Campaign test",
      to: ["mike@example.com"],
    });
  });

  it("json node auto-repairs truncated unterminated JSON string/object endings", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    const result = await definition!.execute(
      createContext({
        nodeId: "json-node",
        kind: "studio.json",
        inputs: {
          text:
            '{"from":"SystemSculpt <no-reply@systemsculpt.com>","subject":"Campaign","html":"<p>Hi</p><p>I am opening a few spots for prior buyers',
        },
      })
    );

    expect(result.outputs.json).toEqual({
      from: "SystemSculpt <no-reply@systemsculpt.com>",
      subject: "Campaign",
      html: "<p>Hi</p><p>I am opening a few spots for prior buyers",
    });
  });

  it("json node throws for invalid JSON text input with actionable guidance", async () => {
    const definition = registry.get("studio.json", "1.0.0");
    expect(definition).toBeDefined();

    await expect(
      definition!.execute(
        createContext({
          nodeId: "json-node",
          kind: "studio.json",
          inputs: {
            text: "{\"subject\":}",
          },
        })
      )
    ).rejects.toThrow("Fix the input JSON and rerun");
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
          notes: {
            items: [
              {
                path: "Inbox/Launch Plan.md",
                enabled: true,
              },
            ],
          },
        },
        readVaultTextMock,
      })
    );

    expect(readVaultTextMock).toHaveBeenCalledWith("Inbox/Launch Plan.md");
    expect(result.outputs.text).toBe("Live note body");
    expect(result.outputs.path).toBe("Inbox/Launch Plan.md");
    expect(result.outputs.title).toBe("Launch Plan");
  });

  it("note node prepends preface text before single-note output", async () => {
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).toBeDefined();
    const readVaultTextMock = jest.fn(async () => "Live note body");

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.note",
        config: {
          preface: "Use this note as factual context for the draft.",
          notes: {
            items: [{ path: "Inbox/Launch Plan.md", enabled: true }],
          },
        },
        readVaultTextMock,
      })
    );

    expect(result.outputs.text).toBe(
      "Use this note as factual context for the draft.\n\nLive note body"
    );
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
            notes: {
              items: [
                {
                  path: "Inbox/Audio.m4a",
                  enabled: true,
                },
              ],
            },
          },
        })
      )
    ).rejects.toThrow("only supports markdown files");
  });

  it("note node emits array outputs when multiple notes are enabled", async () => {
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).toBeDefined();
    const readVaultTextMock = jest.fn(async (path: string) => `Body for ${path}`);

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.note",
        config: {
          notes: {
            items: [
              { path: "Inbox/First.md", enabled: true },
              { path: "Inbox/Second.md", enabled: true },
            ],
          },
        },
        readVaultTextMock,
      })
    );

    expect(readVaultTextMock).toHaveBeenCalledTimes(2);
    expect(result.outputs.path).toEqual(["Inbox/First.md", "Inbox/Second.md"]);
    expect(result.outputs.title).toEqual(["First", "Second"]);
    expect(result.outputs.text).toEqual([
      "Body for Inbox/First.md",
      "Body for Inbox/Second.md",
    ]);
  });

  it("note node prepends preface text to the first entry for multi-note output", async () => {
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).toBeDefined();
    const readVaultTextMock = jest.fn(async (path: string) => `Body for ${path}`);

    const result = await definition!.execute(
      createContext({
        nodeId: "note-node",
        kind: "studio.note",
        config: {
          preface: "Treat the following notes as input context only.",
          notes: {
            items: [
              { path: "Inbox/First.md", enabled: true },
              { path: "Inbox/Second.md", enabled: true },
            ],
          },
        },
        readVaultTextMock,
      })
    );

    expect(result.outputs.path).toEqual(["Inbox/First.md", "Inbox/Second.md"]);
    expect(result.outputs.title).toEqual(["First", "Second"]);
    expect(result.outputs.text).toEqual([
      "Treat the following notes as input context only.\n\nBody for Inbox/First.md",
      "Body for Inbox/Second.md",
    ]);
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
    expect(result.outputs.preview_path).toBe("asset.bin");
    expect(result.outputs.preview_error).toBe("");
    expect(result.outputs.preview_asset).toEqual({
      hash: "hash",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      path: "asset.bin",
    });
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
    expect(result.outputs.preview_path).toBe("asset.bin");
    expect(result.outputs.preview_error).toBe("");
    expect(result.outputs.preview_asset).toEqual({
      hash: "hash",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      path: "asset.bin",
    });
  });

  it("media ingest composes captioned image outputs for ingested images", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();
    const previewAsset = {
      hash: "base-hash",
      mimeType: "image/svg+xml",
      sizeBytes: captionBoardBaseSvgBytes().byteLength,
      path: "Studio/Test.systemsculpt-assets/assets/sha256/ab/base.svg",
    };
    const captionedAsset = {
      hash: "caption-hash",
      mimeType: "image/svg+xml",
      sizeBytes: 512,
      path: "Studio/Test.systemsculpt-assets/assets/sha256/cd/captioned.svg",
    };
    const storeAssetMock = jest
      .fn()
      .mockResolvedValueOnce(previewAsset)
      .mockResolvedValueOnce(captionedAsset);
    const context = createContext({
      nodeId: "media-node",
      kind: "studio.media_ingest",
      config: {
        sourcePath: "Assets/source.svg",
        captionBoard: {
          version: 1,
          labels: [
            {
              id: "label-1",
              text: "Quarterly update",
              x: 0.16,
              y: 0.12,
              width: 0.52,
              height: 0.24,
              fontSize: 56,
              textAlign: "center",
              textColor: "#ffffff",
              styleVariant: "banner",
              zIndex: 0,
            },
          ],
          sourceAssetPath: "",
          lastRenderedAsset: null,
          updatedAt: "2026-03-22T00:00:00.000Z",
        },
      },
      storeAssetMock,
      readVaultBinaryMock: jest.fn(async () => captionBoardBaseSvgBytes()),
      readAssetMock: jest.fn(async () => captionBoardBaseSvgBytes()),
    });

    const result = await definition!.execute(context);

    expect(context.services.readVaultBinary).toHaveBeenCalledWith("Assets/source.svg");
    expect(storeAssetMock).toHaveBeenNthCalledWith(1, expect.any(ArrayBuffer), "image/svg+xml");
    expect(storeAssetMock).toHaveBeenNthCalledWith(2, expect.any(ArrayBuffer), "image/svg+xml");
    const svg = new TextDecoder().decode(storeAssetMock.mock.calls[1][0]);
    expect(svg).toContain("Quarterly update");
    expect(result.outputs.path).toBe(captionedAsset.path);
    expect(result.outputs.preview_path).toBe(captionedAsset.path);
    expect(result.outputs.source_preview_path).toBe(previewAsset.path);
    expect(result.outputs.preview_asset).toEqual(captionedAsset);
    expect(result.outputs.source_preview_asset).toEqual(previewAsset);
    expect(result.artifacts).toEqual([captionedAsset]);
  });

  it("media ingest composes crop, blur, and highlight overlays for image-editor edits", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();
    const previewAsset = {
      hash: "base-hash",
      mimeType: "image/svg+xml",
      sizeBytes: captionBoardBaseSvgBytes().byteLength,
      path: "Studio/Test.systemsculpt-assets/assets/sha256/ab/base.svg",
    };
    const editedAsset = {
      hash: "edited-hash",
      mimeType: "image/svg+xml",
      sizeBytes: 768,
      path: "Studio/Test.systemsculpt-assets/assets/sha256/ef/edited.svg",
    };
    const storeAssetMock = jest
      .fn()
      .mockResolvedValueOnce(previewAsset)
      .mockResolvedValueOnce(editedAsset);
    const context = createContext({
      nodeId: "media-node",
      kind: "studio.media_ingest",
      config: {
        sourcePath: "Assets/source.svg",
        captionBoard: {
          version: 1,
          labels: [],
          annotations: [
            {
              id: "annotation-circle",
              kind: "highlight_circle",
              x: 0.22,
              y: 0.18,
              width: 0.28,
              height: 0.22,
              color: "#ff4d4f",
              strokeWidth: 8,
              blurRadius: 16,
              zIndex: 0,
            },
            {
              id: "annotation-blur",
              kind: "blur_rect",
              x: 0.54,
              y: 0.24,
              width: 0.22,
              height: 0.2,
              color: "#ff4d4f",
              strokeWidth: 8,
              blurRadius: 20,
              zIndex: 1,
            },
          ],
          crop: {
            x: 0.1,
            y: 0.1,
            width: 0.6,
            height: 0.5,
          },
          sourceAssetPath: "",
          lastRenderedAsset: null,
          updatedAt: "2026-03-22T00:00:00.000Z",
        },
      },
      storeAssetMock,
      readVaultBinaryMock: jest.fn(async () => captionBoardBaseSvgBytes()),
      readAssetMock: jest.fn(async () => captionBoardBaseSvgBytes()),
    });

    const result = await definition!.execute(context);

    expect(context.services.readVaultBinary).toHaveBeenCalledWith("Assets/source.svg");
    expect(storeAssetMock).toHaveBeenNthCalledWith(1, expect.any(ArrayBuffer), "image/svg+xml");
    expect(storeAssetMock).toHaveBeenNthCalledWith(2, expect.any(ArrayBuffer), "image/svg+xml");
    const svg = new TextDecoder().decode(storeAssetMock.mock.calls[1][0]);
    expect(svg).toContain("feGaussianBlur");
    expect(svg).toContain("<ellipse");
    expect(svg).toContain('viewBox="120.00 80.00 720.00 400.00"');
    expect(result.outputs.path).toBe(editedAsset.path);
    expect(result.outputs.preview_path).toBe(editedAsset.path);
    expect(result.outputs.source_preview_path).toBe(previewAsset.path);
    expect(result.outputs.preview_asset).toEqual(editedAsset);
    expect(result.outputs.source_preview_asset).toEqual(previewAsset);
    expect(result.artifacts).toEqual([editedAsset]);
  });

  it("media ingest stages preview assets for absolute local videos", async () => {
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).toBeDefined();
    const context = createContext({
      nodeId: "media-node",
      kind: "studio.media_ingest",
      config: {
        sourcePath: "/mock/downloads/demo.mp4",
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
      "/mock/downloads/demo.mp4"
    );
    expect(context.services.storeAsset).toHaveBeenCalledWith(expect.any(ArrayBuffer), "video/mp4");
    expect(result.outputs.path).toBe("/mock/downloads/demo.mp4");
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
        sourcePath: "/mock/downloads/huge.mp4",
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

    expect(result.outputs.path).toBe("/mock/downloads/huge.mp4");
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
          workingDirectory: "/workspace/adapter-project",
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
          workingDirectory: "/workspace/adapter-project",
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
          workingDirectory: "/workspace/adapter-project",
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
          workingDirectory: "/workspace/adapter-project",
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
