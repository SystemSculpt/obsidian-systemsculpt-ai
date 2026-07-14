import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import type { EmbeddingVector } from "../types";
import { buildManagedNamespace, parseNamespaceDimension } from "../utils/namespace";
import { buildVectorId } from "../utils/vectorId";

function root(namespace: string, file: TFile, options: { complete?: boolean } = {}): EmbeddingVector {
  const dimension = parseNamespaceDimension(namespace) ?? 1;
  return {
    id: buildVectorId(namespace, file.path, 0),
    path: file.path,
    chunkId: 0,
    vector: new Float32Array(dimension),
    metadata: {
      title: file.basename,
      mtime: file.stat.mtime,
      contentHash: `${namespace}:${file.path}`,
      generation: "semantic-v1",
      dimension,
      createdAt: 1,
      namespace,
      complete: options.complete ?? true,
      partial: options.complete === false,
      chunkCount: 1,
    },
  };
}

function restartHarness(options: {
  vectors: EmbeddingVector[];
  inferred: string | null;
  committed?: string | null;
}) {
  const files = ["A.md", "B.md"].map((path) => new TFile({
    path,
    name: path,
    extension: "md",
    stat: { mtime: 1, size: 100 },
  }));
  const vectors = new Map(options.vectors.map((vector) => [vector.id, vector]));
  const writeState = jest.fn(async () => undefined);
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  manager.searchNamespace = null;
  manager.gateway = {};
  manager.workQueue = { get: jest.fn(() => null) };
  manager.config = {
    exclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
  };
  manager.plugin = { settings: {} };
  manager.app = { vault: { getMarkdownFiles: jest.fn(() => files) } };
  manager.storage = {
    peekCurrentManagedNamespace: jest.fn(() => options.inferred),
    listManagedRootNamespaces: jest.fn(() => [
      ...new Set(options.vectors.map((vector) => vector.metadata.namespace)),
    ]),
    getVectorSync: jest.fn((id: string) => vectors.get(id) ?? null),
    readState: jest.fn(async () => options.committed
      ? { version: 1, namespace: options.committed, committedAt: 1 }
      : null),
    writeState,
  };
  return { files, manager, writeState };
}

describe("EmbeddingsManager namespace recovery", () => {
  it("revalidates corpus coverage after restart and keeps a partial replacement inactive", async () => {
    const oldNamespace = buildManagedNamespace(2);
    const newNamespace = buildManagedNamespace(3);
    const files = ["A.md", "B.md"].map((path) => new TFile({
      path,
      name: path,
      extension: "md",
      stat: { mtime: 1, size: 100 },
    }));
    const state = restartHarness({
      vectors: [
        root(oldNamespace, files[0]),
        root(oldNamespace, files[1]),
        root(newNamespace, files[0]),
      ],
      // Simulate the old heuristic preferring the interrupted replacement.
      inferred: newNamespace,
    });

    await state.manager.hydrateManagedIdentityFromStorage();

    expect(state.manager.searchNamespace).toBe(oldNamespace);
    expect(state.writeState).toHaveBeenCalledWith(
      "semantic-committed-namespace-v1",
      expect.objectContaining({ version: 1, namespace: oldNamespace }),
    );
    expect(state.manager.gateway.activeGeneration.indexNamespace).toBe(newNamespace);
  });

  it("does not promote a partially rebuilt namespace when no committed namespace exists", async () => {
    const namespace = buildManagedNamespace(3);
    const files = ["A.md", "B.md"].map((path) => new TFile({
      path,
      name: path,
      extension: "md",
      stat: { mtime: 1, size: 100 },
    }));
    const state = restartHarness({
      vectors: [root(namespace, files[0])],
      inferred: namespace,
    });

    await state.manager.hydrateManagedIdentityFromStorage();

    expect(state.manager.searchNamespace).toBeNull();
    expect(state.writeState).not.toHaveBeenCalled();
    expect(state.manager.gateway.activeGeneration.indexNamespace).toBe(namespace);
  });

  it("restores the explicit committed namespace instead of a newer partial indexing namespace", async () => {
    const committedNamespace = buildManagedNamespace(2);
    const partialNamespace = buildManagedNamespace(3);
    const files = ["A.md", "B.md"].map((path) => new TFile({
      path,
      name: path,
      extension: "md",
      stat: { mtime: 1, size: 100 },
    }));
    const state = restartHarness({
      vectors: [
        root(committedNamespace, files[0]),
        root(committedNamespace, files[1]),
        root(partialNamespace, files[0]),
      ],
      inferred: partialNamespace,
      committed: committedNamespace,
    });

    await state.manager.hydrateManagedIdentityFromStorage();

    expect(state.manager.searchNamespace).toBe(committedNamespace);
    expect(state.writeState).not.toHaveBeenCalled();
  });
});
