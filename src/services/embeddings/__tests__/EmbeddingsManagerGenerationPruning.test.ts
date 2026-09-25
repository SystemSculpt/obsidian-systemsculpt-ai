import { Mutex } from "async-mutex";
import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import { EmbeddingsStorage } from "../storage/EmbeddingsStorage";
import { SemanticIndexLifecycle } from "../SemanticIndexLifecycle";
import { SemanticWorkQueue } from "../SemanticWorkQueue";
import type { EmbeddingVector, ProcessingResult } from "../types";
import { buildVectorId } from "../utils/vectorId";
import { installFakeIndexedDb } from "./support/fakeIndexedDb";

const LEGACY = "systemsculpt:openrouter/openai/text-embedding-3-small:v2:2";
const V2 = "systemsculpt:managed:semantic-v1:v2:2";
const COMMITTED = "systemsculpt:managed:semantic-v1:v3:2";
const IN_PROGRESS = "systemsculpt:managed:semantic-v1:v4:2";

function record(namespace: string, path: string, createdAt: number, chunkId = 0): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, chunkId),
    path,
    chunkId,
    vector: new Float32Array([1, 0]),
    metadata: {
      title: path,
      mtime: 1,
      contentHash: `${path}:${chunkId}`,
      generation: "semantic-v1",
      dimension: 2,
      createdAt,
      namespace,
      ...(chunkId === 0 ? { complete: true, chunkCount: 1 } : {}),
    },
  };
}

function pluginStub(files: TFile[]) {
  const settings = {
    vaultInstanceId: "generation-pruning",
    embeddingsVectorFormatVersion: 8,
    embeddingsEnabled: false,
    embeddingsPortableIndex: false,
    embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
    chatsDirectory: "Chats",
    savedChatsDirectory: "Saved Chats",
  };
  const vault = {
    adapter: null,
    getMarkdownFiles: jest.fn(() => files),
    getAbstractFileByPath: jest.fn((path: string) => files.find((file) => file.path === path) ?? null),
    read: jest.fn(async () => "content"),
    on: jest.fn(() => ({})),
    offref: jest.fn(),
  };
  const plugin = {
    settings,
    emitter: { emit: jest.fn() },
    getManagedCapabilityGraph: jest.fn(() => ({
      embeddingsIndex: { activeGeneration: undefined, metadata: undefined, getMetadata: jest.fn(), index: jest.fn() },
    })),
    getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn(async () => undefined) })),
  };
  return { app: { vault }, plugin };
}

describe("EmbeddingsManager superseded generation pruning (#324)", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  it("compacts a store holding every generation on load", async () => {
    const files = ["A.md", "B.md"].map((path) => new TFile({
      path,
      name: path,
      extension: "md",
      stat: { mtime: 1, size: 100 },
    }));
    const seed = new EmbeddingsStorage(EmbeddingsStorage.buildDbName("generation-pruning"));
    await seed.initialize();
    await seed.storeVectors([
      record(LEGACY, "A.md", 1), record(LEGACY, "B.md", 1),
      record(V2, "A.md", 2), record(V2, "B.md", 2), record(V2, "B.md", 2, 1),
      record(COMMITTED, "A.md", 3), record(COMMITTED, "B.md", 3),
      record(IN_PROGRESS, "A.md", 4),
    ]);
    await seed.writeState("semantic-committed-namespace-v1", {
      version: 1,
      namespace: COMMITTED,
      committedAt: 3,
    });
    const { app, plugin } = pluginStub(files);
    const manager = new EmbeddingsManager(app as never, plugin as never);

    await manager.initialize();

    const storage = (manager as unknown as { storage: EmbeddingsStorage }).storage;
    expect((await storage.listStoredNamespaces()).sort()).toEqual([COMMITTED, IN_PROGRESS]);
    expect(manager.getFileIndexSnapshot("A.md")).toMatchObject({ ready: true });
    await manager.cleanup();
  });

  it("prunes superseded generations after a run in which one note failed", async () => {
    const files = ["A.md", "B.md"].map((path) => new TFile({
      path,
      name: path,
      extension: "md",
      stat: { mtime: 1, size: 100 },
    }));
    const roots = new Map<string, EmbeddingVector>([
      [buildVectorId(COMMITTED, "A.md", 0), record(COMMITTED, "A.md", 3)],
      [buildVectorId(COMMITTED, "B.md", 0), record(COMMITTED, "B.md", 3)],
      [buildVectorId(V2, "B.md", 0), record(V2, "B.md", 2)],
    ]);
    const state = new Map<string, unknown>();
    const manager = Object.create(EmbeddingsManager.prototype) as any;
    Object.assign(manager, {
      initialized: true,
      searchNamespace: COMMITTED,
      processingSuspended: false,
      processingMutex: new Mutex(),
      failedFiles: new Map(),
      queryCache: new Map(),
      lifecycle: new SemanticIndexLifecycle(),
      workQueue: new SemanticWorkQueue({
        readState: async <T>(key: string) => (state.get(key) as T | undefined) ?? null,
        writeState: async <T>(key: string, value: T) => { state.set(key, value); },
        deleteState: async (key: string) => { state.delete(key); },
      }, 0),
      config: { exclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false } },
      gateway: {
        getMetadata: jest.fn(async () => undefined),
        metadata: {
          generation: { id: "semantic-v1", indexSchemaVersion: 4, indexNamespaceTemplate: "" },
        },
        activeGeneration: { id: "semantic-v1", indexSchemaVersion: 4, indexNamespace: IN_PROGRESS, dimensions: 2 },
      },
      storage: {
        getVectorSync: jest.fn((id: string) => roots.get(id) ?? null),
        removeByPath: jest.fn(async () => 0),
        listRootNamespaces: jest.fn(() => [...new Set([...roots.values()].map((root) => root.metadata.namespace))]),
        retainNamespaces: jest.fn(async () => 1),
        writeState: jest.fn(async () => undefined),
        deleteState: jest.fn(async () => undefined),
      },
      app: { vault: { adapter: null, getMarkdownFiles: () => files, getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null } },
      plugin: {
        settings: { embeddingsEnabled: true, embeddingsPortableIndex: false, embeddingsExclusions: {} },
        emitter: { emit: jest.fn() },
        getSettingsManager: () => ({ updateSettings: jest.fn(async () => undefined) }),
      },
      markPortableIndexChanged: jest.fn(),
      flushPortableIndex: jest.fn(async () => undefined),
      commitPortableDestructiveMutation: jest.fn(async () => undefined),
      processor: {
        processFiles: jest.fn(async (): Promise<ProcessingResult> => {
          roots.set(buildVectorId(IN_PROGRESS, "A.md", 0), record(IN_PROGRESS, "A.md", 4));
          return {
            completed: 1,
            completedPaths: ["A.md"],
            failed: 1,
            failedPaths: ["B.md"],
            failedDetails: { "B.md": { code: "invalid_request", message: "Too large.", status: 413 } },
            cancelled: false,
            fatalError: null,
          };
        }),
      },
    });

    await manager.processVault();

    expect(manager.storage.retainNamespaces).toHaveBeenCalledWith(new Set([COMMITTED, IN_PROGRESS]));
    expect(manager.commitPortableDestructiveMutation).toHaveBeenCalled();
    expect(manager.getSearchNamespace()).toBe(COMMITTED);
  });

  it("keeps a published in-progress generation even before this run writes to it", async () => {
    const manager = Object.create(EmbeddingsManager.prototype) as any;
    Object.assign(manager, {
      searchNamespace: COMMITTED,
      gateway: {
        metadata: { generation: { id: "semantic-v1", indexSchemaVersion: 4, indexNamespaceTemplate: "" } },
        // Hydrated from the most complete stored generation, which is stale.
        activeGeneration: { id: "semantic-v1", indexSchemaVersion: 3, indexNamespace: COMMITTED, dimensions: 2 },
      },
      storage: {
        peekCurrentManagedNamespace: () => COMMITTED,
        listManagedRootNamespaces: () => [V2, COMMITTED, IN_PROGRESS],
        listRootNamespaces: () => [V2, COMMITTED, IN_PROGRESS],
        retainNamespaces: jest.fn(async () => 1),
      },
    });

    await manager.pruneSupersededNamespaces();

    expect(manager.storage.retainNamespaces).toHaveBeenCalledWith(new Set([COMMITTED, IN_PROGRESS]));
  });
});
