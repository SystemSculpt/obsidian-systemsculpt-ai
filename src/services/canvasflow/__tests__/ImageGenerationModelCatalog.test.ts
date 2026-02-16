import {
  CURATED_IMAGE_GENERATION_MODELS,
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatCuratedImageModelOptionText,
  formatImageAspectRatioLabel,
  getCuratedImageGenerationModel,
  getCuratedImageGenerationModelGroups,
  getDefaultImageAspectRatio,
  mergeImageGenerationServerCatalogModels,
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
    expect(text).toContain("OpenAI GPT-5 Image Mini");
    expect(text).not.toContain("openai/gpt-5-image-mini");
    expect(text).toContain("$0.02");
    expect(text).toContain("cr/img");
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
        estimated_cost_per_image_usd: 0.03,
        pricing_source: "test_case",
      },
    ];
    const merged = resolveImageGenerationModelCatalog(serverModels);
    expect(merged.some((model) => model.id === "acme/vision-neo")).toBe(true);
    const acme = merged.find((model) => model.id === "acme/vision-neo");
    expect(acme?.pricing.summary).toContain("$0.030");
    expect(acme?.pricing.summary).toContain("30 cr/img");

    const groups = getCuratedImageGenerationModelGroups(serverModels);
    expect(groups.some((group) => group.provider === "Acme")).toBe(true);
  });

  it("excludes openrouter/auto from selectable image models", () => {
    const merged = resolveImageGenerationModelCatalog([
      {
        id: "openrouter/auto",
        name: "Auto Router",
        provider: "OpenRouter",
        output_modalities: ["image"],
      },
    ]);

    expect(merged.some((model) => model.id === "openrouter/auto")).toBe(false);
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

  it("merges preferred and supplemental server catalogs by id", () => {
    const preferred: ImageGenerationServerCatalogModel[] = [
      {
        id: "sourceful/riverflow-v2-pro",
        name: "Sourceful: Riverflow V2 Pro",
        provider: "Sourceful",
        output_modalities: ["image"],
        max_images_per_job: 4,
        estimated_cost_per_image_usd: 0.15,
      },
    ];
    const supplemental: ImageGenerationServerCatalogModel[] = [
      {
        id: "sourceful/riverflow-v2-pro",
        input_modalities: ["text", "image"],
        supports_image_input: true,
        estimated_cost_per_image_low_usd: 0.12,
        estimated_cost_per_image_high_usd: 0.2,
        pricing_source: "supplemental",
      },
      {
        id: "sourceful/riverflow-v2-fast",
        name: "Sourceful: Riverflow V2 Fast",
        provider: "Sourceful",
        output_modalities: ["image"],
      },
    ];

    const merged = mergeImageGenerationServerCatalogModels(preferred, supplemental);
    expect(merged).toHaveLength(2);
    const pro = merged.find((model) => model.id === "sourceful/riverflow-v2-pro");
    const fast = merged.find((model) => model.id === "sourceful/riverflow-v2-fast");
    expect(pro?.name).toBe("Sourceful: Riverflow V2 Pro");
    expect(pro?.supports_generation).toBe(true);
    expect(pro?.max_images_per_job).toBe(4);
    expect(pro?.supports_image_input).toBe(true);
    expect(pro?.input_modalities).toContain("image");
    expect(pro?.output_modalities).toContain("image");
    expect(pro?.estimated_cost_per_image_usd).toBe(0.15);
    expect(pro?.estimated_cost_per_image_low_usd).toBe(0.12);
    expect(pro?.estimated_cost_per_image_high_usd).toBe(0.2);
    expect(pro?.pricing_source).toBe("supplemental");
    expect(fast?.supports_generation).toBe(false);
  });

  it("marks curated models as unsupported when server catalog is present and missing that id", () => {
    const mergedServerCatalog = mergeImageGenerationServerCatalogModels([], [
      {
        id: "sourceful/riverflow-v2-fast",
        name: "Sourceful Riverflow V2 Fast",
        provider: "Sourceful",
      },
    ]);
    const catalog = resolveImageGenerationModelCatalog(mergedServerCatalog);
    const gpt5Mini = catalog.find((model) => model.id === "openai/gpt-5-image-mini");
    const riverflow = catalog.find((model) => model.id === "sourceful/riverflow-v2-fast");
    expect(gpt5Mini?.supportsGeneration).toBe(false);
    expect(riverflow?.supportsGeneration).toBe(false);
  });
});
