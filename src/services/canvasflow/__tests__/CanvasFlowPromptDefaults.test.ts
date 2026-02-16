import {
  __resetCanvasFlowPromptDefaultsRuntimeForTests,
  getCanvasFlowLastUsedState,
  queueCanvasFlowLastUsedPatch,
  resolveCanvasFlowPromptDefaults,
} from "../CanvasFlowPromptDefaults";

describe("CanvasFlowPromptDefaults", () => {
  const buildSettings = (
    overrides: Partial<{
      imageGenerationDefaultModelId: string;
      imageGenerationLastUsedModelId: string;
      imageGenerationLastUsedCount: number;
      imageGenerationLastUsedAspectRatio: string;
    }> = {}
  ) => ({
    imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
    imageGenerationLastUsedModelId: "",
    imageGenerationLastUsedCount: 1,
    imageGenerationLastUsedAspectRatio: "",
    ...overrides,
  });

  beforeEach(() => {
    __resetCanvasFlowPromptDefaultsRuntimeForTests();
  });

  it("resolves defaults from current behavior when no last-used values exist", () => {
    const result = resolveCanvasFlowPromptDefaults({
      settings: buildSettings(),
      source: "command",
      serverModels: [
        {
          id: "openai/gpt-5-image-mini",
          default_aspect_ratio: "3:4",
          allowed_aspect_ratios: ["1:1", "3:4"],
        },
      ],
    });

    expect(result.modelId).toBe("openai/gpt-5-image-mini");
    expect(result.imageCount).toBe(1);
    expect(result.aspectRatio).toBe("3:4");
  });

  it("supports partial per-field last-used inheritance", () => {
    const result = resolveCanvasFlowPromptDefaults({
      settings: buildSettings({
        imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
        imageGenerationLastUsedModelId: "openai/gpt-5-image",
        imageGenerationLastUsedCount: 4,
        imageGenerationLastUsedAspectRatio: "",
      }),
      source: "command",
      serverModels: [
        {
          id: "openai/gpt-5-image",
          default_aspect_ratio: "16:9",
          allowed_aspect_ratios: ["1:1", "16:9"],
        },
      ],
    });

    expect(result.modelId).toBe("openai/gpt-5-image");
    expect(result.imageCount).toBe(4);
    expect(result.aspectRatio).toBe("16:9");
  });

  it("keeps nano image-node fallback to match_input_image when there is no aspect history", () => {
    const result = resolveCanvasFlowPromptDefaults({
      settings: buildSettings({
        imageGenerationDefaultModelId: "google/nano-banana-pro",
        imageGenerationLastUsedModelId: "",
        imageGenerationLastUsedAspectRatio: "",
      }),
      source: "image-node",
    });

    expect(result.modelId).toBe("google/nano-banana-pro");
    expect(result.aspectRatio).toBe("match_input_image");
  });

  it("uses last-used aspect ratio for nano image-node creation when available", () => {
    const result = resolveCanvasFlowPromptDefaults({
      settings: buildSettings({
        imageGenerationDefaultModelId: "google/nano-banana-pro",
        imageGenerationLastUsedAspectRatio: "9:16",
      }),
      source: "image-node",
    });

    expect(result.aspectRatio).toBe("9:16");
  });

  it("clamps stored image count into the supported range", () => {
    const state = getCanvasFlowLastUsedState(
      buildSettings({
        imageGenerationLastUsedCount: 99,
      })
    );

    expect(state.imageCount).toBe(4);
  });

  it("applies queued patches to runtime state immediately", async () => {
    const settings = buildSettings();
    const updateSettings = jest.fn().mockResolvedValue(undefined);

    const plugin = {
      settings,
      getSettingsManager: () => ({
        updateSettings,
      }),
    } as any;

    const persistPromise = queueCanvasFlowLastUsedPatch(plugin, {
      modelId: "openai/gpt-5-image",
      imageCount: 3,
      aspectRatio: "16:9",
    });

    const runtimeState = getCanvasFlowLastUsedState(settings);
    expect(runtimeState.modelId).toBe("openai/gpt-5-image");
    expect(runtimeState.imageCount).toBe(3);
    expect(runtimeState.aspectRatio).toBe("16:9");

    await persistPromise;
    expect(updateSettings).toHaveBeenCalledWith({
      imageGenerationLastUsedModelId: "openai/gpt-5-image",
      imageGenerationLastUsedCount: 3,
      imageGenerationLastUsedAspectRatio: "16:9",
    });
  });
});
