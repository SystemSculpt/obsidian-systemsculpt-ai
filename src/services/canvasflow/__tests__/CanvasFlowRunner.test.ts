import { TFile } from "obsidian";
import { parseCanvasDocument } from "../CanvasFlowGraph";
import { CanvasFlowRunner } from "../CanvasFlowRunner";

describe("CanvasFlowRunner placeholders", () => {
  it("replaces generation placeholders with file nodes on success", async () => {
    const canvasFile = new TFile({
      path: "Canvas/Scene.canvas",
      name: "Scene.canvas",
      extension: "canvas",
    });
    const promptFile = new TFile({
      path: "Prompts/Scene Prompt.md",
      name: "Scene Prompt.md",
      extension: "md",
    });

    let canvasRaw = JSON.stringify({
      nodes: [
        {
          id: "prompt-node",
          type: "file",
          file: promptFile.path,
          x: 100,
          y: 200,
          width: 420,
          height: 260,
        },
      ],
      edges: [],
    });
    const promptRaw = [
      "---",
      "ss_flow_kind: prompt",
      "ss_image_model: openai/gpt-image-1",
      "ss_image_count: 2",
      "ss_image_aspect_ratio: 16:9",
      "---",
      "",
      "A cinematic landscape at sunset.",
      "",
    ].join("\n");

    const app: any = {
      vault: {
        read: jest.fn(async (file: TFile) => {
          if (file.path === canvasFile.path) return canvasRaw;
          if (file.path === promptFile.path) return promptRaw;
          throw new Error(`Unexpected read: ${file.path}`);
        }),
        readBinary: jest.fn(),
        modify: jest.fn(async (file: TFile, content: string) => {
          if (file.path === canvasFile.path) {
            canvasRaw = content;
            return;
          }
        }),
        createBinary: jest.fn(async () => {}),
        create: jest.fn(async () => {}),
        createFolder: jest.fn(async () => {}),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === promptFile.path) return promptFile;
          return null;
        }),
        adapter: {
          exists: jest.fn(async () => false),
        },
      },
    };

    const mockClient: any = {
      createGenerationJob: jest.fn(async () => ({
        job: { id: "job_123", status: "queued" },
        poll_url: "https://example.com/poll/job_123",
      })),
      waitForGenerationJob: jest.fn(async () => ({
        job: { id: "job_123", status: "succeeded" },
        outputs: [
          { index: 1, url: "https://cdn.example.com/out-1.png", mime_type: "image/png" },
          { index: 2, url: "https://cdn.example.com/out-2.png", mime_type: "image/png" },
        ],
      })),
      downloadImage: jest.fn(async () => ({
        arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
        contentType: "image/png",
      })),
    };

    const plugin: any = {
      manifest: { version: "0.0.0-test" },
      settings: {
        licenseKey: "license_test",
        serverUrl: "https://example.com",
        imageGenerationDefaultModelId: "openai/gpt-image-1",
        imageGenerationPollIntervalMs: 1,
        imageGenerationOutputDir: "CanvasFlow",
        imageGenerationSaveMetadataSidecar: false,
        imageGenerationModelCatalogCache: null,
      },
    };

    const runner = new CanvasFlowRunner(app, plugin, {
      imageClientFactory: () => mockClient,
    });

    await runner.runPromptNode({
      canvasFile,
      promptNodeId: "prompt-node",
    });

    const parsed = parseCanvasDocument(canvasRaw);
    expect(parsed).not.toBeNull();

    const nodes = parsed!.nodes;
    const promptNodes = nodes.filter((node) => node.id === "prompt-node");
    expect(promptNodes).toHaveLength(1);

    const generatedNodes = nodes.filter((node) => node.type === "file" && node.id !== "prompt-node");
    expect(generatedNodes).toHaveLength(2);
    expect(
      generatedNodes.every((node) =>
        String(node.file || "").startsWith("SystemSculpt/Attachments/Generations/CanvasFlow/")
      )
    ).toBe(true);

    const lingeringPlaceholderTextNodes = nodes.filter((node) => node.type === "text");
    expect(lingeringPlaceholderTextNodes).toHaveLength(0);
  });

  it("tops up additional generation runs when a batch returns fewer outputs than requested", async () => {
    const canvasFile = new TFile({
      path: "Canvas/Scene.canvas",
      name: "Scene.canvas",
      extension: "canvas",
    });
    const promptFile = new TFile({
      path: "Prompts/Scene Prompt.md",
      name: "Scene Prompt.md",
      extension: "md",
    });

    let canvasRaw = JSON.stringify({
      nodes: [
        {
          id: "prompt-node",
          type: "file",
          file: promptFile.path,
          x: 100,
          y: 200,
          width: 420,
          height: 260,
        },
      ],
      edges: [],
    });
    const promptRaw = [
      "---",
      "ss_flow_kind: prompt",
      "ss_image_model: openai/gpt-image-1",
      "ss_image_count: 2",
      "ss_image_aspect_ratio: 1:1",
      "---",
      "",
      "A surreal scene.",
      "",
    ].join("\n");

    const app: any = {
      vault: {
        read: jest.fn(async (file: TFile) => {
          if (file.path === canvasFile.path) return canvasRaw;
          if (file.path === promptFile.path) return promptRaw;
          throw new Error(`Unexpected read: ${file.path}`);
        }),
        readBinary: jest.fn(),
        modify: jest.fn(async (file: TFile, content: string) => {
          if (file.path === canvasFile.path) {
            canvasRaw = content;
            return;
          }
        }),
        createBinary: jest.fn(async () => {}),
        create: jest.fn(async () => {}),
        createFolder: jest.fn(async () => {}),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === promptFile.path) return promptFile;
          return null;
        }),
        adapter: {
          exists: jest.fn(async () => false),
        },
      },
    };

    const mockClient: any = {
      createGenerationJob: jest.fn(async () => ({
        job: { id: "job_123", status: "queued" },
        poll_url: "https://example.com/poll/job_123",
      })),
      waitForGenerationJob: jest
        .fn()
        .mockResolvedValueOnce({
          job: { id: "job_123", status: "succeeded" },
          outputs: [{ index: 1, url: "https://cdn.example.com/out-1.png", mime_type: "image/png" }],
        })
        .mockResolvedValueOnce({
          job: { id: "job_124", status: "succeeded" },
          outputs: [{ index: 1, url: "https://cdn.example.com/out-2.png", mime_type: "image/png" }],
        }),
      downloadImage: jest.fn(async () => ({
        arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
        contentType: "image/png",
      })),
    };

    const plugin: any = {
      manifest: { version: "0.0.0-test" },
      settings: {
        licenseKey: "license_test",
        serverUrl: "https://example.com",
        imageGenerationDefaultModelId: "openai/gpt-image-1",
        imageGenerationPollIntervalMs: 1,
        imageGenerationOutputDir: "CanvasFlow",
        imageGenerationSaveMetadataSidecar: false,
        imageGenerationModelCatalogCache: null,
      },
    };

    const runner = new CanvasFlowRunner(app, plugin, {
      imageClientFactory: () => mockClient,
    });

    await runner.runPromptNode({
      canvasFile,
      promptNodeId: "prompt-node",
    });

    expect(mockClient.createGenerationJob).toHaveBeenCalledTimes(2);
    expect(mockClient.waitForGenerationJob).toHaveBeenCalledTimes(2);

    const parsed = parseCanvasDocument(canvasRaw);
    expect(parsed).not.toBeNull();
    const generatedNodes = parsed!.nodes.filter((node) => node.type === "file" && node.id !== "prompt-node");
    expect(generatedNodes).toHaveLength(2);
  });
});
