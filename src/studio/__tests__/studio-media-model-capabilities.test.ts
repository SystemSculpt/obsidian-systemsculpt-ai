import { parseManagedImageModelCatalog } from "../../services/images/ManagedImageModelCatalog";
import { parseManagedVideoModelCatalog } from "../../services/videos/ManagedVideoModelCatalog";
import { describeStudioMediaModelInputs, planStudioMediaNodeInputs } from "../StudioMediaModelCapabilities";

const image = (overrides: Record<string, unknown> = {}) => ({
  id: "maker/image", name: "Image model", best_for: "Art.", is_default: true, supports_image_input: true, supports_seed: false,
  estimated_cost_per_image_credits: 10, max_images_per_job: 4, allowed_aspect_ratios: ["1:1", "16:9"], allowed_image_sizes: ["1K", "2K"],
  input_schema: { inputs: [{ port: { id: "reference_images" }, route: "reference", maxItems: 3 }, { parameterKey: "quality", route: "parameter", configField: { options: [{ value: "high" }] } }] },
  ...overrides,
});
const video = (overrides: Record<string, unknown> = {}) => ({
  id: "maker/video", name: "Video model", best_for: "Clips.", supports_audio_toggle: true, default_generate_audio: true,
  supported_frame_roles: ["first_frame"], default_resolution: "1080p", allowed_resolutions: ["720p", "1080p"],
  default_aspect_ratio: "16:9", allowed_aspect_ratios: ["16:9"], default_duration_seconds: 8, allowed_durations_seconds: [4, 8],
  estimates: [{ resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_credits: 100 }], typical_duration_ms: 90_000,
  ...overrides,
});
const images = (models: Record<string, unknown>[]) => parseManagedImageModelCatalog({ contract: "systemsculpt-media-models-v1", default_model_id: "maker/image", models });
const videos = (models: Record<string, unknown>[]) => parseManagedVideoModelCatalog({ contract: "systemsculpt-media-models-v1", models });

describe("planStudioMediaNodeInputs", () => {
  it("keeps every input while the catalog is unknown", () => {
    const plan = planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model: "maker/video" } }, { images: null, videos: null });
    expect(plan).toMatchObject({ kind: "video", model: null, hiddenInputPortIds: [], hiddenFieldKeys: [] });
    expect(planStudioMediaNodeInputs({ kind: "studio.text", config: {} }, { images: null, videos: null })).toBeNull();
  });

  it("hides the reference port and empty option fields for a text-only image model", () => {
    const snapshot = images([image(), image({ id: "maker/plain", is_default: false, supports_image_input: false, max_images_per_job: 1, allowed_image_sizes: [], input_schema: { inputs: [] } })]);
    const plain = planStudioMediaNodeInputs({ kind: "studio.image_generation", config: { model: "maker/plain" } }, { images: snapshot, videos: null });
    expect(plain).toMatchObject({ hiddenInputPortIds: ["images"], hiddenFieldKeys: ["quality", "imageSize", "count"], countMax: 1 });
    expect(plain?.inputPortNotes.images).toContain("text-only");
    // A blank model means the service default, whose limits still apply.
    const fallback = planStudioMediaNodeInputs({ kind: "studio.image_generation", config: {} }, { images: snapshot, videos: null });
    expect(fallback).toMatchObject({ modelId: "maker/image", hiddenInputPortIds: [], countMax: 4 });
    expect(fallback?.inputPortNotes.images).toContain("Up to 3 reference images");
  });

  it("hides frame ports and single-choice fields the video model does not offer", () => {
    const snapshot = videos([video()]);
    const plan = planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model: "maker/video" } }, { images: null, videos: snapshot });
    expect(plan).toMatchObject({ hiddenInputPortIds: ["last_frame"], hiddenFieldKeys: ["aspectRatio"] });
    expect(plan?.inputPortNotes.first_frame).toContain("first frame");
    const locked = planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model: "maker/video" } }, {
      images: null,
      videos: videos([video({ supported_frame_roles: [], supports_audio_toggle: false, allowed_durations_seconds: [8], allowed_resolutions: ["1080p"] })]),
    });
    expect(locked?.hiddenInputPortIds).toEqual(["first_frame", "last_frame"]);
    expect(locked?.hiddenFieldKeys).toEqual(["generateAudio", "durationSeconds", "resolution", "aspectRatio"]);
  });
});

describe("describeStudioMediaModelInputs", () => {
  it("leads with what the model accepts", () => {
    const [rich] = images([image({ supports_seed: true })]).models;
    expect(describeStudioMediaModelInputs(rich)).toEqual(["Image input · up to 3", "Up to 4 per job", "Seed"]);
    const [clip] = videos([video({ supported_frame_roles: ["first_frame", "last_frame"] })]).models;
    expect(describeStudioMediaModelInputs(clip)).toEqual(["First + last frame", "Audio"]);
    const [plain] = videos([video({ supported_frame_roles: [], supports_audio_toggle: false, default_generate_audio: false })]).models;
    expect(describeStudioMediaModelInputs(plain)).toEqual(["Text to video"]);
  });
});
