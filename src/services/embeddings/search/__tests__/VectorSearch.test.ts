import { VectorSearch } from "../VectorSearch";
import type { EmbeddingVector } from "../../types";

function vector(index: number): EmbeddingVector {
  return {
    id: `vector-${index}`,
    path: `Note-${index}.md`,
    chunkId: 0,
    vector: new Float32Array([1, 0]),
    metadata: {
      title: `Note ${index}`,
      excerpt: "Excerpt",
      mtime: 1,
      contentHash: String(index),
      provider: "systemsculpt",
      model: "managed",
      dimension: 2,
      createdAt: 1,
      namespace: "systemsculpt:managed:v1:2",
      complete: true,
    },
  };
}

describe("VectorSearch cancellation", () => {
  it("releases a yielded search immediately and skips remaining chunks", async () => {
    const controller = new AbortController();
    const onProgress = jest.fn();
    const search = new VectorSearch().findSimilarAsync(
      new Float32Array([1, 0]),
      Array.from({ length: 100 }, (_, index) => vector(index)),
      10,
      { chunkSize: 1, yieldMs: 10_000, onProgress, signal: controller.signal },
    );

    await Promise.resolve();
    controller.abort();

    await expect(search).resolves.toEqual([]);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
