import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsIndexFile } from "../EmbeddingsIndexFile";
import {
  LEGACY_EMBEDDINGS_INDEX_FORMAT,
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
    format: LEGACY_EMBEDDINGS_INDEX_FORMAT,
    createdAt: 1700000000000,
    vectorCount: 1,
    vectors: [
      {
        id: "ns::A.md#0",
        path: "A.md",
        chunkId: 0,
        vector: "AAAAAA==",
        metadata: {
          title: "A",
          mtime: 1,
          contentHash: "h",
          dimension: 1,
          createdAt: 1,
          namespace: "systemsculpt:local-empty:v1:1",
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

  it("atomically replaces an existing checkpoint on adapters that cannot rename over a target", async () => {
    const adapter = makeAdapter() as ReturnType<typeof makeAdapter> & {
      rename: jest.Mock;
      remove: jest.Mock;
    };
    adapter.files.set(".systemsculpt/embeddings/index.json", JSON.stringify({ old: true }));
    adapter.rename = jest.fn(async (from: string, to: string) => {
      if (adapter.files.has(to)) throw new Error("target exists");
      const value = adapter.files.get(from);
      if (value === undefined) throw new Error("source missing");
      adapter.files.delete(from);
      adapter.files.set(to, value);
    });
    adapter.remove = jest.fn(async (path: string) => { adapter.files.delete(path); });
    const file = new EmbeddingsIndexFile(adapter as never);

    await file.write(sampleIndex());

    expect(await file.read()).toEqual(sampleIndex());
    expect(adapter.files.has(".systemsculpt/embeddings/index.json.previous")).toBe(false);
    expect(adapter.files.has(".systemsculpt/embeddings/index.json.next")).toBe(false);
  });

  it("falls back to the .previous checkpoint when the primary file is missing", async () => {
    const adapter = makeAdapter();
    adapter.files.set(".systemsculpt/embeddings/index.json.previous", JSON.stringify(sampleIndex()));
    const file = new EmbeddingsIndexFile(adapter as never);

    expect(await file.read()).toEqual(sampleIndex());
  });

  it("falls back to the .previous checkpoint when the primary file is unparseable", async () => {
    const adapter = makeAdapter();
    adapter.files.set(".systemsculpt/embeddings/index.json", "{not json");
    adapter.files.set(".systemsculpt/embeddings/index.json.previous", JSON.stringify(sampleIndex()));
    const file = new EmbeddingsIndexFile(adapter as never);

    expect(await file.read()).toEqual(sampleIndex());
  });

  it("prefers the primary file over a stale .previous checkpoint", async () => {
    const adapter = makeAdapter();
    adapter.files.set(".systemsculpt/embeddings/index.json", JSON.stringify(sampleIndex()));
    adapter.files.set(".systemsculpt/embeddings/index.json.previous", JSON.stringify({ stale: true }));
    const file = new EmbeddingsIndexFile(adapter as never);

    expect(await file.read()).toEqual(sampleIndex());
  });

  it.each(["missing", "corrupt"])("preserves the recovery checkpoint when the primary is %s and replacement fails", async (primaryState) => {
    const adapter = {
      ...makeAdapter(),
      rename: jest.fn(async () => { throw new Error("disk detached"); }),
      remove: jest.fn(async (path: string) => { adapter.files.delete(path); }),
    };
    adapter.files.set(".systemsculpt/embeddings/index.json.previous", JSON.stringify(sampleIndex()));
    if (primaryState === "corrupt") adapter.files.set(".systemsculpt/embeddings/index.json", "{truncated");
    const file = new EmbeddingsIndexFile(adapter as never);

    await expect(file.write(sampleIndex())).rejects.toThrow("disk detached");

    expect(await file.read()).toEqual(sampleIndex());
  });

  it("removes recovery and temporary snapshots along with the primary snapshot", async () => {
    const adapter = {
      ...makeAdapter(),
      remove: jest.fn(async (path: string) => { adapter.files.delete(path); }),
    };
    const primary = ".systemsculpt/embeddings/index.json";
    for (const path of [primary, `${primary}.previous`, `${primary}.next`]) {
      adapter.files.set(path, JSON.stringify(sampleIndex()));
    }
    const file = new EmbeddingsIndexFile(adapter as never);

    await file.remove();

    expect(await file.read()).toBeNull();
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it.each([
    ["primary", "read"], ["previous", "read"], ["previous", "exists"],
  ] as const)("preserves both snapshots when %s %s fails during replacement recovery", async (candidate, operation) => {
    const adapter = {
      ...makeAdapter(),
      rename: jest.fn(async () => { throw new Error("target exists"); }),
      remove: jest.fn(async (path: string) => { adapter.files.delete(path); }),
    };
    const primary = ".systemsculpt/embeddings/index.json";
    const previous = `${primary}.previous`;
    const primaryBytes = JSON.stringify({ ...sampleIndex(), createdAt: 20 });
    const previousBytes = JSON.stringify({ ...sampleIndex(), createdAt: 10 });
    adapter.files.set(primary, primaryBytes);
    adapter.files.set(previous, previousBytes);
    const failingPath = candidate === "primary" ? primary : previous;
    if (operation === "read") {
      adapter.read.mockImplementation(async path => {
        if (path === failingPath) throw new Error("temporary read failure");
        return adapter.files.get(path)!;
      });
    } else {
      adapter.exists.mockImplementation(async path => {
        if (path === failingPath) throw new Error("temporary stat failure");
        return adapter.files.has(path) || adapter.dirs.has(path);
      });
    }
    const file = new EmbeddingsIndexFile(adapter as never);

    await expect(file.write(sampleIndex())).rejects.toThrow("target exists");

    expect(adapter.files.get(primary)).toBe(primaryBytes);
    expect(adapter.files.get(previous)).toBe(previousBytes);
    expect(adapter.files.has(`${primary}.next`)).toBe(false);
    expect(adapter.rename).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original replace error and removes the temp file when rollback also fails", async () => {
    const adapter = makeAdapter() as ReturnType<typeof makeAdapter> & {
      rename: jest.Mock;
      remove: jest.Mock;
    };
    const primary = ".systemsculpt/embeddings/index.json";
    const previous = `${primary}.previous`;
    const next = `${primary}.next`;
    adapter.files.set(primary, JSON.stringify({ old: true }));
    const renames: Array<[string, string]> = [];
    adapter.rename = jest.fn(async (from: string, to: string) => {
      renames.push([from, to]);
      // 1: next -> primary refused because the target exists.
      if (renames.length === 1) throw new Error("target exists");
      // 2: primary -> previous succeeds.
      if (renames.length === 2) {
        adapter.files.set(to, adapter.files.get(from) as string);
        adapter.files.delete(from);
        return;
      }
      // 3: next -> primary fails; 4: rollback previous -> primary fails too.
      throw new Error(renames.length === 3 ? "disk detached" : "rollback failed");
    });
    adapter.remove = jest.fn(async (path: string) => { adapter.files.delete(path); });
    const file = new EmbeddingsIndexFile(adapter as never);

    await expect(file.write(sampleIndex())).rejects.toThrow("target exists");

    expect(renames).toEqual([
      [next, primary],
      [primary, previous],
      [next, primary],
      [previous, primary],
    ]);
    expect(adapter.files.has(next)).toBe(false);
    // The last good snapshot is still served through the .previous fallback.
    expect(await file.read()).toEqual({ old: true });
  });

  describe("shards", () => {
    function binaryAdapter(options: { renameOverExisting?: boolean } = {}) {
      const files = new Map<string, ArrayBuffer | string>();
      const dirs = new Set<string>();
      const adapter = {
        files,
        dirs,
        exists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
        mkdir: jest.fn(async (p: string) => { dirs.add(p); }),
        read: jest.fn(async (p: string) => files.get(p) as string),
        write: jest.fn(async (p: string, data: string) => { files.set(p, data); }),
        readBinary: jest.fn(async (p: string) => files.get(p) as ArrayBuffer),
        writeBinary: jest.fn(async (p: string, data: ArrayBuffer) => { files.set(p, data); }),
        stat: jest.fn(async (p: string) => {
          const value = files.get(p);
          if (value === undefined) return null;
          return { type: "file", ctime: 0, mtime: 0, size: typeof value === "string" ? value.length : value.byteLength };
        }),
        list: jest.fn(async (dir: string) => ({
          files: [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
          folders: [],
        })),
        rename: jest.fn(async (from: string, to: string) => {
          if (files.has(to) && options.renameOverExisting === false) throw new Error("target exists");
          files.set(to, files.get(from)!);
          files.delete(from);
        }),
        remove: jest.fn(async (p: string) => { files.delete(p); }),
      };
      return adapter;
    }

    it("replaces a shard through a temporary file, also where rename cannot overwrite", async () => {
      const adapter = binaryAdapter({ renameOverExisting: false });
      const file = new EmbeddingsIndexFile(adapter as never);

      await file.writeShard(3, new Uint8Array([1, 2]).buffer);
      await file.writeShard(3, new Uint8Array([3, 4, 5]).buffer);

      expect(adapter.mkdir).toHaveBeenCalledWith(".systemsculpt/embeddings/shards");
      expect(new Uint8Array((await file.readShard(3))!)).toEqual(new Uint8Array([3, 4, 5]));
      expect(adapter.files.has(".systemsculpt/embeddings/shards/03.bin.next")).toBe(false);
      expect(await file.listShards()).toEqual(new Set([3]));
    });

    it("reports the manifest size and removes shards along with the manifest", async () => {
      const adapter = binaryAdapter();
      const file = new EmbeddingsIndexFile(adapter as never);
      await file.write({ format: 4 });
      await file.writeShard(0, new Uint8Array([1]).buffer);
      await file.writeShard(31, new Uint8Array([2]).buffer);

      expect(await file.size()).toBe(JSON.stringify({ format: 4 }).length);

      await file.remove();

      expect(await file.size()).toBeNull();
      expect(await file.listShards()).toEqual(new Set());
      expect([...adapter.files.keys()]).toEqual([]);
    });

    it("drops an older release's parked recovery copy", async () => {
      const adapter = binaryAdapter();
      adapter.files.set(".systemsculpt/embeddings/index.json.previous", JSON.stringify(sampleIndex()));
      const file = new EmbeddingsIndexFile(adapter as never);

      await file.removeRecoveryCopy();

      expect(adapter.files.size).toBe(0);
    });
  });
});
