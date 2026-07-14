import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import type { EmbeddingVector } from "../types";
import { buildManagedNamespace } from "../utils/namespace";
import { buildVectorId } from "../utils/vectorId";

function harness() {
  const namespace = buildManagedNamespace(2);
  const file = new TFile({
    path: "Note.md",
    name: "Note.md",
    extension: "md",
    stat: { mtime: 100, size: 20 },
  });
  const root: EmbeddingVector = {
    id: buildVectorId(namespace, file.path, 0),
    path: file.path,
    chunkId: 0,
    vector: new Float32Array([1, 0]),
    metadata: {
      title: "Note",
      mtime: 100,
      contentHash: "hash",
      generation: "semantic-v1",
      dimension: 2,
      createdAt: 100,
      namespace,
      complete: true,
      chunkCount: 1,
    },
  };
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  manager.initialized = true;
  manager.searchNamespace = namespace;
  manager.gateway = {
    activeGeneration: {
      id: "semantic-v1",
      indexSchemaVersion: 2,
      indexNamespace: namespace,
      dimensions: 2,
      limits: { maxTexts: 128, maxCharsPerText: 8000, maxTotalChars: 200000 },
    },
  };
  manager.workQueue = {
    get: jest.fn(() => null),
    snapshot: jest.fn(() => { throw new Error("bulk snapshot must not back a point lookup"); }),
  };
  manager.failedFiles = new Map();
  manager.config = {
    exclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
  };
  manager.plugin = { settings: {} };
  manager.app = { vault: { getAbstractFileByPath: jest.fn(() => file) } };
  manager.storage = {
    getVectorSync: jest.fn((id: string) => id === root.id ? root : null),
    getVectorsByPath: jest.fn(async () => [root]),
  };
  return { file, manager };
}

describe("EmbeddingsManager file freshness", () => {
  it("stops treating a modified note's old vector as ready or searchable", async () => {
    const { file, manager } = harness();

    expect(manager.getFileIndexSnapshot(file.path)).toMatchObject({ state: "ready", ready: true, indexedAt: 100 });
    expect(manager.hasVector(file.path)).toBe(true);

    file.stat.mtime = 101;

    expect(manager.getFileIndexSnapshot(file.path)).toMatchObject({ state: "stale", ready: false, indexedAt: 100 });
    expect(manager.hasVector(file.path)).toBe(false);
    await expect(manager.findSimilar(file.path)).resolves.toEqual([]);
    expect(manager.storage.getVectorsByPath).not.toHaveBeenCalled();
  });

  it("keeps search on the committed namespace while a replacement is incomplete", async () => {
    const { file, manager } = harness();
    const committedNamespace = buildManagedNamespace(2);
    const replacementNamespace = buildManagedNamespace(3);
    manager.searchNamespace = committedNamespace;
    manager.gateway.activeGeneration = {
      ...manager.gateway.activeGeneration,
      indexNamespace: replacementNamespace,
      dimensions: 3,
    };
    manager.searchIndexedNamespace = jest.fn(async () => [[]]);

    await manager.findSimilar(file.path);

    expect(manager.searchIndexedNamespace).toHaveBeenCalledWith(
      committedNamespace,
      expect.any(Array),
      expect.any(Number),
      undefined,
      file.path,
    );
  });
});
