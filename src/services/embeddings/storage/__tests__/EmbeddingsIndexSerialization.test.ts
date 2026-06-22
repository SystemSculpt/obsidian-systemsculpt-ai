import { describe, expect, it } from "@jest/globals";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import {
  EMBEDDINGS_INDEX_FORMAT,
  deserializeEmbeddingsIndex,
  serializeEmbeddingsIndex,
} from "../EmbeddingsIndexSerialization";

function makeVector(
  path: string,
  values: number[],
  overrides: Partial<EmbeddingVector["metadata"]> = {},
): EmbeddingVector {
  const namespace = `systemsculpt:openai/text-embedding-3-small:v2:${values.length}`;
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array(values),
    metadata: {
      title: path.replace(/\.md$/, ""),
      mtime: 1700000000000,
      contentHash: `${path}-hash`,
      provider: "systemsculpt",
      model: "openai/text-embedding-3-small",
      dimension: values.length,
      createdAt: 1700000000000,
      namespace,
      ...overrides,
    },
  };
}

describe("EmbeddingsIndexSerialization", () => {
  it("round-trips vectors through serialize -> deserialize with float32 fidelity", () => {
    const vectors = [
      makeVector("A.md", [0.1, 0.2, 0.3]),
      makeVector("B.md", [-1, 0.5, 0.25]),
    ];

    const serialized = serializeEmbeddingsIndex(vectors, { createdAt: 123 });
    expect(serialized.format).toBe(EMBEDDINGS_INDEX_FORMAT);
    expect(serialized.vectorCount).toBe(2);
    expect(serialized.createdAt).toBe(123);

    const restored = deserializeEmbeddingsIndex(serialized);
    expect(restored).toHaveLength(2);

    const a = restored.find((v) => v.path === "A.md");
    expect(a).toBeDefined();
    expect(a!.id).toBe(vectors[0].id);
    expect(a!.chunkId).toBe(0);
    expect(a!.metadata.namespace).toBe(vectors[0].metadata.namespace);
    expect(a!.metadata.contentHash).toBe("A.md-hash");
    expect(a!.vector).toBeInstanceOf(Float32Array);
    // float32 storage rounds the literals; the round-trip must reproduce the
    // exact same 32-bit values, not the f64 originals.
    expect(Array.from(a!.vector)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it("preserves intentionally-empty vectors and metadata flags", () => {
    const empty = makeVector("empty.md", [], {
      isEmpty: true,
      dimension: 0,
      complete: true,
      chunkCount: 0,
    });

    const restored = deserializeEmbeddingsIndex(serializeEmbeddingsIndex([empty]));
    expect(restored).toHaveLength(1);
    expect(restored[0].vector).toBeInstanceOf(Float32Array);
    expect(restored[0].vector.length).toBe(0);
    expect(restored[0].metadata.isEmpty).toBe(true);
    expect(restored[0].metadata.complete).toBe(true);
    expect(restored[0].metadata.chunkCount).toBe(0);
  });

  it("skips malformed records instead of throwing (corruption recovery)", () => {
    const serialized = serializeEmbeddingsIndex([makeVector("ok.md", [1, 0, 0])]);
    // Corrupt the payload with junk a hand-edited / partially-synced file might contain.
    (serialized.vectors as unknown[]).push({ id: "x", path: "bad.md", vector: "%%%not-base64" });
    (serialized.vectors as unknown[]).push(null);
    (serialized.vectors as unknown[]).push({ path: "no-id.md" });

    const restored = deserializeEmbeddingsIndex(serialized);
    expect(restored.map((v) => v.path)).toEqual(["ok.md"]);
  });

  it("fails safe (empty array) on unknown format or junk envelopes", () => {
    expect(deserializeEmbeddingsIndex({ format: 999, vectors: [] } as never)).toEqual([]);
    expect(deserializeEmbeddingsIndex(null as never)).toEqual([]);
    expect(deserializeEmbeddingsIndex({} as never)).toEqual([]);
    expect(deserializeEmbeddingsIndex({ format: 1, vectors: "nope" } as never)).toEqual([]);
  });
});
