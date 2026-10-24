import { EmbeddingsManager } from "../EmbeddingsManager";
import { EmbeddingsStorage, EmbeddingsStorageBlockedError } from "../storage/EmbeddingsStorage";
import { installFakeIndexedDb } from "./support/fakeIndexedDb";

const VAULT_ID = "connection-lifecycle";
const DB_NAME = EmbeddingsStorage.buildDbName(VAULT_ID);

function managerFor(): EmbeddingsManager {
  const settings = {
    vaultInstanceId: VAULT_ID,
    embeddingsVectorFormatVersion: 8,
    embeddingsEnabled: false,
    embeddingsPortableIndex: false,
    embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
    chatsDirectory: "Chats",
    savedChatsDirectory: "Saved Chats",
  };
  const vault = {
    adapter: null,
    getMarkdownFiles: jest.fn(() => []),
    getAbstractFileByPath: jest.fn(() => null),
    read: jest.fn(async () => ""),
    on: jest.fn(() => ({})),
    offref: jest.fn(),
  };
  const plugin = {
    settings,
    getManagedCapabilityGraph: jest.fn(() => ({
      embeddingsIndex: { activeGeneration: undefined, metadata: undefined, getMetadata: jest.fn(), index: jest.fn() },
    })),
    getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn(async () => undefined) })),
  };
  return new EmbeddingsManager({ vault } as never, plugin as never);
}

function openDatabase(version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onblocked = () => reject(new Error("blocked"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("EmbeddingsManager IndexedDB connection", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  it("closes its connection on cleanup so the next build can upgrade the database", async () => {
    const manager = managerFor();
    await manager.initialize();
    expect(manager.getLifecycleSnapshot()).toMatchObject({ ready: true, lastError: null });
    expect(fake.factory.openConnections(DB_NAME).size).toBe(1);

    await manager.cleanup();

    expect(fake.factory.openConnections(DB_NAME).size).toBe(0);
    const next = await openDatabase(12);
    expect(next.version).toBe(12);
    next.close();
  });

  it("reports a blocked open as a lifecycle error instead of initializing forever", async () => {
    // An older build that never closes holds a lower version open.
    const blocker = await openDatabase(10, (db) => db.createObjectStore("embeddings", { keyPath: "id" }));
    const manager = managerFor();

    await expect(manager.initialize()).rejects.toBeInstanceOf(EmbeddingsStorageBlockedError);
    expect(manager.getLifecycleSnapshot()).toMatchObject({
      phase: "error",
      ready: false,
      lastError: {
        code: "storage_blocked",
        message: "Restart Obsidian to finish updating the semantic index.",
      },
    });
    expect(manager.isReady()).toBe(false);
    await expect(manager.awaitReady()).rejects.toBeInstanceOf(EmbeddingsStorageBlockedError);

    // Once the older connection goes away, the next caller finishes initializing.
    blocker.close();
    await manager.awaitReady();
    expect(manager.getLifecycleSnapshot()).toMatchObject({ ready: true, lastError: null });
    expect(fake.factory.databases.get(DB_NAME)?.version).toBe(11);
    expect(fake.factory.openConnections(DB_NAME).size).toBe(1);

    await manager.cleanup();
    expect(fake.factory.openConnections(DB_NAME).size).toBe(0);
  });
});
