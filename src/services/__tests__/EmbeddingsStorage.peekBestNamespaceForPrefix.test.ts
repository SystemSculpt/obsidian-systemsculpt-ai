import { describe, expect, it } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";

function makeRootVector(namespace: string, path: string, mtime: number): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path.replace(/\.md$/i, ""),
      mtime,
      contentHash: `${path}-${mtime}`,
      provider: "custom",
      model: "model",
      dimension: 3,
      createdAt: mtime,
      namespace,
    },
  };
}

describe("EmbeddingsStorage.peekBestNamespaceForPrefix", () => {
  it("returns null when no vectors are loaded", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    expect(storage.peekBestNamespaceForPrefix("custom:model:v2:")).toBeNull();
  });

  it("prefers the namespace with the newest root mtime", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const prefix = "custom:model:v2:";
    const nsOld = `${prefix}768`;
    const nsNew = `${prefix}1024`;

    const vectors: EmbeddingVector[] = [
      makeRootVector(nsOld, "A.md", 100),
      makeRootVector(nsOld, "B.md", 200),
      makeRootVector(nsNew, "A.md", 300),
    ];

    (storage as any).cache = new Map(vectors.map((v) => [v.id, v]));

    expect(storage.peekBestNamespaceForPrefix(prefix)).toBe(nsNew);
  });
});

