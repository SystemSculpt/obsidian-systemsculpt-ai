import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsIndexFile } from "../EmbeddingsIndexFile";
import {
  EMBEDDINGS_INDEX_FORMAT,
  type SerializedEmbeddingsIndex,
} from "../EmbeddingsIndexSerialization";

function makeAdapter() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    exists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
    read: jest.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    }),
    write: jest.fn(async (p: string, data: string) => {
      files.set(p, data);
    }),
    mkdir: jest.fn(async (p: string) => {
      dirs.add(p);
    }),
  };
}

function sampleIndex(): SerializedEmbeddingsIndex {
  return {
    format: EMBEDDINGS_INDEX_FORMAT,
    createdAt: 1700000000000,
    vectorCount: 1,
    vectors: [
      {
        id: "ns::A.md#0",
        path: "A.md",
        chunkId: 0,
        vector: "",
        metadata: {
          title: "A",
          mtime: 1,
          contentHash: "h",
          provider: "systemsculpt",
          model: "m",
          dimension: 0,
          createdAt: 1,
          namespace: "ns",
          isEmpty: true,
        },
      },
    ],
  };
}

describe("EmbeddingsIndexFile", () => {
  it("writes then reads back the same envelope, creating the directory", async () => {
    const adapter = makeAdapter();
    const file = new EmbeddingsIndexFile(adapter as never);

    await file.write(sampleIndex());

    expect(adapter.mkdir).toHaveBeenCalledWith(".systemsculpt/embeddings");
    expect(adapter.write).toHaveBeenCalledWith(
      ".systemsculpt/embeddings/index.json",
      expect.any(String),
    );

    const read = await file.read();
    expect(read).toEqual(sampleIndex());
  });

  it("returns null when no snapshot exists", async () => {
    const adapter = makeAdapter();
    const file = new EmbeddingsIndexFile(adapter as never);

    expect(await file.exists()).toBe(false);
    expect(await file.read()).toBeNull();
  });

  it("returns null on a corrupt (unparseable) snapshot instead of throwing", async () => {
    const adapter = makeAdapter();
    adapter.files.set(".systemsculpt/embeddings/index.json", "{not json");
    const file = new EmbeddingsIndexFile(adapter as never);

    expect(await file.exists()).toBe(true);
    await expect(file.read()).resolves.toBeNull();
  });

  it("does not call mkdir when the directory already exists", async () => {
    const adapter = makeAdapter();
    adapter.dirs.add(".systemsculpt/embeddings");
    const file = new EmbeddingsIndexFile(adapter as never);

    await file.write(sampleIndex());
    expect(adapter.mkdir).not.toHaveBeenCalled();
  });
});
