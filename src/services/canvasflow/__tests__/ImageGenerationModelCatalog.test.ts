import {
  CURATED_IMAGE_GENERATION_MODELS,
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatCuratedImageModelOptionText,
  formatImageAspectRatioLabel,
  getCuratedImageGenerationModel,
  getCuratedImageGenerationModelGroups,
  getDefaultImageAspectRatio,
  getRecommendedImageAspectRatios,
  getSupportedImageAspectRatios,
  resolveImageGenerationModelCatalog,
  type ImageGenerationServerCatalogModel,
} from "../ImageGenerationModelCatalog";

describe("ImageGenerationModelCatalog", () => {
  it("includes the default low-cost model", () => {
    const ids = CURATED_IMAGE_GENERATION_MODELS.map((model) => model.id);
    expect(ids).toContain(DEFAULT_IMAGE_GENERATION_MODEL_ID);
  });

  it("resolves curated model details by id", () => {
    const model = getCuratedImageGenerationModel("openai/gpt-5-image-mini");
    expect(model).not.toBeNull();
    expect(model?.supportsImageInput).toBe(true);
  });

  it("groups models by provider", () => {
    const groups = getCuratedImageGenerationModelGroups();
    expect(groups.length).toBeGreaterThan(0);
    const providerNames = groups.map((group) => group.provider);
    expect(providerNames).toContain("OpenAI");
  });

  it("formats option text with id and pricing summary", () => {
    const model = getCuratedImageGenerationModel("openai/gpt-5-image-mini");
    expect(model).not.toBeNull();
    const text = formatCuratedImageModelOptionText(model!);
    expect(text).toContain("openai/gpt-5-image-mini");
    expect(text).toContain("$0.02");
  });

  it("prioritizes common supported aspect ratios for a model", () => {
    const ratios = getSupportedImageAspectRatios("openai/gpt-5-image-mini");
    expect(ratios[0]).toBe("16:9");
    expect(ratios).toContain("1:1");
    expect(ratios).toContain("9:16");
  });

  it("returns top recommended aspect ratios", () => {
    const ratios = getRecommendedImageAspectRatios("openai/gpt-5-image-mini");
    expect(ratios).toEqual(["16:9", "1:1", "9:16"]);
  });

  it("returns model default aspect ratio when supported", () => {
    const ratio = getDefaultImageAspectRatio("openai/gpt-5-image-mini");
    expect(ratio).toBe("1:1");
  });

  it("formats aspect ratio labels for UX copy", () => {
    expect(formatImageAspectRatioLabel("16:9")).toContain("Landscape");
    expect(formatImageAspectRatioLabel("9:16")).toContain("Portrait");
    expect(formatImageAspectRatioLabel("1:1")).toContain("Square");
  });

  it("merges server-only models into selectable catalog", () => {
    const serverModels: ImageGenerationServerCatalogModel[] = [
      {
        id: "acme/vision-neo",
        name: "Acme Vision Neo",
        provider: "Acme",
        supports_image_input: true,
        max_images_per_job: 2,
        default_aspect_ratio: "16:9",
        allowed_aspect_ratios: ["16:9", "1:1"],
      },
    ];
    const merged = resolveImageGenerationModelCatalog(serverModels);
    expect(merged.some((model) => model.id === "acme/vision-neo")).toBe(true);

    const groups = getCuratedImageGenerationModelGroups(serverModels);
    expect(groups.some((group) => group.provider === "Acme")).toBe(true);
  });

  it("uses server aspect ratio metadata for curated model constraints", () => {
    const serverModels: ImageGenerationServerCatalogModel[] = [
      {
        id: "openai/gpt-5-image-mini",
        allowed_aspect_ratios: ["1:1", "16:9"],
        default_aspect_ratio: "16:9",
      },
    ];

    const ratios = getSupportedImageAspectRatios("openai/gpt-5-image-mini", serverModels);
    expect(ratios).toContain("16:9");
    expect(ratios).toContain("1:1");
    expect(getDefaultImageAspectRatio("openai/gpt-5-image-mini", serverModels)).toBe("16:9");
  });
});
