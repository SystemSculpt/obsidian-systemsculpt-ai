import { imageGenerationNode } from "../nodes/imageGenerationNode";
import type { StudioImageGenerationRequest } from "../types";

function image(n: number) {
  return { path: `refs/${n}.png`, hash: String(n).repeat(64).slice(0, 64), mimeType: "image/png", sizeBytes: 10 };
}

async function run(config: Record<string, unknown>, images: unknown) {
  let payload: Awaited<ReturnType<StudioImageGenerationRequest["buildPayload"]>> | null = null;
  const generateImage = jest.fn(async (request: StudioImageGenerationRequest) => {
    payload = await request.buildPayload();
    return {
      images: [image(9)],
      model: "server/model",
      usage: { usd: 0.1234567, estimated: false },
      operation: { capability: "image_generation" as const, operationId: "op" },
    };
  });
  const log = jest.fn();
  const result = await imageGenerationNode.execute({
    runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
    node: { id: "img", kind: imageGenerationNode.kind, version: "1.0.0", title: "Image", position: { x: 0, y: 0 }, config: config as never },
    inputs: { prompt: "a lighthouse", images } as never,
    services: { api: { generateImage }, readAsset: jest.fn(async () => new ArrayBuffer(10)) } as never,
    log,
  });
  return { payload: payload!, result, log };
}

describe("studio.image_generation", () => {
  it("sends max quality and the chosen options, uses the first four references and reports cost", async () => {
    const { payload, result, log } = await run(
      { ...imageGenerationNode.configDefaults, model: "vendor/model", aspectRatio: "16:9", background: "transparent", count: 2 },
      [1, 2, 3, 4, 5].map(image),
    );
    expect(payload).toMatchObject({ model: "vendor/model", prompt: "a lighthouse", count: 2, quality: "max", aspectRatio: "16:9", background: "transparent" });
    expect(payload.inputImages?.map(input => input.asset.path)).toEqual(["refs/1.png", "refs/2.png", "refs/3.png", "refs/4.png"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("using the first 4"));
    expect(result.outputs).toEqual({ images: [image(9)], generation: { model: "server/model", usd: 0.123457, estimated: false } });
    expect(result.managedOperations).toEqual([{ capability: "image_generation", operationId: "op" }]);
  });

  it("runs a saved card from the retired node on the server default at max quality", async () => {
    const { payload } = await run({ prompt: "", model: "", imageSize: "", quality: "", count: 1, aspectRatio: "16:9" }, undefined);
    expect(payload).not.toHaveProperty("model");
    expect(payload).not.toHaveProperty("background");
    expect(payload).not.toHaveProperty("inputImages");
    expect(payload).toMatchObject({ quality: "max", count: 1, aspectRatio: "16:9" });
    const auto = await run({ prompt: "", model: "", quality: "", count: 1, aspectRatio: "auto" }, undefined);
    expect(auto.payload).not.toHaveProperty("aspectRatio");
  });
});
