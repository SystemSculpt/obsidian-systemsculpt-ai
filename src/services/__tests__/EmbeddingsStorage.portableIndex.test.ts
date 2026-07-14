import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import {
  EMBEDDINGS_INDEX_FORMAT,
  serializeEmbeddingsIndex,
} from "../embeddings/storage/EmbeddingsIndexSerialization";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";

function makeVector(path: string): EmbeddingVector {
  const namespace = "systemsculpt:managed:semantic-v1:v2:3";
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path.replace(/\.md$/, ""),
      mtime: 1,
      contentHash: `${path}-hash`,
      generation: "semantic-v1",
      dimension: 3,
      createdAt: 1,
      namespace,
    },
  };
}

describe("EmbeddingsStorage portable index", () => {
  it("exportAll serializes the in-memory vectors into a versioned envelope", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const a = makeVector("A.md");
    const b = makeVector("B.md");
    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache.set(a.id, a);
    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache.set(b.id, b);

    const index = await storage.exportAll();

    expect(index.format).toBe(EMBEDDINGS_INDEX_FORMAT);
    expect(index.vectorCount).toBe(2);
    expect(index.vectors.map((v) => v.path).sort()).toEqual(["A.md", "B.md"]);
  });

  it("importAll deserializes and delegates to storeVectors", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const stored: EmbeddingVector[][] = [];
    jest
      .spyOn(storage, "storeVectors")
      .mockImplementation(async (vectors: EmbeddingVector[]) => {
        stored.push(vectors);
      });

    const envelope = serializeEmbeddingsIndex([makeVector("A.md"), makeVector("B.md")]);
    const result = await storage.importAll(envelope);

    expect(result).toEqual({ imported: 2 });
    expect(stored).toHaveLength(1);
    expect(stored[0].map((v) => v.path).sort()).toEqual(["A.md", "B.md"]);
    expect(stored[0][0].vector).toBeInstanceOf(Float32Array);
  });

  it("importAll ignores an unreadable envelope without storing anything", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const spy = jest.spyOn(storage, "storeVectors").mockResolvedValue();

    const result = await storage.importAll({ format: 999, vectors: [] } as never);

    expect(result).toEqual({ imported: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});
