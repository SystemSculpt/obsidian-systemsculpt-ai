import {
  __resetImageGenerationDefaultsRuntimeForTests,
  getImageGenerationLastUsedState,
  queueImageGenerationLastUsedPatch,
  resolveImageGenerationDefaults,
} from "../ImageGenerationDefaults";

describe("ImageGenerationDefaults", () => {
  const buildSettings = (
    overrides: Partial<{
      imageGenerationDefaultModelId: string;
      imageGenerationLastUsedModelId: string;
      imageGenerationLastUsedCount: number;
      imageGenerationLastUsedAspectRatio: string;
    }> = {}
  ) => ({
    imageGenerationDefaultModelId: "google/gemini-3.1-flash-lite-image",
    imageGenerationLastUsedModelId: "",
    imageGenerationLastUsedCount: 1,
    imageGenerationLastUsedAspectRatio: "",
    ...overrides,
  });

  beforeEach(() => {
    __resetImageGenerationDefaultsRuntimeForTests();
  });

  it("resolves defaults from current behavior when no last-used values exist", () => {
    const result = resolveImageGenerationDefaults({
      settings: buildSettings(),
      source: "command",
      serverModels: [
        {
          id: "google/gemini-3.1-flash-lite-image",
          default_aspect_ratio: "3:4",
          allowed_aspect_ratios: ["1:1", "3:4"],
        },
      ],
    });

    expect(result.modelId).toBe("google/gemini-3.1-flash-lite-image");
    expect(result.imageCount).toBe(1);
    expect(result.aspectRatio).toBe("3:4");
  });

  it("supports partial per-field last-used inheritance", () => {
    const result = resolveImageGenerationDefaults({
      settings: buildSettings({
        imageGenerationDefaultModelId: "google/gemini-3.1-flash-lite-image",
        imageGenerationLastUsedModelId: "openai/gpt-5.4-image-2",
        imageGenerationLastUsedCount: 4,
        imageGenerationLastUsedAspectRatio: "",
      }),
      source: "command",
      serverModels: [
        {
          id: "openai/gpt-5.4-image-2",
          default_aspect_ratio: "16:9",
          allowed_aspect_ratios: ["1:1", "16:9"],
        },
      ],
    });

    expect(result.modelId).toBe("openai/gpt-5.4-image-2");
    expect(result.imageCount).toBe(4);
    expect(result.aspectRatio).toBe("16:9");
  });

  it("treats retired model ids in persisted settings as unset", () => {
    const result = resolveImageGenerationDefaults({
      settings: buildSettings({
        // Both values predate the 2026-07 curation pass and no longer exist
        // on the server; they must fall through to the current default
        // instead of producing a guaranteed invalid_model rejection.
        imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
        imageGenerationLastUsedModelId: "google/gemini-3-pro-image-preview",
      }),
      source: "command",
    });

    expect(result.modelId).toBe("google/gemini-3.1-flash-image");
  });

  it("keeps nano image-node fallback to match_input_image when there is no aspect history", () => {
    const result = resolveImageGenerationDefaults({
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
    const result = resolveImageGenerationDefaults({
      settings: buildSettings({
        imageGenerationDefaultModelId: "google/nano-banana-pro",
        imageGenerationLastUsedAspectRatio: "9:16",
      }),
      source: "image-node",
    });

    expect(result.aspectRatio).toBe("9:16");
  });

  it("clamps stored image count into the supported range", () => {
    const state = getImageGenerationLastUsedState(
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

    const persistPromise = queueImageGenerationLastUsedPatch(plugin, {
      modelId: "openai/gpt-5.4-image-2",
      imageCount: 3,
      aspectRatio: "16:9",
    });

    const runtimeState = getImageGenerationLastUsedState(settings);
    expect(runtimeState.modelId).toBe("openai/gpt-5.4-image-2");
    expect(runtimeState.imageCount).toBe(3);
    expect(runtimeState.aspectRatio).toBe("16:9");

    await persistPromise;
    expect(updateSettings).toHaveBeenCalledWith({
      imageGenerationLastUsedModelId: "openai/gpt-5.4-image-2",
      imageGenerationLastUsedCount: 3,
      imageGenerationLastUsedAspectRatio: "16:9",
    });
  });
});
