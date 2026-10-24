import type SystemSculptPlugin from "../../main";
import { isStudioMediaModelConfigKey, resetStudioMediaModelOptions, resolveStudioMediaModelOptionsForPlugin } from "../StudioMediaModelOptions";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeInstance } from "../types";

function fixture() {
  const request = jest.fn(async () => ({ response: new Response(JSON.stringify({
    contract: "systemsculpt-media-models-v1",
    models: [{
      id: "maker/video", name: "Video model", best_for: "Clips.", supports_audio_toggle: true, default_generate_audio: true,
      supported_frame_roles: ["first_frame"], default_resolution: "1080p", allowed_resolutions: ["720p", "1080p"],
      default_aspect_ratio: "16:9", allowed_aspect_ratios: ["16:9"], default_duration_seconds: 8, allowed_durations_seconds: [4, 8],
      estimates: [{ resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_credits: 100 }],
    }],
  })) }));
  const plugin = { settings: {}, getManagedCapabilityGraph: jest.fn(() => ({ transport: { request } })) };
  const node = { id: "video", kind: "studio.video_generation", config: { model: "maker/video" } } as StudioNodeInstance;
  return { plugin: plugin as unknown as SystemSculptPlugin, request, node };
}

describe("Studio media model options", () => {
  it("loads only the video catalog and preserves its option presentation", async () => {
    const { plugin, request, node } = fixture();
    const [models, resolutions] = await Promise.all([
      resolveStudioMediaModelOptionsForPlugin(plugin, "video_generation_models", node),
      resolveStudioMediaModelOptionsForPlugin(plugin, "video_generation_resolutions", node),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ path: "/api/plugin/videos/models", method: "GET" });
    expect(models).toEqual([expect.objectContaining({ value: "maker/video", label: "Video model", badge: "~100 credits/clip" })]);
    expect(resolutions).toEqual([
      { value: "", label: "Model default" },
      { value: "720p", label: "720p" },
      { value: "1080p", label: "1080p" },
    ]);
  });

  it.each(["image_models", "image_sizes", "image_aspect_ratios", "image_qualities"])("does not load retired %s controls", async source => {
    const { plugin, request, node } = fixture();
    for (const kind of ["studio.image_generation", "studio.video_generation"]) {
      await expect(resolveStudioMediaModelOptionsForPlugin(plugin, source as StudioNodeConfigDynamicOptionsSource, { ...node, kind })).resolves.toEqual([]);
    }
    await expect(resolveStudioMediaModelOptionsForPlugin(plugin, "video_generation_models", { ...node, kind: "studio.image_generation" })).resolves.toEqual([]);
    expect(plugin.getManagedCapabilityGraph).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("resets dependent video controls without rewriting retired image configuration", () => {
    const { node } = fixture();
    node.config = { model: "maker/video", durationSeconds: "8", resolution: "1080p", aspectRatio: "16:9", generateAudio: true };
    resetStudioMediaModelOptions(node, "model");
    expect(node.config).toEqual({ model: "maker/video", durationSeconds: "", resolution: "", aspectRatio: "", generateAudio: true });
    expect(isStudioMediaModelConfigKey(node.kind, "model")).toBe(true);
    expect(isStudioMediaModelConfigKey(node.kind, "resolution")).toBe(true);
    expect(isStudioMediaModelConfigKey(node.kind, "quality")).toBe(false);

    const saved = { ...node, kind: "studio.image_generation", config: { model: "saved/image", count: 3, quality: "high", imageSize: "2K", aspectRatio: "4:3" } };
    const original = { ...saved.config };
    resetStudioMediaModelOptions(saved, "model");
    expect(saved.config).toEqual(original);
    expect(isStudioMediaModelConfigKey(saved.kind, "model")).toBe(false);
  });
});
