import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { EmbeddingsStorage } from "../EmbeddingsStorage";
import { EmbeddingsIndexFile } from "../EmbeddingsIndexFile";
import {
  PortableCheckpointCoordinator,
  restoreEmbeddingsIndexIfEmpty,
} from "../EmbeddingsPortableIndex";
import { portableShardOf } from "../EmbeddingsIndexSerialization";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { dot, normalizeInPlace } from "../../utils/vector";
import { installFakeIndexedDb } from "../../__tests__/support/fakeIndexedDb";
import { serializeLegacyEmbeddingsIndex } from "../../__tests__/support/legacyIndexFixture";

const V2 = "systemsculpt:managed:semantic-v1:v2:4";
const V3 = "systemsculpt:managed:semantic-v1:v3:4";

function records(namespace: string, path: string, chunks: number, seed: number): EmbeddingVector[] {
  return Array.from({ length: chunks }, (_, chunkId) => {
    const vector = Float32Array.from({ length: 4 }, (_, index) => Math.sin(seed + chunkId * 7 + index));
    normalizeInPlace(vector);
    return {
      id: buildVectorId(namespace, path, chunkId),
      path,
      chunkId,
      vector,
      metadata: {
        title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
        excerpt: `${path} chunk ${chunkId}`,
        mtime: 1_000 + seed,
        contentHash: `${seed}`.padStart(64, "0"),
        generation: "semantic-v1",
        dimension: 4,
        createdAt: 2_000 + seed,
        namespace,
        chunkLength: 10 + chunkId,
        ...(chunkId === 0 ? {
          complete: true,
          partial: false,
          failedChunkCount: 0,
          chunkCount: chunks,
          sourceSha256: `${seed}`.padStart(64, "f"),
        } : {}),
      },
    };
  });
}

/** A vault folder backed by a Map, with the DataAdapter calls the index uses. */
function vaultFolder() {
  const files = new Map<string, ArrayBuffer | string>();
  const dirs = new Set<string>();
  return {
    files,
    exists: async (path: string) => files.has(path) || dirs.has(path),
    mkdir: async (path: string) => { dirs.add(path); },
    read: async (path: string) => files.get(path) as string,
    write: async (path: string, data: string) => { files.set(path, data); },
    readBinary: async (path: string) => files.get(path) as ArrayBuffer,
    writeBinary: async (path: string, data: ArrayBuffer) => { files.set(path, data); },
    stat: async (path: string) => {
      const value = files.get(path);
      return value === undefined
        ? null
        : { type: "file", ctime: 0, mtime: 0, size: typeof value === "string" ? value.length : value.byteLength };
    },
    list: async (dir: string) => ({ files: [...files.keys()].filter((path) => path.startsWith(`${dir}/`)), folders: [] }),
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    remove: async (path: string) => { files.delete(path); },
  };
}

async function openStorage(name: string): Promise<EmbeddingsStorage> {
  const storage = new EmbeddingsStorage(`SystemSculptEmbeddings::${name}`);
  await storage.initialize();
  await storage.loadEmbeddings();
  return storage;
}

describe("portable index round trip through real storage and files", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  it("restores on a second device exactly what the first device indexed", async () => {
    const folder = vaultFolder();
    const first = await openStorage("device-a");
    const indexed = [
      ...records(V3, "Projects/Plan.md", 3, 1),
      ...records(V3, "Daily/2026-09-25.md", 1, 2),
      ...records(V3, "Notes/Idea.md", 2, 3),
    ];
    for (const path of new Set(indexed.map((record) => record.path))) {
      await first.publishPath(path, V3, indexed.filter((record) => record.path === path));
    }
    const checkpoint = new PortableCheckpointCoordinator({
      store: first,
      file: new EmbeddingsIndexFile(folder as never),
      committedNamespace: () => V3,
    });
    checkpoint.markChanged();
    await checkpoint.flush();
    checkpoint.cancel();

    expect(JSON.parse(folder.files.get(".systemsculpt/embeddings/index.json") as string)).toEqual({
      format: 4,
      vectorEncoding: "int8-scaled-v1",
      shardCount: 32,
      committedNamespace: V3,
    });

    const second = await openStorage("device-b");
    const result = await restoreEmbeddingsIndexIfEmpty({
      store: second,
      file: new EmbeddingsIndexFile(folder as never),
    });

    expect(result).toMatchObject({ restored: true, imported: indexed.length });
    await second.loadEmbeddings();
    for (const path of new Set(indexed.map((record) => record.path))) {
      const restored = await second.getVectorsByPath(path);
      const originals = indexed.filter((record) => record.path === path);
      expect(restored.map((record) => record.id).sort()).toEqual(originals.map((record) => record.id).sort());
      for (const original of originals) {
        const copy = restored.find((record) => record.id === original.id)!;
        expect(copy.metadata).toEqual(original.metadata);
        expect(dot(copy.vector, original.vector)).toBeGreaterThan(0.9999);
      }
    }
    // Restored records are the snapshot itself, not changes to write back.
    expect(second.takePortableChanges()).toEqual({ all: false, paths: [] });
    const secondCheckpoint = new PortableCheckpointCoordinator({ store: second, file: new EmbeddingsIndexFile(folder as never) });
    await secondCheckpoint.reconcileFormat();
    expect(secondCheckpoint.status().pending).toBe(false);
    secondCheckpoint.cancel();
  });

  it("restores only notes this vault still has and rewrites the shards that held the rest", async () => {
    const folder = vaultFolder();
    const first = await openStorage("device-with-extra-notes");
    for (const [index, path] of ["Kept.md", "Deleted.md", "Private/Secret.md"].entries()) {
      await first.publishPath(path, V3, records(V3, path, 1, index));
    }
    const writer = new PortableCheckpointCoordinator({ store: first, file: new EmbeddingsIndexFile(folder as never) });
    writer.markChanged();
    await writer.flush();
    writer.cancel();

    const second = await openStorage("device-without-them");
    const file = new EmbeddingsIndexFile(folder as never);
    await restoreEmbeddingsIndexIfEmpty({ store: second, file, isRestorable: (path) => path === "Kept.md" });
    await second.loadEmbeddings();
    expect(second.getDistinctPaths()).toEqual(["Kept.md"]);

    const checkpoint = new PortableCheckpointCoordinator({ store: second, file });
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    checkpoint.cancel();
    const third = await openStorage("device-restoring-later");
    await restoreEmbeddingsIndexIfEmpty({ store: third, file: new EmbeddingsIndexFile(folder as never) });
    await third.loadEmbeddings();
    expect(third.getDistinctPaths()).toEqual(["Kept.md"]);
  });

  it("migrates an older release's index.json in place and keeps restores working", async () => {
    const folder = vaultFolder();
    const legacy = [
      ...records(V2, "Old.md", 1, 4),
      ...records(V3, "A.md", 2, 5),
      ...records(V3, "B.md", 1, 6),
    ];
    folder.files.set(".systemsculpt/embeddings/index.json", JSON.stringify(serializeLegacyEmbeddingsIndex(legacy)));
    const device = await openStorage("legacy-device");
    const file = new EmbeddingsIndexFile(folder as never);

    await expect(restoreEmbeddingsIndexIfEmpty({ store: device, file })).resolves.toMatchObject({ restored: true });
    await device.loadEmbeddings();
    const checkpoint = new PortableCheckpointCoordinator({ store: device, file, committedNamespace: () => V3 });
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    checkpoint.cancel();

    const manifest = JSON.parse(folder.files.get(".systemsculpt/embeddings/index.json") as string);
    expect(manifest.format).toBe(4);
    const shardFiles = [...folder.files.keys()].filter((path) => path.endsWith(".bin")).sort();
    // The superseded v2 generation is not restored, so it is not written back (#324).
    expect(shardFiles).toEqual([...new Set(["A.md", "B.md"].map((path) => (
      `.systemsculpt/embeddings/shards/${String(portableShardOf(path)).padStart(2, "0")}.bin`
    )))].sort());

    const next = await openStorage("next-device");
    await restoreEmbeddingsIndexIfEmpty({ store: next, file: new EmbeddingsIndexFile(folder as never) });
    expect((await next.getVectorsByPath("A.md")).map((record) => record.id).sort()).toEqual([
      buildVectorId(V3, "A.md", 0),
      buildVectorId(V3, "A.md", 1),
    ]);
  });

  it("rewrites only the shards of changed notes and never for an mtime-only touch", async () => {
    const folder = vaultFolder();
    const storage = await openStorage("incremental");
    const paths = Array.from({ length: 60 }, (_, index) => `Notes/${index}.md`);
    for (const [index, path] of paths.entries()) await storage.publishPath(path, V3, records(V3, path, 1, index));
    const file = new EmbeddingsIndexFile(folder as never);
    const checkpoint = new PortableCheckpointCoordinator({ store: storage, file });
    checkpoint.markChanged();
    await checkpoint.flush();
    const before = new Map([...folder.files].filter(([path]) => path.endsWith(".bin")));

    await storage.touchPath("Notes/1.md", V3, { mtime: 9_999, title: "1" });
    await storage.publishPath("Notes/2.md", V3, records(V3, "Notes/2.md", 2, 77));
    checkpoint.markChanged();
    await checkpoint.flush();
    checkpoint.cancel();

    const changed = [...folder.files]
      .filter(([path, bytes]) => path.endsWith(".bin") && before.get(path) !== bytes)
      .map(([path]) => path);
    expect(changed).toEqual([`.systemsculpt/embeddings/shards/${String(portableShardOf("Notes/2.md")).padStart(2, "0")}.bin`]);
  });
});
