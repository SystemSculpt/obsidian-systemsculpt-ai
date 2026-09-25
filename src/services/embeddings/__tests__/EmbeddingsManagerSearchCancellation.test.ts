import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import { SemanticMatrix } from "../search/SemanticMatrix";
import type { EmbeddingVector } from "../types";

const namespace = "systemsculpt:managed:semantic-v1:v2:2";

function vector(path: string, values: number[] = [1, 0], chunkId = 0): EmbeddingVector {
  return {
    id: `${namespace}::${path}#${chunkId}`,
    path,
    chunkId,
    vector: new Float32Array(values),
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

function managerHarness(candidates: EmbeddingVector[] = [vector("Candidate.md", [0.8, 0.6])]) {
  const files = new Map(["Source.md", ...candidates.map((candidate) => candidate.path)].map((path) => [
    path,
    new TFile({ path, name: path, extension: "md", stat: { mtime: 1, size: 10 } }),
  ]));
  const sourceVector = vector("Source.md");
  const records = new Map([sourceVector, ...candidates].map((record) => [record.id, record]));
  const matrix = new SemanticMatrix(2);
  for (const record of [sourceVector, ...candidates]) {
    matrix.appendRows(record.path, [{ chunkId: record.chunkId ?? 0, vector: record.vector }]);
  }
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  manager.initialized = true;
  manager.searchNamespace = namespace;
  manager.similarCache = new Map();
  manager.workQueue = { get: jest.fn(() => null) };
  manager.gateway = {
    activeGeneration: {
      id: "semantic-v1",
      indexSchemaVersion: 2,
      indexNamespace: namespace,
      dimensions: 2,
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
  manager.app = { vault: { getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null) } };
  let revision = 0;
  manager.storage = {
    getVectorSync: jest.fn((id: string) => records.get(id) ?? null),
    getVectorsByPath: jest.fn().mockResolvedValue([sourceVector]),
    getSearchMatrix: jest.fn(async () => matrix),
    readRecords: jest.fn(async (ids: string[]) => ids.map((id) => records.get(id)).filter(Boolean)),
    getRevision: jest.fn(() => revision),
  };
  return { manager, matrix, bumpRevision: () => { revision += 1; } };
}

describe("EmbeddingsManager indexed search", () => {
  it("stops before loading the search matrix when cancellation arrives", async () => {
    const { manager } = managerHarness();
    let release!: (vectors: EmbeddingVector[]) => void;
    manager.storage.getVectorsByPath.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();

    const result = manager.findSimilar("Source.md", 15, controller.signal);
    controller.abort();
    release([vector("Source.md")]);

    await expect(result).resolves.toEqual([]);
    expect(manager.storage.getSearchMatrix).not.toHaveBeenCalled();
    expect(manager.storage.readRecords).not.toHaveBeenCalled();
  });

  it("passes the signal into the matrix scan and returns nothing once it aborts", async () => {
    const { manager, matrix } = managerHarness();
    const controller = new AbortController();
    const search = jest.spyOn(matrix, "search").mockImplementation(async () => {
      controller.abort();
      return [[{ path: "Candidate.md", chunkId: 0, score: 0.8 }]];
    });

    await expect(manager.findSimilar("Source.md", 15, controller.signal)).resolves.toEqual([]);

    expect(search).toHaveBeenCalledWith(expect.any(Array), 60, expect.any(Function), { signal: controller.signal });
    expect(manager.storage.readRecords).not.toHaveBeenCalled();
  });

  it("rescores matrix candidates from stored Float32 vectors and excludes the source note", async () => {
    const { manager } = managerHarness([vector("Candidate.md", [0.8, 0.6]), vector("Far.md", [0, 1])]);

    const results = await manager.findSimilar("Source.md", 15);

    expect(results.map((result: { path: string }) => result.path)).toEqual(["Candidate.md"]);
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  it("answers a repeated query for an unchanged note and index from the cache", async () => {
    const { manager, bumpRevision } = managerHarness();

    const first = await manager.findSimilar("Source.md", 15);
    const second = await manager.findSimilar("Source.md", 15);
    expect(second).toEqual(first);
    expect(manager.storage.getSearchMatrix).toHaveBeenCalledTimes(1);

    bumpRevision();
    await manager.findSimilar("Source.md", 15);
    expect(manager.storage.getSearchMatrix).toHaveBeenCalledTimes(2);
  });
});
