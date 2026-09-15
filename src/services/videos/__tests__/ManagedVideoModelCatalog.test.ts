import { ManagedVideoModelCatalog, parseManagedVideoModelCatalog, snapManagedVideoRequestToModel } from "../ManagedVideoModelCatalog";
import { resetStudioVideoModelOptions, resolveStudioVideoModelOptions } from "../../../studio/StudioVideoModelOptions";
import type { StudioNodeInstance } from "../../../studio/types";

const model = {
  id: "maker/clip-1", name: "Clip One", provider: "Maker", best_for: "Short cinematic shots.",
  supports_seed: false, supports_audio_toggle: true, default_generate_audio: true,
  supported_frame_roles: ["first_frame", "last_frame"],
  default_resolution: "1080p", allowed_resolutions: ["720p", "1080p"],
  default_aspect_ratio: "16:9", allowed_aspect_ratios: ["16:9", "9:16"],
  default_duration_seconds: 8, allowed_durations_seconds: [4, 6, 8],
  estimates: [
    { resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_usd: 1, estimated_credits: 150, estimated_credits_with_frame_image: 170 },
    { resolution: "720p", generate_audio: false, duration_seconds: 4, estimated_usd: 0.2, estimated_credits: 30 },
  ],
  typical_duration_ms: 90_000, billing_supported: true, future_field: true,
};
const unbillable = { ...model, id: "maker/clip-2", name: "Clip Two", billing_supported: false, selection_disabled_reason: "no price" };
const fixture = () => ({ contract: "systemsculpt-media-models-v1", credits_billing: { credits_per_usd: 100 }, models: [model, unbillable] });

it("loads billable models with prices and the selected model's option matrix", async () => {
  const request = jest.fn(async () => ({ response: new Response(JSON.stringify(fixture())) }));
  const catalog = new ManagedVideoModelCatalog({ request } as never);
  const node = { kind: "studio.video_generation", config: { model: model.id } } as unknown as StudioNodeInstance;
  const [models, durations, resolutions, ratios] = await Promise.all([
    resolveStudioVideoModelOptions(catalog, "video_generation_models", node),
    resolveStudioVideoModelOptions(catalog, "video_generation_durations", node),
    resolveStudioVideoModelOptions(catalog, "video_generation_resolutions", node),
    resolveStudioVideoModelOptions(catalog, "video_generation_aspect_ratios", node),
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({ path: "/api/plugin/videos/models", method: "GET" });
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ value: model.id, label: "Clip One", badge: "~150 credits/clip" });
  expect(models[0].description).toContain("Default 8s at 1080p");
  expect(durations.map(option => option.value)).toEqual(["", "4", "6", "8"]);
  expect(durations[1].label).toBe("4s");
  expect(resolutions.map(option => option.value)).toEqual(["", "720p", "1080p"]);
  expect(ratios.map(option => option.value)).toEqual(["", "16:9", "9:16"]);
});

it("offers the first model's matrix before a model is chosen and rejects a removed model", async () => {
  const catalog = { load: async () => parseManagedVideoModelCatalog(fixture()) };
  const blank = { kind: "studio.video_generation", config: {} } as unknown as StudioNodeInstance;
  await expect(resolveStudioVideoModelOptions(catalog, "video_generation_durations", blank)).resolves.toHaveLength(4);
  const removed = { kind: "studio.video_generation", config: { model: "gone/model" } } as unknown as StudioNodeInstance;
  await expect(resolveStudioVideoModelOptions(catalog, "video_generation_resolutions", removed)).rejects.toThrow("unavailable");
});

it("snaps stale selections to what the model supports", () => {
  const parsed = parseManagedVideoModelCatalog(fixture()).models[0];
  expect(snapManagedVideoRequestToModel(parsed, { durationSeconds: 5, resolution: "4K", aspectRatio: "1:1", generateAudio: false }))
    .toEqual({ durationSeconds: 4, resolution: "1080p", aspectRatio: "16:9", generateAudio: false });
  expect(snapManagedVideoRequestToModel({ ...parsed, supportsAudioToggle: false }, { generateAudio: false })).toEqual({ generateAudio: true });
  expect(snapManagedVideoRequestToModel(parsed, {})).toEqual({});
});

it("rejects the wrong contract and duplicate identities but skips a single malformed model", () => {
  expect(() => parseManagedVideoModelCatalog({ ...fixture(), contract: "other" })).toThrow("unavailable");
  expect(() => parseManagedVideoModelCatalog({ ...fixture(), models: [model, model] })).toThrow("identity");
  const broken = [{ ...model, id: "maker/no-estimates", estimates: [] }, { ...model, id: "maker/bad-price", estimates: [{ ...model.estimates[0], estimated_credits: -1 }] }];
  expect(parseManagedVideoModelCatalog({ ...fixture(), models: [...broken, model] }).models.map(entry => entry.id)).toEqual([model.id]);
});

it("keeps a model whose progress hint is out of range and long clips the server allows", () => {
  const slow = { ...model, id: "maker/slow", typical_duration_ms: 5_567_610, allowed_durations_seconds: [4, 30, 120], estimates: [{ ...model.estimates[0], duration_seconds: 120 }] };
  const parsed = parseManagedVideoModelCatalog({ ...fixture(), models: [slow, { ...model, id: "maker/odd", typical_duration_ms: 0 }] }).models;
  expect(parsed.map(entry => [entry.id, entry.typicalDurationMs])).toEqual([["maker/slow", 5_567_610], ["maker/odd", null]]);
  expect(parsed[0].durationsSeconds).toEqual([4, 30, 120]);
});

it("returns dependent options to the model defaults when the model changes", () => {
  const node = { kind: "studio.video_generation", config: { model: "b", durationSeconds: "8", resolution: "720p", aspectRatio: "9:16", generateAudio: false } } as unknown as StudioNodeInstance;
  resetStudioVideoModelOptions(node, "resolution");
  expect(node.config.durationSeconds).toBe("8");
  resetStudioVideoModelOptions(node, "model");
  expect(node.config).toMatchObject({ durationSeconds: "", resolution: "", aspectRatio: "", generateAudio: false });
});
