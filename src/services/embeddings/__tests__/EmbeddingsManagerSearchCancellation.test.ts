import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import type { EmbeddingVector } from "../types";

const namespace = "systemsculpt:managed:semantic-v1:v2:2";

function vector(path: string, chunkId = 0): EmbeddingVector {
  return {
    id: `${namespace}::${path}#${chunkId}`,
    path,
    chunkId,
    vector: new Float32Array([1, 0]),
    metadata: {
      title: path,
      excerpt: path,
      mtime: 1,
      contentHash: path,
      generation: "semantic-v1",
      dimension: 2,
      createdAt: 1,
      namespace,
      complete: true,
    },
  };
}

function managerHarness() {
  const source = new TFile({
    path: "Source.md",
    name: "Source.md",
    extension: "md",
    stat: { mtime: 1, size: 10 },
  });
  const sourceVector = vector(source.path);
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  manager.initialized = true;
  manager.searchNamespace = namespace;
  manager.workQueue = { get: jest.fn(() => null) };
  manager.gateway = {
    activeGeneration: {
      id: "semantic-v1",
      indexSchemaVersion: 2,
      indexNamespace: namespace,
      dimensions: 2,
      limits: { maxTexts: 128, maxCharsPerText: 8000, maxTotalChars: 200000 },
    },
  };
  manager.config = {
    exclusions: {
      folders: [],
      patterns: [],
      ignoreChatHistory: false,
      respectObsidianExclusions: false,
    },
  };
  manager.plugin = { settings: {} };
  manager.app = { vault: { getAbstractFileByPath: jest.fn(() => source) } };
  manager.storage = {
    getVectorSync: jest.fn((id: string) => id === sourceVector.id ? sourceVector : null),
    getVectorsByPath: jest.fn().mockResolvedValue([sourceVector]),
    getVectorsByNamespace: jest.fn().mockResolvedValue([
      vector("Source.md"),
      vector("Candidate.md"),
    ]),
  };
  manager.search = { findSimilarAsync: jest.fn().mockResolvedValue([]) };
  manager.getFileIndexSnapshot = jest.fn(() => ({ ready: true }));
  return manager;
}

describe("EmbeddingsManager indexed search cancellation", () => {
  it("stops before loading the candidate index when cancellation arrives", async () => {
    const manager = managerHarness();
    let release!: (vectors: EmbeddingVector[]) => void;
    manager.storage.getVectorsByPath.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();

    const result = manager.findSimilar("Source.md", 15, controller.signal);
    controller.abort();
    release([vector("Source.md")]);

    await expect(result).resolves.toEqual([]);
    expect(manager.storage.getVectorsByNamespace).not.toHaveBeenCalled();
    expect(manager.search.findSimilarAsync).not.toHaveBeenCalled();
  });

  it("passes the signal into each non-blocking vector scan", async () => {
    const manager = managerHarness();
    const controller = new AbortController();

    await manager.findSimilar("Source.md", 15, controller.signal);

    expect(manager.search.findSimilarAsync).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.any(Array),
      60,
      { signal: controller.signal },
    );
  });
});
