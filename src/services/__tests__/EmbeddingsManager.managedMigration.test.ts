const obsoleteV2Vector = {
  id: "obsolete-v2",
  path: "Obsolete.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: {
    namespace: "systemsculpt:managed:semantic-v1:v2:2",
    generation: "semantic-v1",
    dimension: 2,
  },
};
const currentV3Vector = {
  id: "current-v3",
  path: "Current.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: {
    namespace: "systemsculpt:managed:semantic-v1:v3:2",
    generation: "semantic-v1",
    dimension: 2,
  },
};
const futureDynamicVector = {
  id: "future-dynamic",
  path: "Future.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: {
    namespace: "systemsculpt:managed:semantic-v2.1:v17:2",
    generation: "semantic-v2.1",
    dimension: 2,
  },
};
const invalidGenerationVector = {
  id: "invalid-generation",
  path: "Invalid-generation.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: {
    namespace: "systemsculpt:managed:semantic-v2:v9:2",
    generation: "semantic-v1",
    dimension: 2,
  },
};
const invalidDimensionVector = {
  id: "invalid-dimension",
  path: "Invalid-dimension.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: {
    namespace: "systemsculpt:managed:semantic-v1:v3:3",
    generation: "semantic-v1",
    dimension: 2,
  },
};
const legacyVector = {
  id: "legacy",
  path: "Legacy.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: { namespace: "custom:old:v2:2", dimension: 2 },
};
const localEmptyVector = {
  id: "local-empty",
  path: "Empty.md",
  chunkId: 0,
  vector: new Float32Array([0]),
  metadata: {
    namespace: "systemsculpt:local-empty:v1:1",
    isEmpty: true,
    dimension: 1,
  },
};

let committedNamespaceState: { version: 1; namespace: string; committedAt: number } | null = null;
const storage = {
  initialize: jest.fn(async () => undefined),
  loadEmbeddings: jest.fn(async () => undefined),
  getAllVectors: jest.fn(async () => [
    obsoleteV2Vector,
    currentV3Vector,
    futureDynamicVector,
    invalidGenerationVector,
    invalidDimensionVector,
    legacyVector,
    localEmptyVector,
  ]),
  removeIds: jest.fn(async () => undefined),
  peekCurrentManagedNamespace: jest.fn(() => "systemsculpt:managed:semantic-v1:v3:2"),
  listManagedRootNamespaces: jest.fn(() => [
    "systemsculpt:managed:semantic-v1:v3:2",
    "systemsculpt:managed:semantic-v2.1:v17:2",
  ]),
  readState: jest.fn(async () => committedNamespaceState),
  writeState: jest.fn(async () => undefined),
  deleteState: jest.fn(async () => {
    committedNamespaceState = null;
  }),
  purgeCorruptedVectors: jest.fn(async () => ({
    removedCount: 0,
    correctedCount: 0,
    removedPaths: [],
    correctedPaths: [],
  })),
};

jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const EmbeddingsStorage = jest.fn(() => storage);
  (EmbeddingsStorage as jest.Mock & { buildDbName: jest.Mock }).buildDbName = jest.fn(() => "managed-test");
  return { EmbeddingsStorage };
});

jest.mock("../embeddings/processing/EmbeddingsProcessor", () => ({
  EmbeddingsProcessor: jest.fn(() => ({
    cancel: jest.fn(),
    cleanup: jest.fn(),
    processFiles: jest.fn(),
  })),
}));

jest.mock("../embeddings/storage/EmbeddingsPortableIndex", () => ({
  restoreEmbeddingsIndexIfEmpty: jest.fn(async () => ({ restored: false, imported: 0 })),
  writeEmbeddingsIndexSnapshot: jest.fn(async () => ({ written: false, count: 0 })),
}));

import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";

function createHarness(vectorFormatVersion: number) {
  const indexAdapter = {
    activeGeneration: undefined as unknown,
    metadata: undefined as unknown,
  };
  const updateSettings = jest.fn(async () => undefined);
  const plugin = {
    settings: {
      vaultInstanceId: "vault",
      embeddingsVectorFormatVersion: vectorFormatVersion,
      embeddingsEnabled: false,
      embeddingsPortableIndex: false,
      embeddingsRebuildPending: false,
      embeddingsExclusions: {
        folders: [],
        patterns: [],
        ignoreChatHistory: false,
        respectObsidianExclusions: false,
      },
      chatsDirectory: "Chats",
      savedChatsDirectory: "Saved Chats",
    },
    emitter: { emit: jest.fn() },
    getManagedCapabilityClient: jest.fn(() => ({
      getEmbeddingsIndex: () => indexAdapter,
    })),
    getSettingsManager: jest.fn(() => ({ updateSettings })),
  };
  const app = {
    vault: {
      adapter: null,
      getMarkdownFiles: jest.fn(() => []),
      on: jest.fn(() => ({})),
      offref: jest.fn(),
    },
  };
  return {
    indexAdapter,
    manager: new EmbeddingsManager(app as never, plugin as never),
    updateSettings,
  };
}

describe("EmbeddingsManager managed namespace migration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    committedNamespaceState = {
      version: 1,
      namespace: "systemsculpt:managed:semantic-v1:v2:2",
      committedAt: 1,
    };
  });

  it("purges v2 and invalid vectors while retaining safe dynamic namespaces", async () => {
    const state = createHarness(7);

    await state.manager.initialize();

    expect(storage.removeIds).toHaveBeenCalledWith([
      "obsolete-v2",
      "invalid-generation",
      "invalid-dimension",
      "legacy",
    ]);
    const removed = new Set(storage.removeIds.mock.calls[0]?.[0] as string[]);
    expect(removed).not.toContain("current-v3");
    expect(removed).not.toContain("future-dynamic");
    expect(removed).not.toContain("local-empty");
    expect(storage.deleteState).toHaveBeenCalledWith("semantic-committed-namespace-v1");
    expect(state.updateSettings).toHaveBeenCalledWith({ embeddingsVectorFormatVersion: 8 });
    expect(state.indexAdapter.activeGeneration).toEqual({
      id: "semantic-v1",
      indexSchemaVersion: 3,
      indexNamespace: "systemsculpt:managed:semantic-v1:v3:2",
      dimensions: 2,
    });
  });

  it("does not scan every stored chunk again after migration version 8", async () => {
    const state = createHarness(8);

    await state.manager.initialize();

    expect(storage.getAllVectors).not.toHaveBeenCalled();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("removes a stale committed v2 identity even when no v2 vectors remain", async () => {
    storage.getAllVectors.mockResolvedValueOnce([currentV3Vector]);
    const state = createHarness(7);

    await state.manager.initialize();

    expect(storage.removeIds).not.toHaveBeenCalled();
    expect(storage.deleteState).toHaveBeenCalledWith("semantic-committed-namespace-v1");
    expect(state.updateSettings).toHaveBeenCalledWith({ embeddingsVectorFormatVersion: 8 });
  });
});
