import { resolveStudioDynamicSelectOptions } from "../StudioDynamicSelectOptions";

function fakePlugin(cacheModels?: unknown[]): any {
  return {
    settings: {
      licenseKey: "license_abc",
      imageGenerationModelCatalogCache: cacheModels ? { models: cacheModels } : undefined,
    },
  };
}

describe("resolveStudioDynamicSelectOptions (image models)", () => {
  it("offers the managed default first, then curated models", async () => {
    const options = await resolveStudioDynamicSelectOptions({
      plugin: fakePlugin(),
      source: "studio.systemsculpt_image_models",
    });

    expect(options[0]).toMatchObject({ value: "", label: "SystemSculpt Default" });

    const values = options.map((option) => option.value);
    expect(values).toContain("google/gemini-3-pro-image-preview");
    expect(values).toContain("openai/gpt-5-image-mini");
    expect(values).toContain("black-forest-labs/flux.2-pro");
    // The managed engine is represented by the "" Default entry, never a model row.
    expect(values).not.toContain("systemsculpt/managed-image-engine");
  });

  it("merges server catalog models and filters the managed engine", async () => {
    const options = await resolveStudioDynamicSelectOptions({
      plugin: fakePlugin([
        { id: "systemsculpt/managed-image-engine", name: "Managed", provider: "SystemSculpt" },
        {
          id: "stability/sdxl",
          name: "Stability SDXL",
          provider: "Stability",
          supports_generation: true,
        },
      ]),
      source: "studio.systemsculpt_image_models",
    });

    const values = options.map((option) => option.value);
    expect(values).not.toContain("systemsculpt/managed-image-engine");
    expect(values).toContain("stability/sdxl");
  });

  it("omits models the synced catalog marks as non-generating", async () => {
    const options = await resolveStudioDynamicSelectOptions({
      plugin: fakePlugin([
        { id: "dead/model", name: "Dead Model", provider: "X", supports_generation: false },
        { id: "live/model", name: "Live Model", provider: "X", supports_generation: true },
      ]),
      source: "studio.systemsculpt_image_models",
    });

    const values = options.map((option) => option.value);
    expect(values).toContain("live/model");
    expect(values).not.toContain("dead/model");
  });

  it("returns an empty list for unrecognized sources", async () => {
    const options = await resolveStudioDynamicSelectOptions({
      plugin: fakePlugin(),
      source: "studio.unknown_source" as any,
    });
    expect(options).toEqual([]);
  });
});
