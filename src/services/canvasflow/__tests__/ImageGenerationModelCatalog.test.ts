import {
  CURATED_IMAGE_GENERATION_MODELS,
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatCuratedImageModelOptionText,
  getCuratedImageGenerationModel,
  getCuratedImageGenerationModelGroups,
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
});
