import { describe, expect, it } from "@jest/globals";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import {
  LEGACY_EMBEDDINGS_INDEX_FORMAT,
  decodePortableShard,
  deserializeEmbeddingsIndex,
  encodePortableShard,
  portableShardOf,
  PORTABLE_SHARD_COUNT,
} from "../EmbeddingsIndexSerialization";
import { serializeLegacyEmbeddingsIndex as serializeEmbeddingsIndex } from "../../__tests__/support/legacyIndexFixture";
import { createLocalEmptyEmbeddingMarkerForRevision } from "../../LocalEmptyEmbeddingMarker";
import { dot, normalizeInPlace } from "../../utils/vector";

function makeVector(
  path: string,
  values: number[],
  overrides: Partial<EmbeddingVector["metadata"]> = {},
): EmbeddingVector {
  const namespace = overrides.namespace ?? (values.length > 0
    ? `systemsculpt:managed:semantic-v1:v3:${values.length}`
    : "systemsculpt:local-empty:v1:1");
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array(values),
    metadata: {
      title: path.replace(/\.md$/, ""),
      mtime: 1700000000000,
      contentHash: `${path}-hash`,
      ...(values.length > 0 ? { generation: "semantic-v1" } : {}),
      dimension: values.length,
      createdAt: 1700000000000,
      namespace,
      ...overrides,
    },
  };
}

describe("EmbeddingsIndexSerialization format 3 (read-only legacy)", () => {
  it("round-trips vectors through serialize -> deserialize with float32 fidelity", () => {
    const vectors = [
      makeVector("A.md", [0.1, 0.2, 0.3]),
      makeVector("B.md", [-1, 0.5, 0.25]),
    ];

    const serialized = serializeEmbeddingsIndex(vectors, { createdAt: 123 });
    expect(serialized.format).toBe(LEGACY_EMBEDDINGS_INDEX_FORMAT);
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
    const empty = makeVector("empty.md", [0], {
      isEmpty: true,
      generation: undefined,
      dimension: 1,
      namespace: "systemsculpt:local-empty:v1:1",
      complete: true,
      chunkCount: 0,
    });

    const restored = deserializeEmbeddingsIndex(serializeEmbeddingsIndex([empty]));
    expect(restored).toHaveLength(1);
    expect(restored[0].vector).toBeInstanceOf(Float32Array);
    expect(restored[0].vector.length).toBe(1);
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

  it("rejects truncated vectors and non-first-party namespaces", () => {
    const truncated = serializeEmbeddingsIndex([makeVector("truncated.md", [1, 0, 0])]);
    truncated.vectors[0].vector = btoa("12345");
    const unrelated = serializeEmbeddingsIndex([makeVector("unrelated.md", [1, 0, 0])]);
    unrelated.vectors[0].metadata.namespace = "unrelated:semantic:v9:3";

    expect(deserializeEmbeddingsIndex(truncated)).toEqual([]);
    expect(deserializeEmbeddingsIndex(unrelated)).toEqual([]);
  });

  it("accepts dynamic namespaces only when generation metadata matches exactly", () => {
    const dynamic = makeVector("future.md", [1, 0], {
      namespace: "systemsculpt:managed:semantic-v2.1:v17:2",
      generation: "semantic-v2.1",
    });
    const serialized = serializeEmbeddingsIndex([dynamic]);

    expect(deserializeEmbeddingsIndex(serialized)).toHaveLength(1);

    serialized.vectors[0].metadata.generation = "semantic-v2";
    expect(deserializeEmbeddingsIndex(serialized)).toEqual([]);
  });

  it("rejects a valid legacy format-2 envelope", () => {
    const legacy = serializeEmbeddingsIndex([makeVector("legacy.md", [1, 0])]);
    legacy.format = 2;

    expect(deserializeEmbeddingsIndex(legacy)).toEqual([]);
  });

  it("fails safe (empty array) on unknown format or junk envelopes", () => {
    expect(deserializeEmbeddingsIndex({ format: 999, vectors: [] } as never)).toEqual([]);
    expect(deserializeEmbeddingsIndex(null as never)).toEqual([]);
    expect(deserializeEmbeddingsIndex({} as never)).toEqual([]);
    expect(deserializeEmbeddingsIndex({ format: 3, vectors: "nope" } as never)).toEqual([]);
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function chunk(
  namespace: string,
  path: string,
  chunkId: number,
  vector: Float32Array,
  extra: Partial<EmbeddingVector["metadata"]> = {},
): EmbeddingVector {
  const generation = namespace.split(":")[2];
  return {
    id: buildVectorId(namespace, path, chunkId),
    path,
    chunkId,
    vector,
    metadata: {
      title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
      excerpt: `Excerpt ${chunkId}`,
      mtime: 1700000000000,
      contentHash: `${"a".repeat(63)}${chunkId}`,
      generation,
      dimension: vector.length,
      createdAt: 1700000000001,
      namespace,
      chunkLength: 40 + chunkId,
      ...(chunkId === 0 ? { complete: true, partial: false, failedChunkCount: 0, chunkCount: 2, sourceSha256: "b".repeat(64) } : {}),
      ...extra,
    },
  };
}

describe("EmbeddingsIndexSerialization format 4 shards", () => {
  const namespace = "systemsculpt:managed:semantic-v1:v3:8";
  const unit = (values: number[]) => {
    const vector = Float32Array.from(values);
    normalizeInPlace(vector);
    return vector;
  };

  it("round-trips notes, chunk tables and derivable fields through one shard", () => {
    const records = [
      chunk(namespace, "Projects/Plan.md", 0, unit([1, 2, 3, 4, 5, 6, 7, 8]), {
        headingPath: ["Plan", "Goals"],
        sectionTitle: "Plan › Goals",
      }),
      chunk(namespace, "Projects/Plan.md", 1, unit([8, 7, 6, 5, 4, 3, 2, 1]), { title: "Plan" }),
      chunk(namespace, "Renamed.md", 0, unit([1, 0, 0, 0, 0, 0, 0, 1]), { title: "Custom title" }),
      createLocalEmptyEmbeddingMarkerForRevision({ path: "Empty.md", basename: "Empty", mtime: 5 }, "", "c".repeat(64)),
      // A chunk without its root is never considered indexed and is dropped.
      chunk(namespace, "Orphan.md", 3, unit([1, 1, 1, 1, 1, 1, 1, 1])),
    ];

    const bytes = encodePortableShard(7, records)!;
    const decoded = decodePortableShard(bytes, 7);

    const byId = new Map(decoded.map((vector) => [vector.id, vector]));
    expect([...byId.keys()].sort()).toEqual([
      records[0].id, records[1].id, records[2].id, records[3].id,
    ].sort());
    const root = byId.get(records[0].id)!;
    expect(root.metadata).toEqual({
      ...records[0].metadata,
      excerpt: "Excerpt 0",
    });
    expect(byId.get(records[1].id)!.metadata).toMatchObject({
      title: "Plan",
      contentHash: records[1].metadata.contentHash,
      namespace,
      generation: "semantic-v1",
      dimension: 8,
      chunkLength: 41,
    });
    expect(byId.get(records[1].id)!.metadata.complete).toBeUndefined();
    expect(byId.get(records[2].id)!.metadata.title).toBe("Custom title");
    const marker = byId.get(records[3].id)!;
    expect(marker.metadata).toMatchObject({
      isEmpty: true,
      namespace: "systemsculpt:local-empty:v1:1",
      dimension: 1,
      complete: true,
      chunkCount: 0,
      sourceSha256: "c".repeat(64),
    });
    expect(Array.from(marker.vector)).toEqual([0]);
    for (const original of records.slice(0, 3)) {
      expect(dot(byId.get(original.id)!.vector, original.vector)).toBeGreaterThan(0.9999);
    }
  });

  it("stores int8 vectors: a third of raw Float32 and under a quarter of the format-3 file", () => {
    const random = seededRandom(7);
    const dimensions = 1536;
    const records = Array.from({ length: 40 }, (_, index) => {
      const vector = Float32Array.from({ length: dimensions }, () => gaussian(random));
      normalizeInPlace(vector);
      return chunk(`systemsculpt:managed:semantic-v1:v3:${dimensions}`, `Note-${index}.md`, 0, vector);
    });

    const bytes = encodePortableShard(0, records)!.byteLength;
    const legacy = JSON.stringify(serializeEmbeddingsIndex(records)).length;

    // Each record is 1,540 vector bytes plus its path, hashes and excerpt.
    expect(bytes).toBeLessThan(0.35 * records.length * dimensions * 4);
    expect(legacy / bytes).toBeGreaterThan(4);
  });

  it("keeps cosine similarity within 2e-3 and top-10 recall at or above 0.97 after int8 quantization", () => {
    // Anisotropic, clustered unit vectors resemble real embeddings better than
    // isotropic noise: a shared mean direction plus topic clusters.
    const random = seededRandom(42);
    const dimensions = 1536;
    const draw = () => {
      const vector = Float32Array.from({ length: dimensions }, () => gaussian(random));
      normalizeInPlace(vector);
      return vector;
    };
    const mean = draw();
    const centers = Array.from({ length: 24 }, draw);
    const sample = () => {
      const center = centers[Math.floor(random() * centers.length)];
      const weight = 0.35 + random() * 0.4;
      const vector = new Float32Array(dimensions);
      for (let index = 0; index < dimensions; index += 1) {
        vector[index] = 0.45 * mean[index] + weight * center[index] + (1 - weight) * 2.7 * gaussian(random) / Math.sqrt(dimensions);
      }
      normalizeInPlace(vector);
      return vector;
    };
    const corpus = Array.from({ length: 400 }, (_, index) => chunk(
      `systemsculpt:managed:semantic-v1:v3:${dimensions}`,
      `Note-${index}.md`,
      0,
      sample(),
    ));
    const restored = new Map(
      decodePortableShard(encodePortableShard(0, corpus)!, 0).map((vector) => [vector.path, vector.vector]),
    );
    let worstError = 0;
    let recall = 0;
    const queries = Array.from({ length: 20 }, sample);
    for (const query of queries) {
      const exact = corpus
        .map((record) => ({ path: record.path, score: dot(query, record.vector) }))
        .sort((left, right) => right.score - left.score);
      const approximate = corpus
        .map((record) => ({ path: record.path, score: dot(query, restored.get(record.path)!) }))
        .sort((left, right) => right.score - left.score);
      for (const entry of exact) {
        worstError = Math.max(worstError, Math.abs(entry.score - dot(query, restored.get(entry.path)!)));
      }
      const top = new Set(exact.slice(0, 10).map((entry) => entry.path));
      recall += approximate.slice(0, 10).filter((entry) => top.has(entry.path)).length / 10;
    }

    expect(worstError).toBeLessThan(2e-3);
    expect(recall / queries.length).toBeGreaterThanOrEqual(0.97);
  });

  it("rejects a truncated, corrupted or misplaced shard instead of restoring garbage", () => {
    const bytes = encodePortableShard(3, [chunk(namespace, "A.md", 0, unit([1, 0, 0, 0, 0, 0, 0, 0]))])!;
    const flipped = bytes.slice(0);
    const view = new Uint8Array(flipped);
    view[view.length - 1] ^= 0xff;

    expect(() => decodePortableShard(bytes.slice(0, bytes.byteLength - 1), 3)).toThrow();
    expect(() => decodePortableShard(flipped, 3)).toThrow("checksum");
    expect(() => decodePortableShard(bytes, 4)).toThrow("header");
    expect(decodePortableShard(bytes, 3)).toHaveLength(1);
  });

  it("assigns every path a stable shard", () => {
    const shard = portableShardOf("Folder/Note.md");
    expect(shard).toBe(portableShardOf("Folder/Note.md"));
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(PORTABLE_SHARD_COUNT);
    const used = new Set(Array.from({ length: 500 }, (_, index) => portableShardOf(`Notes/${index}.md`)));
    expect(used.size).toBe(PORTABLE_SHARD_COUNT);
  });
});
