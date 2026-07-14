import { describe, expect, it } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";

function makeRootVector(
  namespace: string,
  path: string,
  mtime: number,
  options: { complete?: boolean; partial?: boolean } = {},
): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path.replace(/\.md$/i, ""),
      mtime,
      contentHash: `${path}-${mtime}`,
      generation: "semantic-v1",
      dimension: 3,
      createdAt: mtime,
      namespace,
      complete: options.complete ?? true,
      partial: options.partial ?? false,
    },
  };
}

describe("EmbeddingsStorage.peekCurrentManagedNamespace", () => {
  it("returns null when no vectors are loaded", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    expect(storage.peekCurrentManagedNamespace()).toBeNull();
  });

  it("keeps the more complete namespace while a newer replacement is partial", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const oldNamespace = "systemsculpt:managed:semantic-v1:v2:768";
    const newNamespace = "systemsculpt:managed:semantic-v1:v2:1024";
    const vectors: EmbeddingVector[] = [
      makeRootVector(oldNamespace, "A.md", 100),
      makeRootVector(oldNamespace, "B.md", 200),
      makeRootVector(newNamespace, "A.md", 300, { complete: false, partial: true }),
    ];

    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache = new Map(
      vectors.map((vector) => [vector.id, vector]),
    );

    expect(storage.peekCurrentManagedNamespace()).toBe(oldNamespace);
  });

  it("promotes a complete replacement once its corpus coverage catches up", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const oldNamespace = "systemsculpt:managed:semantic-v1:v2:768";
    const newNamespace = "systemsculpt:managed:semantic-v1:v2:1024";
    const vectors = [
      makeRootVector(oldNamespace, "A.md", 100),
      makeRootVector(oldNamespace, "B.md", 200),
      makeRootVector(newNamespace, "A.md", 300),
      makeRootVector(newNamespace, "B.md", 300),
    ];

    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache = new Map(
      vectors.map((vector) => [vector.id, vector]),
    );

    expect(storage.peekCurrentManagedNamespace()).toBe(newNamespace);
  });

  it("does not expose a namespace containing only partial roots", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const partial = makeRootVector(
      "systemsculpt:managed:semantic-v1:v2:1024",
      "A.md",
      300,
      { complete: false, partial: true },
    );
    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache = new Map([[partial.id, partial]]);

    expect(storage.peekCurrentManagedNamespace()).toBeNull();
  });

  it("ignores unrelated and obsolete namespaces", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const current = makeRootVector("systemsculpt:managed:semantic-v1:v2:3", "Current.md", 100);
    const unrelated = makeRootVector("unrelated:semantic:v9:3", "Custom.md", 999);
    const obsolete = makeRootVector("systemsculpt:managed:v1:3", "Old.md", 999);

    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache = new Map(
      [current, unrelated, obsolete].map((vector) => [vector.id, vector]),
    );

    expect(storage.peekCurrentManagedNamespace()).toBe(current.metadata.namespace);
  });

  it("lists every managed root namespace so startup can validate full corpus coverage", () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const complete = makeRootVector("systemsculpt:managed:semantic-v1:v2:768", "A.md", 100);
    const partial = makeRootVector(
      "systemsculpt:managed:semantic-v1:v2:1024",
      "A.md",
      200,
      { complete: false, partial: true },
    );
    const unrelated = makeRootVector("unrelated:semantic:v9:3", "Other.md", 300);
    (storage as unknown as { cache: Map<string, EmbeddingVector> }).cache = new Map(
      [complete, partial, unrelated].map((vector) => [vector.id, vector]),
    );

    expect(storage.listManagedRootNamespaces()).toEqual([
      partial.metadata.namespace,
      complete.metadata.namespace,
    ]);
  });
});
