import { ManagedImageModelCatalog, parseManagedImageModelCatalog } from "../ManagedImageModelCatalog";
import { resolveStudioImageModelOptions } from "../../../studio/StudioImageModelOptions";
import type { StudioNodeInstance } from "../../../studio/types";

const model = {
  id: "maker/new-model", name: "New image model", provider: "Maker", best_for: "Detailed artwork.",
  is_default: false, supports_image_input: true, supports_seed: true, released_at: "2026-08-14", typical_duration_ms: 61_000,
  estimated_cost_per_image_credits: 120, reservation_credits_per_image: 200,
  max_images_per_job: 2, allowed_aspect_ratios: ["1:4", "auto"], allowed_image_sizes: ["2K", "4K"],
  estimates: [{ image_size: "2K", estimated_cost_per_image_credits: 120 }, { image_size: "4K", estimated_cost_per_image_credits: 480 }],
  input_schema: { inputs: [
    { port: { id: "reference_images", type: "any" }, route: "reference", maxItems: 6 },
    { parameterKey: "quality", route: "parameter", configField: { options: [{ value: "max" }, { value: "low" }] } },
  ] },
};
const textOnly = { ...model, id: "maker/text-only", name: "Text only", supports_image_input: false, input_schema: { inputs: [] }, estimates: [], released_at: null, typical_duration_ms: null };
const fixture = () => ({ contract: "systemsculpt-media-models-v1", default_model_id: model.id, models: [model, textOnly], future_field: true });

it("loads model IDs, prices, and future size/quality options from the service", async () => {
  const request = jest.fn(async () => ({ response: new Response(JSON.stringify(fixture())) }));
  const catalog = new ManagedImageModelCatalog({ request } as never);
  const node = { config: { model: model.id } } as StudioNodeInstance;
  const [models, sizes, qualities] = await Promise.all([
    resolveStudioImageModelOptions(catalog, "image_models", node),
    resolveStudioImageModelOptions(catalog, "image_sizes", node),
    resolveStudioImageModelOptions(catalog, "image_qualities", node),
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({ path: "/api/plugin/images/models", method: "GET" });
  expect(models[0]).toMatchObject({ value: model.id, badge: "~120 credits/image" });
  expect(models[0].description).toContain("200 credits/image");
  expect(sizes.map(option => option.value)).toEqual(["", "2K", "4K"]);
  expect(qualities.map(option => option.value)).toEqual(["", "max", "low"]);
});

it("reads what each model accepts from the per-model input schema", () => {
  const [rich, plain] = parseManagedImageModelCatalog(fixture()).models;
  expect(rich).toMatchObject({
    provider: "Maker", isDefault: true, supportsImageInput: true, maxInputReferences: 6, supportsSeed: true,
    releasedAt: "2026-08-14", typicalDurationMs: 61_000, qualities: ["max", "low"],
  });
  expect(rich.sizeEstimates).toEqual([{ imageSize: "2K", estimatedCredits: 120 }, { imageSize: "4K", estimatedCredits: 480 }]);
  expect(plain).toMatchObject({ supportsImageInput: false, maxInputReferences: 0, isDefault: false, releasedAt: null, typicalDurationMs: null, sizeEstimates: [] });
  // Without a schema entry the flat flag still grants a conservative reference budget.
  const legacy = parseManagedImageModelCatalog({ ...fixture(), models: [{ ...model, input_schema: undefined }] }).models[0];
  expect(legacy.maxInputReferences).toBe(4);
});

it("keeps an unavailable saved selection explicit instead of switching to a different model", async () => {
  const catalog = { load: async () => parseManagedImageModelCatalog(fixture()) };
  await expect(resolveStudioImageModelOptions(catalog, "image_sizes", { config: { model: "removed/model" } } as StudioNodeInstance)).rejects.toThrow("unavailable");
});

it("rejects duplicate model identities and the wrong contract but skips a single malformed model", () => {
  expect(() => parseManagedImageModelCatalog({ ...fixture(), models: [model, model] })).toThrow("identity");
  expect(() => parseManagedImageModelCatalog({ ...fixture(), contract: "other" })).toThrow("unavailable");
  const parsed = parseManagedImageModelCatalog({ ...fixture(), models: [{ ...model, estimated_cost_per_image_credits: -1 }, textOnly] });
  expect(parsed.models.map(entry => entry.id)).toEqual([textOnly.id]);
});

it("serves the last catalog synchronously for a short window and refetches after it expires", async () => {
  let now = 1_000;
  const request = jest.fn(async () => ({ response: new Response(JSON.stringify(fixture())) }));
  const catalog = new ManagedImageModelCatalog({ request } as never, () => now);
  expect(catalog.peek()).toBeNull();
  const first = await catalog.load();
  expect(catalog.peek()).toBe(first);
  expect(await catalog.load()).toBe(first);
  expect(request).toHaveBeenCalledTimes(1);
  now += 6 * 60_000;
  expect(catalog.peek()).toBeNull();
  await catalog.load();
  expect(request).toHaveBeenCalledTimes(2);
});
