import {
  clampImageCount,
  createCanvasFlowPromptDraft,
  deriveDimensionsFromAspectPreset,
  getDraftAspectRatioOrDefault,
  getEffectiveDraftModel,
  parsePositiveInt,
} from "../CanvasFlowPromptDraftState";

describe("CanvasFlowPromptDraftState", () => {
  it("creates prompt draft from prompt note state", () => {
    const draft = createCanvasFlowPromptDraft({
      promptBody: "A very cool scene",
      frontmatter: {
        ss_image_width: 1536,
        ss_image_height: 1024,
        ss_image_options: {
          aspect_ratio: "16:9",
          resolution: "2K",
          output_format: "png",
          safety_filter_level: "block_medium_and_above",
        },
      },
      promptConfig: {
        kind: "prompt",
        backend: "openrouter",
        imageModelId: "openai/gpt-5-image-mini",
        imageCount: 3,
        aspectRatio: "3:4",
        seed: 22,
      },
    });

    expect(draft.body).toBe("A very cool scene");
    expect(draft.explicitModel).toBe("openai/gpt-5-image-mini");
    expect(draft.seedText).toBe("22");
    expect(draft.imageCount).toBe(3);
    expect(draft.aspectRatioPreset).toBe("3:4");
    expect(draft.widthText).toBe("1536");
    expect(draft.heightText).toBe("1024");
    expect(draft.nano.aspect_ratio).toBe("16:9");
    expect(draft.nano.output_format).toBe("png");
  });

  it("derives dimensions from an aspect-ratio preset", () => {
    const dims = deriveDimensionsFromAspectPreset({
      preset: "16:9",
      widthText: "",
      heightText: "",
    });

    expect(Number(dims.widthText)).toBeGreaterThanOrEqual(64);
    expect(Number(dims.heightText)).toBeGreaterThanOrEqual(64);
    expect(Number(dims.widthText)).toBeGreaterThan(Number(dims.heightText));
  });

  it("parses positive integers and clamps image counts", () => {
    expect(parsePositiveInt("512")).toBe(512);
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt("abc")).toBeNull();

    expect(clampImageCount(0)).toBe(1);
    expect(clampImageCount(2.9)).toBe(2);
    expect(clampImageCount(99)).toBe(4);
  });

  it("derives effective model and aspect-ratio fallback", () => {
    expect(
      getEffectiveDraftModel({
        explicitModel: "",
        settingsModelSlug: "openai/gpt-5-image-mini",
      })
    ).toBe("openai/gpt-5-image-mini");

    expect(
      getDraftAspectRatioOrDefault({
        draftAspectRatio: "",
        effectiveModel: "openai/gpt-5-image-mini",
      })
    ).toBeTruthy();
  });
});
