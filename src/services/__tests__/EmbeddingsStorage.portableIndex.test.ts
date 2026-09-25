import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";
import { installFakeIndexedDb } from "../embeddings/__tests__/support/fakeIndexedDb";

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
  it("imports restored records without reporting them as snapshot changes", async () => {
    const fake = installFakeIndexedDb();
    try {
      const storage = new EmbeddingsStorage("SystemSculptEmbeddings::import");
      await storage.initialize();

      const result = await storage.importVectors([makeVector("A.md"), makeVector("B.md")]);

      expect(result).toEqual({ imported: 2 });
      expect(storage.getDistinctPaths().sort()).toEqual(["A.md", "B.md"]);
      expect(storage.takePortableChanges()).toEqual({ all: false, paths: [] });

      await storage.storeVectors([makeVector("C.md")]);
      expect(storage.takePortableChanges()).toEqual({ all: false, paths: ["C.md"] });
      expect((await storage.readPaths(["A.md", "C.md"])).map((vector) => vector.path).sort()).toEqual(["A.md", "C.md"]);
    } finally {
      fake.restore();
    }
  });

  it("importVectors stores nothing for an empty restore", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const spy = jest.spyOn(storage, "storeVectors").mockResolvedValue();

    const result = await storage.importVectors([]);

    expect(result).toEqual({ imported: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});
