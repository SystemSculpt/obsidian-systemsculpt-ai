import { parseManagedVideoModelCatalog } from "../../services/videos/ManagedVideoModelCatalog";
import { describeStudioMediaModelInputs, planStudioMediaNodeInputs, resolveStudioMediaNodeKind } from "../StudioMediaModelCapabilities";

const video = (overrides: Record<string, unknown> = {}) => ({
  id: "maker/video", name: "Video model", best_for: "Clips.", supports_audio_toggle: true, default_generate_audio: true,
  supported_frame_roles: ["first_frame"], default_resolution: "1080p", allowed_resolutions: ["720p", "1080p"],
  default_aspect_ratio: "16:9", allowed_aspect_ratios: ["16:9"], default_duration_seconds: 8, allowed_durations_seconds: [4, 8],
  estimates: [{ resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_credits: 100 }], typical_duration_ms: 90_000,
  ...overrides,
});
const videos = (models: Record<string, unknown>[]) => parseManagedVideoModelCatalog({ contract: "systemsculpt-media-models-v1", models });

// Image generation is retained only as saved project data, not a model-aware control.
describe("planStudioMediaNodeInputs", () => {
  it("does not expose capabilities for retired image generation nodes", () => {
    expect(resolveStudioMediaNodeKind("studio.image_generation")).toBeNull();
    expect(planStudioMediaNodeInputs({ kind: "studio.image_generation", config: { model: "saved/image" } }, { videos: null })).toBeNull();
  });

  it("keeps every input while the catalog is unknown", () => {
    const plan = planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model: "maker/video" } }, { videos: null });
    expect(plan).toMatchObject({ kind: "video", modelId: "maker/video", model: null, hiddenInputPortIds: [], hiddenFieldKeys: [] });
    expect(planStudioMediaNodeInputs({ kind: "studio.text", config: {} }, { videos: null })).toBeNull();
  });

  it("does not replace a missing or unavailable saved video selection", () => {
    const snapshot = videos([video()]);
    for (const model of ["", "removed/video"]) {
      expect(planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model } }, { videos: snapshot }))
        .toMatchObject({ modelId: model, model: null, hiddenInputPortIds: [], hiddenFieldKeys: [] });
    }
  });

  it("hides frame ports and single-choice fields the video model does not offer", () => {
    const snapshot = videos([video()]);
    const plan = planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model: "maker/video" } }, { videos: snapshot });
    expect(plan).toMatchObject({ hiddenInputPortIds: ["last_frame"], hiddenFieldKeys: ["aspectRatio"] });
    expect(plan?.inputPortNotes.first_frame).toBe("Still image Video model uses as the exact first frame.");
    const locked = planStudioMediaNodeInputs({ kind: "studio.video_generation", config: { model: "maker/video" } }, {
      videos: videos([video({ supported_frame_roles: [], supports_audio_toggle: false, allowed_durations_seconds: [8], allowed_resolutions: ["1080p"] })]),
    });
    expect(locked?.hiddenInputPortIds).toEqual(["first_frame", "last_frame"]);
    expect(locked?.hiddenFieldKeys).toEqual(["generateAudio", "durationSeconds", "resolution", "aspectRatio"]);
  });
});

describe("describeStudioMediaModelInputs", () => {
  it("leads with what the model accepts", () => {
    const [clip] = videos([video({ supported_frame_roles: ["first_frame", "last_frame"] })]).models;
    expect(describeStudioMediaModelInputs(clip)).toEqual(["First + last frame", "Audio"]);
    const [plain] = videos([video({ supported_frame_roles: [], supports_audio_toggle: false, default_generate_audio: false })]).models;
    expect(describeStudioMediaModelInputs(plain)).toEqual(["Text to video"]);
    const [lastFrame] = videos([video({ supported_frame_roles: ["last_frame"], supports_seed: true })]).models;
    expect(describeStudioMediaModelInputs(lastFrame)).toEqual(["Last frame", "Audio", "Seed"]);
  });
});
