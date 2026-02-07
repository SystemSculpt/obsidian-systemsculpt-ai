import {
  REPLICATE_CURATED_IMAGE_MODELS,
  formatCuratedModelOptionText,
  getCuratedReplicateModel,
  getCuratedReplicateModelGroups,
  getEffectiveReplicateImageInputSpec,
} from "../ReplicateModelCatalog";

describe("ReplicateModelCatalog", () => {
  it("contains the expected curated slugs (no duplicates)", () => {
    const slugs = REPLICATE_CURATED_IMAGE_MODELS.map((m) => m.slug);
    expect(slugs.length).toBeGreaterThan(10);
    expect(new Set(slugs).size).toBe(slugs.length);

    // Spot-check: important models in the curated list.
    expect(slugs).toContain("google/imagen-4-fast");
    expect(slugs).toContain("google/imagen-4");
    expect(slugs).toContain("google/imagen-4-ultra");
    expect(slugs).toContain("google/nano-banana");
    expect(slugs).toContain("google/nano-banana-pro");
    expect(slugs).toContain("black-forest-labs/flux-2-pro");
    expect(slugs).toContain("stability-ai/stable-diffusion-3.5-large-turbo");
    expect(slugs).toContain("ideogram-ai/ideogram-v3-quality");
    expect(slugs).toContain("bytedance/seedream-4.5");
    expect(slugs).toContain("qwen/qwen-image");
    expect(slugs).toContain("xai/grok-2-image");
    expect(slugs).toContain("runwayml/gen4-image");
  });

  it("groups models by provider with stable, sorted output", () => {
    const groups = getCuratedReplicateModelGroups();
    expect(groups.length).toBeGreaterThan(3);
    const providers = groups.map((g) => g.provider);
    expect(providers).toEqual([...providers].sort((a, b) => a.localeCompare(b)));
    for (const g of groups) {
      const labels = g.models.map((m) => m.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("formats option text with label, slug, and pricing summary", () => {
    const model = getCuratedReplicateModel("google/nano-banana");
    expect(model).not.toBeNull();
    if (!model) return;
    const text = formatCuratedModelOptionText(model);
    expect(text).toContain("Nano Banana");
    expect(text).toContain("google/nano-banana");
    expect(text).toContain("$");
  });

  describe("getEffectiveReplicateImageInputSpec", () => {
    it("uses curated imageInput spec when no explicit override", () => {
      expect(
        getEffectiveReplicateImageInputSpec({
          modelSlug: "black-forest-labs/flux-2-pro",
          replicateImageKey: "image",
          hasExplicitImageKey: false,
          replicateInput: {},
        })
      ).toEqual({ kind: "array", key: "input_images" });

      expect(
        getEffectiveReplicateImageInputSpec({
          modelSlug: "google/imagen-4",
          replicateImageKey: "image",
          hasExplicitImageKey: false,
          replicateInput: {},
        })
      ).toEqual({ kind: "none" });

      expect(
        getEffectiveReplicateImageInputSpec({
          modelSlug: "qwen/qwen-image-edit-plus",
          replicateImageKey: "image",
          hasExplicitImageKey: false,
          replicateInput: {},
        })
      ).toEqual({ kind: "array", key: "image" });
    });

    it("respects explicit image key overrides", () => {
      // Even if the curated entry is text-only, an explicit override should be honored.
      expect(
        getEffectiveReplicateImageInputSpec({
          modelSlug: "google/imagen-4",
          replicateImageKey: "image_input",
          hasExplicitImageKey: true,
          replicateInput: {},
        })
      ).toEqual({ kind: "array", key: "image_input" });

      // If the user seeded an array input, treat it as array.
      expect(
        getEffectiveReplicateImageInputSpec({
          modelSlug: "acme/custom-model",
          replicateImageKey: "input_images",
          hasExplicitImageKey: true,
          replicateInput: { input_images: [] },
        })
      ).toEqual({ kind: "array", key: "input_images" });
    });
  });
});

