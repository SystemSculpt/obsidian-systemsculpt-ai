const managedVector = {
  id: "managed",
  path: "Managed.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: { namespace: "systemsculpt:managed:semantic-v1:v2:2", generation: "semantic-v1" },
};
const legacyVector = {
  id: "legacy",
  path: "Legacy.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: { namespace: "custom:old:v2:2" },
};
const priorGenerationVector = {
  id: "prior-generation",
  path: "Prior.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: { namespace: "systemsculpt:managed:v1:2" },
};
const localEmptyVector = {
  id: "local-empty",
  path: "Empty.md",
  chunkId: 0,
  vector: new Float32Array([0]),
  metadata: { namespace: "systemsculpt:local-empty:v1:1", isEmpty: true },
};
const storage = {
  initialize: jest.fn(async () => undefined),
  loadEmbeddings: jest.fn(async () => undefined),
  getAllVectors: jest.fn(async () => [managedVector, priorGenerationVector, legacyVector, localEmptyVector]),
  removeIds: jest.fn(async () => undefined),
  peekCurrentManagedNamespace: jest.fn(() => "systemsculpt:managed:semantic-v1:v2:2"),
  purgeCorruptedVectors: jest.fn(async () => ({ removedCount: 0, correctedCount: 0, removedPaths: [], correctedPaths: [] })),
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
    setConfig: jest.fn(),
  })),
}));

jest.mock("../embeddings/storage/EmbeddingsPortableIndex", () => ({
  restoreEmbeddingsIndexIfEmpty: jest.fn(async () => ({ restored: false, imported: 0 })),
  writeEmbeddingsIndexSnapshot: jest.fn(async () => ({ written: false, count: 0 })),
}));

import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";

describe("EmbeddingsManager managed namespace migration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("removes obsolete namespaces, retains current managed vectors, and hydrates the validated dimension", async () => {
    const updateSettings = jest.fn(async () => undefined);
    const plugin = {
      settings: {
        vaultInstanceId: "vault",
        embeddingsVectorFormatVersion: 4,
        embeddingsEnabled: false,
        embeddingsPortableIndex: false,
        embeddingsRebuildPending: false,
        embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
        chatsDirectory: "Chats",
        savedChatsDirectory: "Saved Chats",
      },
      emitter: { emit: jest.fn() },
      getManagedCapabilityClient: jest.fn(() => ({ request: jest.fn() })),
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

    const manager = new EmbeddingsManager(app as never, plugin as never);
    await manager.initialize();

    expect(storage.removeIds).toHaveBeenCalledWith(["prior-generation", "legacy"]);
    expect(updateSettings).toHaveBeenCalledWith({ embeddingsVectorFormatVersion: 7 });
    expect((manager as unknown as { gateway: { expectedDimension?: number; activeGeneration?: unknown } }).gateway)
      .toMatchObject({
        expectedDimension: 2,
        activeGeneration: {
          id: "semantic-v1",
          indexNamespace: "systemsculpt:managed:semantic-v1:v2:2",
          dimensions: 2,
        },
      });
  });

  it("does not scan every stored chunk again after the migration version is current", async () => {
    const plugin = {
      settings: {
        vaultInstanceId: "vault",
        embeddingsVectorFormatVersion: 7,
        embeddingsEnabled: false,
        embeddingsPortableIndex: false,
        embeddingsRebuildPending: false,
        embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
        chatsDirectory: "Chats",
        savedChatsDirectory: "Saved Chats",
      },
      emitter: { emit: jest.fn() },
      getManagedCapabilityClient: jest.fn(() => ({ request: jest.fn() })),
      getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn() })),
    };
    const app = {
      vault: {
        adapter: null,
        getMarkdownFiles: jest.fn(() => []),
        on: jest.fn(() => ({})),
        offref: jest.fn(),
      },
    };

    const manager = new EmbeddingsManager(app as never, plugin as never);
    await manager.initialize();

    expect(storage.getAllVectors).not.toHaveBeenCalled();
  });
});
