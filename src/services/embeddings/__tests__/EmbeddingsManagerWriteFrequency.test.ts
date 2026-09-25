import { Mutex } from "async-mutex";
import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import { SemanticIndexLifecycle } from "../SemanticIndexLifecycle";
import { SemanticWorkQueue } from "../SemanticWorkQueue";
import type { EmbeddingVector, ProcessingResult } from "../types";
import { buildManagedNamespace } from "../utils/namespace";
import { buildVectorId } from "../utils/vectorId";

const namespace = buildManagedNamespace(2);

function root(file: TFile): EmbeddingVector {
  return {
    id: buildVectorId(namespace, file.path, 0),
    path: file.path,
    chunkId: 0,
    vector: new Float32Array([1, 0]),
    metadata: {
      title: file.basename,
      mtime: file.stat.mtime,
      contentHash: file.path,
      generation: "semantic-v1",
      dimension: 2,
      createdAt: 1,
      namespace,
      complete: true,
      chunkCount: 1,
    },
  };
}

function harness(paths: Array<{ path: string; size?: number }>) {
  const files = paths.map(({ path, size }) => new TFile({
    path,
    name: path.split("/").pop(),
    extension: path.split(".").pop(),
    stat: { mtime: 1, size: size ?? 100 },
  }));
  const roots = new Map<string, EmbeddingVector>();
  const state = new Map<string, unknown>();
  const watchers = new Map<string, (...args: any[]) => void>();
  const settings: Record<string, any> = {
    embeddingsEnabled: true,
    embeddingsPortableIndex: false,
    embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
    chatsDirectory: "Chats",
    savedChatsDirectory: "Saved Chats",
  };
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  Object.assign(manager, {
    initialized: true,
    searchNamespace: namespace,
    processingSuspended: false,
    processingMutex: new Mutex(),
    failedFiles: new Map(),
    queryCache: new Map(),
    similarCache: new Map(),
    fileWatchers: [],
    lifecycle: new SemanticIndexLifecycle(),
    lifecycleRefreshTimer: null,
    workQueue: new SemanticWorkQueue({
      readState: async <T>(key: string) => (state.get(key) as T | undefined) ?? null,
      writeState: async <T>(key: string, value: T) => { state.set(key, value); },
      deleteState: async (key: string) => { state.delete(key); },
    }, 0),
    config: { exclusions: { ...settings.embeddingsExclusions } },
    enabledAtLastSync: true,
    gateway: {
      getMetadata: jest.fn(async () => undefined),
      activeGeneration: { id: "semantic-v1", indexSchemaVersion: 3, indexNamespace: namespace, dimensions: 2 },
    },
    storage: {
      getVectorSync: jest.fn((id: string) => roots.get(id) ?? null),
      getDistinctPaths: jest.fn(() => [...new Set([...roots.values()].map((vector) => vector.path))]),
      removeByPath: jest.fn(async (path: string) => {
        let removed = 0;
        for (const [id, vector] of roots) if (vector.path === path) { roots.delete(id); removed += 1; }
        return removed;
      }),
      removeByDirectory: jest.fn(async () => 0),
      renameByPath: jest.fn(async () => 0),
      writeState: jest.fn(async () => undefined),
      deleteState: jest.fn(async () => undefined),
    },
    app: {
      vault: {
        adapter: null,
        getMarkdownFiles: () => files.filter((file) => file.extension === "md"),
        getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
        on: jest.fn((event: string, callback: (...args: any[]) => void) => {
          watchers.set(event, callback);
          return {};
        }),
      },
    },
    plugin: { settings, emitter: { emit: jest.fn() } },
    markPortableIndexChanged: jest.fn(),
    markPortableIndexDestructive: jest.fn(),
    processor: { processFiles: jest.fn(), cancel: jest.fn() },
  });
  manager.setupFileWatchers();
  return { files, roots, manager, settings, watchers };
}

describe("EmbeddingsManager portable index write frequency (#341)", () => {
  it("starts a vault pass only when enabling or the exclusion rules change", () => {
    const { manager, settings } = harness([{ path: "A.md" }]);
    const request = jest.spyOn(manager, "requestAutomaticProcessing").mockImplementation(() => undefined);

    settings.licenseValid = true;
    settings.lastAutomaticBackup = Date.now();
    manager.syncFromSettings();
    expect(request).not.toHaveBeenCalled();

    settings.embeddingsExclusions = { ...settings.embeddingsExclusions, folders: ["Private"] };
    jest.spyOn(manager, "cleanupExcludedEmbeddings").mockResolvedValue(undefined);
    manager.syncFromSettings();
    expect(request).toHaveBeenCalledTimes(1);

    settings.embeddingsEnabled = false;
    manager.syncFromSettings();
    settings.embeddingsEnabled = true;
    manager.syncFromSettings();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not count empty notes that are already absent as a destructive change", async () => {
    const { files, roots, manager } = harness([{ path: "A.md" }, { path: "Untitled.md", size: 0 }]);
    roots.set(root(files[0]).id, root(files[0]));

    await expect(manager.processVault()).resolves.toMatchObject({ status: "complete", processed: 0 });

    expect(manager.storage.removeByPath).toHaveBeenCalledWith("Untitled.md");
    expect(manager.markPortableIndexDestructive).not.toHaveBeenCalled();
    expect(manager.markPortableIndexChanged).not.toHaveBeenCalled();
  });

  it("marks the snapshot only when a deleted file actually had records", async () => {
    const { files, roots, manager, watchers } = harness([{ path: "A.md" }, { path: "image.png" }]);
    roots.set(root(files[0]).id, root(files[0]));

    watchers.get("delete")?.(files[1]);
    await manager.processingMutex.waitForUnlock();
    await Promise.resolve();
    expect(manager.markPortableIndexDestructive).not.toHaveBeenCalled();

    watchers.get("delete")?.(files[0]);
    await manager.processingMutex.waitForUnlock();
    for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
    expect(manager.markPortableIndexDestructive).toHaveBeenCalledTimes(1);
  });

  it("re-queues a note edited during its request instead of reporting a failure", async () => {
    const { manager } = harness([{ path: "A.md" }]);
    await manager.workQueue.enqueueImmediate("A.md", "modify", 1, 1);
    manager.processor.processFiles.mockImplementation(async (): Promise<ProcessingResult> => ({
      completed: 0,
      completedPaths: [],
      failed: 1,
      failedPaths: ["A.md"],
      failedDetails: { "A.md": { code: "source_changed", message: "Changed.", status: 0 } },
      cancelled: false,
      fatalError: null,
    }));
    manager.clearWorkTimer = jest.fn();
    manager.scheduleQueuedWork = jest.fn();

    await manager.processQueuedWork();

    expect(manager.failedFiles.size).toBe(0);
    expect(manager.workQueue.get("A.md")).toMatchObject({ failure: null, reason: "modify" });
    expect(manager.getLifecycleSnapshot()).toMatchObject({ phase: "idle", lastError: null });
    expect(manager.markPortableIndexDestructive).not.toHaveBeenCalled();
  });
});
