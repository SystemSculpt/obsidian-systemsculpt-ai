const managedVector = {
  id: "managed",
  path: "Managed.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: { namespace: "systemsculpt:managed:v1:2" },
};
const legacyVector = {
  id: "legacy",
  path: "Legacy.md",
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  metadata: { namespace: "custom:old:v2:2" },
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
  getAllVectors: jest.fn(async () => [managedVector, legacyVector, localEmptyVector]),
  removeIds: jest.fn(async () => undefined),
  peekBestNamespaceForPrefix: jest.fn(() => "systemsculpt:managed:v1:2"),
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
  it("removes legacy provider namespaces, retains managed vectors, and hydrates the validated dimension", async () => {
    const updateSettings = jest.fn(async () => undefined);
    const plugin = {
      settings: {
        vaultInstanceId: "vault",
        embeddingsVectorFormatVersion: 4,
        embeddingsEnabled: false,
        embeddingsAutoProcess: false,
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

    expect(storage.removeIds).toHaveBeenCalledWith(["legacy"]);
    expect(updateSettings).toHaveBeenCalledWith({ embeddingsVectorFormatVersion: 6 });
    expect((manager as unknown as { provider: { expectedDimension?: number; activeNamespace?: string } }).provider)
      .toMatchObject({ expectedDimension: 2, activeNamespace: "systemsculpt:managed:v1:2" });
  });
});
