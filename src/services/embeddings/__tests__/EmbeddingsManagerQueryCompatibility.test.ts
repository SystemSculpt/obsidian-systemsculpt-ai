import { EmbeddingsManager } from "../EmbeddingsManager";
import {
  MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
  type ManagedEmbeddingsIndexQueryResult,
} from "../gateway/ManagedEmbeddingsIndexAdapter";
import { managedNamespace } from "./support/managedNamespace";

const committedNamespace = managedNamespace(2, "semantic-v1", 3);

function queryResult(
  generationId: string,
  schema: number,
  vector: Float32Array,
): ManagedEmbeddingsIndexQueryResult {
  return {
    contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
    generation: {
      id: generationId,
      indexSchemaVersion: schema,
      indexNamespace: managedNamespace(vector.length, generationId, schema),
      dimensions: vector.length,
    },
    vector,
  };
}

function harness(result: ManagedEmbeddingsIndexQueryResult) {
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  manager.initialized = true;
  manager.plugin = { settings: { embeddingsEnabled: false } };
  manager.searchNamespace = committedNamespace;
  manager.queryCache = new Map();
  manager.pendingQueries = new Map();
  manager.gateway = {
    activeGeneration: result.generation,
    query: jest.fn(async () => result),
  };
  manager.refreshLifecycle = jest.fn();
  manager.searchIndexedNamespace = jest.fn(async () => [[{
    path: "Candidate.md",
    score: 0.9,
    chunkId: 0,
    metadata: {
      title: "Candidate",
      excerpt: "A candidate note",
      lastModified: 1,
    },
  }]]);
  return manager;
}

describe("EmbeddingsManager query generation compatibility", () => {
  it("queries a committed prior schema when generation id and dimensions match", async () => {
    const manager = harness(queryResult("semantic-v1", 4, new Float32Array([1, 0])));

    await expect(manager.searchSimilar("candidate", 5)).resolves.toHaveLength(1);
    expect(manager.searchIndexedNamespace).toHaveBeenCalledWith(
      committedNamespace,
      [expect.any(Float32Array)],
      20,
      undefined,
    );
  });

  it("reuses a same-generation query vector without another managed request", async () => {
    const manager = harness(queryResult("semantic-v1", 4, new Float32Array([1, 0])));

    await expect(manager.searchSimilar("candidate", 5)).resolves.toHaveLength(1);
    await expect(manager.searchSimilar("candidate", 5)).resolves.toHaveLength(1);

    expect(manager.gateway.query).toHaveBeenCalledTimes(1);
    expect(manager.searchIndexedNamespace).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a different generation id", queryResult("semantic-v2", 4, new Float32Array([1, 0]))],
    ["different dimensions", queryResult("semantic-v1", 4, new Float32Array([1, 0, 0]))],
  ])("does not query across %s", async (_label, result) => {
    const manager = harness(result);

    await expect(manager.searchSimilar("candidate", 5)).resolves.toEqual([]);
    expect(manager.searchIndexedNamespace).not.toHaveBeenCalled();
  });

  it("does not reuse a cached query after the published generation changes", async () => {
    const original = queryResult("semantic-v1", 4, new Float32Array([1, 0]));
    const replacement = queryResult("semantic-v2", 4, new Float32Array([1, 0]));
    const manager = harness(original);
    manager.gateway.query.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);

    await expect(manager.searchSimilar("candidate", 5)).resolves.toHaveLength(1);
    manager.gateway.metadata = {
      generation: {
        id: replacement.generation.id,
        indexSchemaVersion: replacement.generation.indexSchemaVersion,
        indexNamespaceTemplate: "systemsculpt:managed:semantic-v2:v4:<dimensions>",
      },
    };

    await expect(manager.searchSimilar("candidate", 5)).resolves.toEqual([]);
    expect(manager.gateway.query).toHaveBeenCalledTimes(2);
    expect(manager.searchIndexedNamespace).toHaveBeenCalledTimes(1);
  });

  it("shares one managed request between identical searches while it runs", async () => {
    const result = queryResult("semantic-v1", 4, new Float32Array([1, 0]));
    const manager = harness(result);
    let answer!: (value: ManagedEmbeddingsIndexQueryResult) => void;
    manager.gateway.query.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));

    const first = manager.searchSimilar("older passengers", 5);
    const second = manager.searchSimilar("older passengers", 5);
    await Promise.resolve();
    answer(result);

    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(manager.gateway.query).toHaveBeenCalledTimes(1);
  });

  it("keeps the vector of a search cancelled while its request ran", async () => {
    const result = queryResult("semantic-v1", 4, new Float32Array([1, 0]));
    const manager = harness(result);
    let answer!: (value: ManagedEmbeddingsIndexQueryResult) => void;
    manager.gateway.query.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const controller = new AbortController();

    const cancelled = manager.searchSimilar("older passengers", 5, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).resolves.toEqual([]);
    expect(manager.searchIndexedNamespace).not.toHaveBeenCalled();

    answer(result);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(manager.searchSimilar("older passengers", 5)).resolves.toHaveLength(1);
    expect(manager.gateway.query).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed request, even when nobody was still waiting for it", async () => {
    const result = queryResult("semantic-v1", 4, new Float32Array([1, 0]));
    const manager = harness(result);
    let fail!: (error: Error) => void;
    manager.gateway.query.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const controller = new AbortController();

    const cancelled = manager.searchSimilar("older passengers", 5, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).resolves.toEqual([]);
    fail(new Error("temporarily unavailable"));
    await new Promise((resolve) => setImmediate(resolve));

    await expect(manager.searchSimilar("older passengers", 5)).resolves.toHaveLength(1);
    expect(manager.gateway.query).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached query after the active dimensions change", async () => {
    const original = queryResult("semantic-v1", 4, new Float32Array([1, 0]));
    const replacement = queryResult("semantic-v1", 4, new Float32Array([1, 0, 0]));
    const manager = harness(original);
    manager.gateway.query.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);

    await expect(manager.searchSimilar("candidate", 5)).resolves.toHaveLength(1);
    manager.gateway.activeGeneration = replacement.generation;

    await expect(manager.searchSimilar("candidate", 5)).resolves.toEqual([]);
    expect(manager.gateway.query).toHaveBeenCalledTimes(2);
    expect(manager.searchIndexedNamespace).toHaveBeenCalledTimes(1);
  });
});
