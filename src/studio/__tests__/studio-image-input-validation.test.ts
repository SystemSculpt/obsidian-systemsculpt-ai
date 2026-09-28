import { imageGenerationNode } from "../nodes/imageGenerationNode";
import type { StudioImageGenerationRequest, StudioImageGenerationResult } from "../types";

type ImagePayload = Awaited<ReturnType<StudioImageGenerationRequest["buildPayload"]>>;

const references = Array.from({ length: 5 }, (_, index) => ({
  path: `refs/${index}.jpg`,
  mimeType: "image/jpeg",
  sizeBytes: 1,
  hash: String(index + 1).repeat(64),
}));

function fixture(prompt: string, images: unknown[] = [], configured = false) {
  const submit = jest.fn(async (_payload: ImagePayload): Promise<StudioImageGenerationResult> => ({
    images: [], operation: { capability: "image_generation", operationId: "image-op" },
  }));
  const readAsset = jest.fn(async () => new Uint8Array([1]).buffer);
  const execute = () => imageGenerationNode.execute({
    runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
    node: {
      id: "image", kind: imageGenerationNode.kind, version: imageGenerationNode.version,
      title: "Image", position: { x: 0, y: 0 },
      config: { count: 1, aspectRatio: "1:1", ...(configured ? { prompt } : {}) },
    },
    inputs: { ...(configured ? {} : { prompt }), images },
    services: {
      readAsset,
      api: { generateImage: async (request: StudioImageGenerationRequest) => submit(await request.buildPayload()) },
    },
    log: jest.fn(),
  } as never);
  return { execute, submit, readAsset };
}

describe("Studio image input validation", () => {
  it.each([false, true])("rejects an oversized prompt before submission (configured=%s)", async configured => {
    const { execute, submit, readAsset } = fixture("x".repeat(8_001), [], configured);
    await expect(execute()).rejects.toThrow("8,000 characters");
    expect(submit).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("preserves the complete accepted prompt, including instructions at the end", async () => {
    const prompt = "x".repeat(7_990) + "NO GLASSES";
    const { execute, submit } = fixture(prompt);
    await execute();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
  });

  it("rejects five distinct references rather than silently dropping one", async () => {
    const { execute, submit } = fixture("Portrait", references);
    await expect(execute()).rejects.toThrow("at most 4 distinct reference images");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps reference order and deduplicates identical content from different paths", async () => {
    const { execute, submit } = fixture("Portrait", [
      ...references.slice(0, 4), { ...references[0], path: "refs/anchor-copy.jpg" },
    ]);
    await execute();
    expect(submit.mock.calls[0][0].inputImages?.map(input => input.asset.hash))
      .toEqual(references.slice(0, 4).map(input => input.hash));
  });
});
