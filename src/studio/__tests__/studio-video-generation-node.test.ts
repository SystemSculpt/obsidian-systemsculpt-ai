import { videoGenerationNode } from "../nodes/videoGenerationNode";
import type { StudioVideoGenerationRequest, StudioVideoGenerationResult } from "../types";

type VideoPayload = Awaited<ReturnType<StudioVideoGenerationRequest["buildPayload"]>>;

const frame = (index: number) => ({ path: `frames/${index}.png`, mimeType: "image/png", sizeBytes: 1, hash: String(index + 1).repeat(64) });

function fixture(config: Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  const submit = jest.fn(async (_payload: VideoPayload): Promise<StudioVideoGenerationResult> => ({
    videos: [{ hash: "c".repeat(64), mimeType: "video/mp4", sizeBytes: 2, path: "assets/clip.mp4" }],
    operation: { capability: "video_generation", operationId: "video-op" },
  }));
  const progress: string[] = [];
  const execute = () => videoGenerationNode.execute({
    runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
    node: { id: "video", kind: videoGenerationNode.kind, version: videoGenerationNode.version, title: "Video", position: { x: 0, y: 0 }, config },
    inputs,
    services: {
      readAsset: jest.fn(async () => new Uint8Array([1]).buffer),
      storeAsset: jest.fn(),
      api: {
        generateVideo: async (request: StudioVideoGenerationRequest) => {
          request.onProgress?.({ status: "processing", typicalDurationMs: 42_000 });
          request.onProgress?.({ status: "processing" });
          return submit(await request.buildPayload());
        },
      },
    },
    log: (message: string) => { progress.push(message); },
  } as never);
  return { execute, submit, progress };
}

describe("studio.video_generation", () => {
  it("submits the model, prompt, both frames and only the chosen options", async () => {
    const { execute, submit, progress } = fixture(
      { prompt: "a fox runs", model: "maker/clip-1", durationSeconds: "8", resolution: "1080p", aspectRatio: "", generateAudio: false },
      { first_frame: [frame(0)], last_frame: [frame(1)] },
    );
    const result = await execute();
    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0][0];
    expect(payload).toMatchObject({ model: "maker/clip-1", prompt: "a fox runs", durationSeconds: 8, resolution: "1080p", generateAudio: false });
    expect(payload).not.toHaveProperty("aspectRatio");
    expect(payload.frameImages?.map(entry => entry.role)).toEqual(["first_frame", "last_frame"]);
    expect(result.outputs.videos).toHaveLength(1);
    expect(result.managedOperations).toEqual([{ capability: "video_generation", operationId: "video-op" }]);
    expect(progress.filter(line => line.includes("Job processing"))).toHaveLength(1);
    expect(progress[0]).toContain("~42s");
  });

  it("prefers a wired prompt and requires a model", async () => {
    const wired = fixture({ prompt: "configured", model: "maker/clip-1" }, { prompt: "wired" });
    await wired.execute();
    expect(wired.submit.mock.calls[0][0].prompt).toBe("wired");
    const noModel = fixture({ prompt: "configured", model: "" });
    await expect(noModel.execute()).rejects.toThrow("requires a model");
    expect(noModel.submit).not.toHaveBeenCalled();
    const noPrompt = fixture({ prompt: "", model: "maker/clip-1" });
    await expect(noPrompt.execute()).rejects.toThrow("requires a prompt");
  });

  it("rejects an oversized prompt before submission", async () => {
    const { execute, submit } = fixture({ prompt: "x".repeat(8_001), model: "maker/clip-1" });
    await expect(execute()).rejects.toThrow("8,000 characters");
    expect(submit).not.toHaveBeenCalled();
  });
});
