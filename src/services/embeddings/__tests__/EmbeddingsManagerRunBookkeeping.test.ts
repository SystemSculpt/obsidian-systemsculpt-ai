import { Mutex } from "async-mutex";
import { TFile } from "obsidian";
import { EmbeddingsManager } from "../EmbeddingsManager";
import { ManagedEmbeddingsError } from "../gateway/ManagedEmbeddingsAdapter";
import { createLocalEmptyEmbeddingMarker } from "../LocalEmptyEmbeddingMarker";
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
      contentHash: `${file.path}:${file.stat.mtime}`,
      generation: "semantic-v1",
      dimension: 2,
      createdAt: file.stat.mtime,
      namespace,
      complete: true,
      chunkCount: 1,
    },
  };
}

async function harness(fileCount: number) {
  const files = Array.from({ length: fileCount }, (_, index) => new TFile({
    path: `Note-${index}.md`,
    name: `Note-${index}.md`,
    extension: "md",
    stat: { mtime: 1, size: 100 },
  }));
  const roots = new Map<string, EmbeddingVector>();
  const state = new Map<string, unknown>();
  const queue = new SemanticWorkQueue({
    readState: async <T>(key: string) => (state.get(key) as T | undefined) ?? null,
    writeState: async <T>(key: string, value: T) => { state.set(key, value); },
    deleteState: async (key: string) => { state.delete(key); },
  }, 0);
  const settings = {
    embeddingsEnabled: true,
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
  };
  const manager = Object.create(EmbeddingsManager.prototype) as any;
  manager.initialized = true;
  manager.searchNamespace = namespace;
  manager.processingSuspended = false;
  manager.processingMutex = new Mutex();
  manager.failedFiles = new Map();
  manager.queryCache = new Map();
  manager.lifecycle = new SemanticIndexLifecycle();
  manager.workQueue = queue;
  manager.config = { exclusions: settings.embeddingsExclusions };
  manager.gateway = {
    initializeContract: jest.fn(async () => undefined),
    activeGeneration: {
      id: "semantic-v1",
      indexSchemaVersion: 2,
      indexNamespace: namespace,
      dimensions: 2,
      limits: { maxTexts: 128, maxCharsPerText: 8_000, maxTotalChars: 200_000 },
    },
  };
  manager.storage = {
    getVectorSync: jest.fn((id: string) => roots.get(id) ?? null),
    removeByPath: jest.fn(async (path: string) => {
      for (const [id, vector] of roots) if (vector.path === path) roots.delete(id);
    }),
    removeNamespacesExcept: jest.fn(async () => 0),
    writeState: jest.fn(async () => undefined),
    deleteState: jest.fn(async () => undefined),
  };
  manager.app = {
    vault: {
      adapter: null,
      getMarkdownFiles: jest.fn(() => files),
      getAbstractFileByPath: jest.fn((path: string) => files.find((file) => file.path === path) ?? null),
    },
  };
  manager.plugin = {
    settings,
    emitter: { emit: jest.fn() },
    getSettingsManager: jest.fn(() => ({
      updateSettings: jest.fn(async (patch: Partial<typeof settings>) => Object.assign(settings, patch)),
    })),
  };
  manager.markPortableIndexChanged = jest.fn();
  manager.flushPortableIndex = jest.fn(async () => undefined);
  manager.commitPortableDestructiveMutation = jest.fn(async () => undefined);
  return { files, roots, queue, manager, settings };
}

describe("EmbeddingsManager run bookkeeping", () => {
  it("commits a searchable generation when normalized-empty notes have current local markers", async () => {
    const { files, roots, manager } = await harness(2);
    roots.set(root(files[0]).id, root(files[0]));
    const marker = createLocalEmptyEmbeddingMarker(files[1], "---\ntags: [image]\n---\n![[cover.png]]");
    roots.set(marker.id, marker);
    manager.searchNamespace = null;

    await expect(manager.commitSearchNamespaceIfComplete()).resolves.toBe(true);
    expect(manager.searchNamespace).toBe(namespace);
  });

  it.each([
    {
      label: "local cancellation",
      fatalError: null,
      cancelled: true,
      lifecyclePhase: "idle",
    },
    {
      label: "fatal managed failure",
      fatalError: new ManagedEmbeddingsError("temporarily_unavailable", "Try again later.", 503),
      cancelled: false,
      lifecyclePhase: "error",
    },
  ])("keeps completed paths durable after $label", async ({ fatalError, cancelled, lifecyclePhase }) => {
    const { files, roots, queue, manager, settings } = await harness(2);
    await queue.enqueueImmediate(files[0].path, "reconcile", files[0].stat.mtime, 1);
    await queue.enqueueImmediate(files[1].path, "reconcile", files[1].stat.mtime, 1);
    manager.processor = {
      processFiles: jest.fn(async (): Promise<ProcessingResult> => {
        roots.set(root(files[0]).id, root(files[0]));
        return {
          completed: 1,
          completedPaths: [files[0].path],
          failed: 0,
          failedPaths: [],
          cancelled,
          fatalError,
        };
      }),
    };

    await expect(manager.processVault()).resolves.toMatchObject({
      status: "aborted",
      processed: 1,
      partialSuccess: true,
    });

    expect(queue.snapshot().map((item) => item.path)).toEqual([files[1].path]);
    expect(settings.embeddingsRebuildPending).toBe(true);
    expect(manager.markPortableIndexChanged).toHaveBeenCalledTimes(1);
    expect(manager.flushPortableIndex).toHaveBeenCalledTimes(1);
    expect(manager.getLifecycleSnapshot()).toMatchObject({
      phase: lifecyclePhase,
      total: 2,
      completed: 1,
      pending: 1,
    });
  });

  it("projects vault-wide idle completion after one queued note is refreshed", async () => {
    const { files, roots, queue, manager } = await harness(100);
    for (const file of files) roots.set(root(file).id, root(file));
    files[0].stat.mtime = 2;
    await queue.enqueueImmediate(files[0].path, "modify", files[0].stat.mtime, 1);
    manager.processor = {
      processFiles: jest.fn(async (): Promise<ProcessingResult> => {
        roots.set(root(files[0]).id, root(files[0]));
        return {
          completed: 1,
          completedPaths: [files[0].path],
          failed: 0,
          failedPaths: [],
          cancelled: false,
          fatalError: null,
        };
      }),
    };

    await manager.processQueuedWork();

    expect(manager.getLifecycleSnapshot()).toMatchObject({
      phase: "idle",
      total: 100,
      completed: 100,
      pending: 0,
    });
  });

  it("coalesces mutex contention into a nonzero queued-work backoff", async () => {
    jest.useFakeTimers();
    try {
      const { files, queue, manager } = await harness(1);
      await queue.enqueueImmediate(files[0].path, "modify", files[0].stat.mtime, 1);
      let releaseLock: (() => void) | undefined;
      const heldLock = manager.processingMutex.runExclusive(() => new Promise<void>((resolve) => {
        releaseLock = resolve;
      }));
      await Promise.resolve();
      expect(releaseLock).toBeDefined();
      const setTimeoutSpy = jest.spyOn(window, "setTimeout");

      await manager.processQueuedWork();
      await manager.processQueuedWork();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(75);
      await jest.advanceTimersByTimeAsync(0);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      manager.clearWorkTimer();
      releaseLock?.();
      await heldLock;
      setTimeoutSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
