import { TFile } from "obsidian";
import { createCanvasFlowPromptNodeInActiveCanvas } from "../CanvasFlowCommands";

describe("CanvasFlowCommands", () => {
  const createHarness = (settingsOverrides: Record<string, unknown>) => {
    const canvasFile = new TFile({
      path: "Canvas/Scene.canvas",
      name: "Scene.canvas",
      extension: "canvas",
    });
    const promptFilePath = "SystemSculpt/CanvasFlow/Prompts/SystemSculpt Prompt Test.md";
    let createdContent = "";

    const app: any = {
      workspace: {
        activeLeaf: {
          view: {
            getViewType: () => "canvas",
            file: canvasFile,
          },
        },
      },
      vault: {
        read: jest.fn(async (file: TFile) => {
          if (file.path === canvasFile.path) {
            return JSON.stringify({ nodes: [], edges: [] });
          }
          throw new Error(`Unexpected read: ${file.path}`);
        }),
        adapter: {
          exists: jest.fn(async () => false),
        },
        createFolder: jest.fn(async () => {}),
        getAbstractFileByPath: jest.fn((_path: string) => null),
        create: jest.fn(async (path: string, content: string) => {
          createdContent = content;
          return new TFile({
            path: path || promptFilePath,
            name: (path || promptFilePath).split("/").pop() || "Prompt.md",
            extension: "md",
          });
        }),
        modify: jest.fn(async () => {}),
      },
    };

    const plugin: any = {
      settings: {
        imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
        imageGenerationLastUsedModelId: "",
        imageGenerationLastUsedCount: 1,
        imageGenerationLastUsedAspectRatio: "",
        imageGenerationModelCatalogCache: null,
        ...settingsOverrides,
      },
    };

    return {
      app,
      plugin,
      getCreatedContent: () => createdContent,
    };
  };

  it("creates prompt nodes using last-used model/count/aspect values", async () => {
    const harness = createHarness({
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
      imageGenerationLastUsedModelId: "openai/gpt-5-image",
      imageGenerationLastUsedCount: 3,
      imageGenerationLastUsedAspectRatio: "9:16",
    });

    await createCanvasFlowPromptNodeInActiveCanvas(harness.app, harness.plugin);

    const created = harness.getCreatedContent();
    expect(created).toContain("ss_image_model: openai/gpt-5-image");
    expect(created).toContain("ss_image_count: 3");
    expect(created).toContain("ss_image_aspect_ratio: 9:16");
    expect(harness.app.vault.modify).toHaveBeenCalledTimes(1);
  });

  it("falls back to default model metadata when no last-used state exists", async () => {
    const harness = createHarness({
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
      imageGenerationLastUsedModelId: "",
      imageGenerationLastUsedCount: 1,
      imageGenerationLastUsedAspectRatio: "",
      imageGenerationModelCatalogCache: {
        fetchedAt: "2026-02-16T00:00:00.000Z",
        models: [
          {
            id: "openai/gpt-5-image-mini",
            default_aspect_ratio: "3:4",
            allowed_aspect_ratios: ["3:4", "1:1"],
          },
        ],
      },
    });

    await createCanvasFlowPromptNodeInActiveCanvas(harness.app, harness.plugin);

    const created = harness.getCreatedContent();
    expect(created).toContain("ss_image_model: openai/gpt-5-image-mini");
    expect(created).toContain("ss_image_count: 1");
    expect(created).toContain("ss_image_aspect_ratio: 3:4");
  });
});
