import type { EmbeddingVector } from "../embeddings/types";
import {
  ManagedEmbeddingsError,
  type ManagedEmbeddingsIndexAdapter,
  type ManagedEmbeddingsIndexGeneration,
  type ManagedEmbeddingsIndexMetadata,
  type ManagedEmbeddingsIndexOperation,
  type ManagedEmbeddingsIndexResult,
} from "../embeddings/gateway/ManagedEmbeddingsIndexAdapter";

const mockVectors = new Map<string, EmbeddingVector>();
const mockState = new Map<string, unknown>();
const mockStorage = {
  initialize: jest.fn(async () => undefined),
  loadEmbeddings: jest.fn(async () => undefined),
  getAllVectors: jest.fn(async () => [...mockVectors.values()]),
  removeIds: jest.fn(async (ids: Iterable<string>) => {
    for (const id of ids) mockVectors.delete(id);
  }),
  peekCurrentManagedNamespace: jest.fn(() => (
    [...mockVectors.values()].find((vector) => vector.metadata.namespace.startsWith("systemsculpt:managed:"))?.metadata.namespace ?? null
  )),
  purgeCorruptedVectors: jest.fn(async () => ({ removedCount: 0, correctedCount: 0, removedPaths: [], correctedPaths: [] })),
  getVectorsByPath: jest.fn(async (path: string) => [...mockVectors.values()].filter((vector) => vector.path === path)),
  getVectorSync: jest.fn((id: string) => mockVectors.get(id) ?? null),
  storeVectors: jest.fn(async (vectors: EmbeddingVector[]) => {
    for (const vector of vectors) mockVectors.set(vector.id, vector);
  }),
  publishPath: jest.fn(async (path: string, namespace: string, vectors: EmbeddingVector[]) => {
    for (const [id, vector] of mockVectors) {
      if (
        vector.path === path
        && (
          vector.metadata.namespace === namespace
          || vector.metadata.namespace === "systemsculpt:local-empty:v1:1"
        )
      ) {
        mockVectors.delete(id);
      }
    }
    for (const vector of vectors) mockVectors.set(vector.id, vector);
  }),
  replacePath: jest.fn(async (path: string, vectors: EmbeddingVector[]) => {
    for (const [id, vector] of mockVectors) {
      if (vector.path === path) mockVectors.delete(id);
    }
    for (const vector of vectors) mockVectors.set(vector.id, vector);
  }),
  removeByPathExceptIds: jest.fn(async (path: string, namespace: string, keepIds: Set<string>) => {
    for (const [id, vector] of mockVectors) {
      if (vector.path === path && vector.metadata.namespace === namespace && !keepIds.has(id)) mockVectors.delete(id);
    }
  }),
  moveVectorId: jest.fn(async () => undefined),
  removeByPath: jest.fn(async (path: string) => {
    for (const [id, vector] of mockVectors) if (vector.path === path) mockVectors.delete(id);
  }),
  renameByPath: jest.fn(async () => undefined),
  renameByDirectory: jest.fn(async () => undefined),
  removeByDirectory: jest.fn(async () => undefined),
  clear: jest.fn(async () => { mockVectors.clear(); }),
  readState: jest.fn(async <T>(key: string): Promise<T | null> =>
    (mockState.get(key) as T | undefined) ?? null),
  writeState: jest.fn(async <T>(key: string, value: T) => {
    mockState.set(key, value);
  }),
  deleteState: jest.fn(async (key: string) => {
    mockState.delete(key);
  }),
  getDistinctPaths: jest.fn(() => [...new Set([...mockVectors.values()].map((vector) => vector.path))]),
  size: jest.fn(() => mockVectors.size),
};

jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const EmbeddingsStorage = jest.fn(() => mockStorage);
  (EmbeddingsStorage as jest.Mock & { buildDbName: jest.Mock }).buildDbName = jest.fn(() => "empty-lifecycle-test");
  return { EmbeddingsStorage };
});

jest.mock("../embeddings/storage/EmbeddingsPortableIndex", () => ({
  restoreEmbeddingsIndexIfEmpty: jest.fn(async () => ({ restored: false, imported: 0 })),
  writeEmbeddingsIndexSnapshot: jest.fn(async () => ({ written: false, count: 0 })),
}));

import { TFile } from "obsidian";
import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";
import {
  MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
  ManagedEmbeddingsError,
} from "../embeddings/gateway/ManagedEmbeddingsIndexAdapter";
import { buildManagedNamespace } from "../embeddings/utils/namespace";
import { buildVectorId } from "../embeddings/utils/vectorId";

const managedMetadata: ManagedEmbeddingsIndexMetadata = {
  contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
  generation: {
    id: "semantic-v1",
    indexSchemaVersion: 3,
    indexNamespaceTemplate: "systemsculpt:managed:semantic-v1:v3:<dimensions>",
  },
  limits: {
    maxSourceBytes: 8 * 1024 * 1024,
    maxResultBytes: 16 * 1024 * 1024,
  },
};

function nonEmptyIndexResult(markdown: string): ManagedEmbeddingsIndexResult {
  return {
    contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    source: { contentSha256: `source:${markdown.length}` },
    empty: false,
    vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
    generation: {
      id: "semantic-v1",
      indexSchemaVersion: 3,
      indexNamespace: buildManagedNamespace(3),
      dimensions: 3,
    },
    chunks: [{
      ordinal: 0,
      textHash: `chunk:${markdown.length}`,
      headingPath: [],
      excerpt: markdown.replace(/\s+/g, " ").trim().slice(0, 120) || "Note",
      length: markdown.length,
      vector: new Float32Array([1, 0, 0]),
    }],
  };
}

function emptyIndexResult(markdown: string): ManagedEmbeddingsIndexResult {
  return {
    contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    source: { contentSha256: `source:${markdown.length}` },
    empty: true,
    vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
    generation: null,
    chunks: [],
  };
}

function harness(initialContent: string) {
  let content = initialContent;
  const file = new TFile({
    path: "Note.md",
    name: "Note.md",
    extension: "md",
    stat: { mtime: 1, size: initialContent.length },
  });
  const indexAdapter = {
    activeGeneration: undefined as ManagedEmbeddingsIndexGeneration | undefined,
    metadata: undefined as ManagedEmbeddingsIndexMetadata | undefined,
    getMetadata: jest.fn(async () => {
      indexAdapter.metadata = managedMetadata;
      return managedMetadata;
    }),
    index: jest.fn(async (operation: ManagedEmbeddingsIndexOperation) => {
      const result = nonEmptyIndexResult(operation.prepare().markdown);
      indexAdapter.activeGeneration = result.generation ?? undefined;
      return result;
    }),
    query: jest.fn(),
  } as unknown as ManagedEmbeddingsIndexAdapter;
  const settings = {
    vaultInstanceId: "vault",
    embeddingsVectorFormatVersion: 5,
    embeddingsEnabled: false,
    embeddingsPortableIndex: false,
    embeddingsRebuildPending: false,
    embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
    chatsDirectory: "Chats",
    savedChatsDirectory: "Saved Chats",
  };
  const updateSettings = jest.fn(async (patch: Partial<typeof settings>) => Object.assign(settings, patch));
  const watchers = new Map<string, (...args: any[]) => void>();
  const vault = {
    adapter: null,
    getMarkdownFiles: jest.fn(() => [file]),
    getAbstractFileByPath: jest.fn(() => file),
    read: jest.fn(async () => content),
    on: jest.fn((event: string, callback: (...args: any[]) => void) => {
      watchers.set(event, callback);
      return {};
    }),
    offref: jest.fn(),
  };
  const plugin = {
    settings,
    emitter: { emit: jest.fn() },
    getManagedCapabilityClient: jest.fn(() => ({
      getEmbeddingsIndex: () => indexAdapter,
    })),
    getSettingsManager: jest.fn(() => ({ updateSettings })),
  };
  const manager = new EmbeddingsManager({ vault } as never, plugin as never);
  return {
    file,
    getMetadata: indexAdapter.getMetadata as jest.Mock,
    index: indexAdapter.index as jest.Mock,
    indexAdapter,
    manager,
    plugin,
    updateSettings,
    vault,
    watchers,
    setContent(next: string) {
      content = next;
      file.stat.size = next.length;
      file.stat.mtime += 1;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for embeddings lifecycle state.`);
}

describe("EmbeddingsManager local empty-note lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVectors.clear();
    mockState.clear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("completes an all-empty vault without remote work and processes the note after content appears", async () => {
    const state = harness("");
    await state.manager.initialize();

    expect(state.manager.getStats()).toEqual({ total: 1, processed: 1, present: 0, needsProcessing: 0, failed: 0 });
    await expect(state.manager.processVault()).resolves.toMatchObject({ status: "complete", processed: 0 });
    expect(state.index).not.toHaveBeenCalled();
    expect(state.plugin.settings.embeddingsRebuildPending).toBe(false);
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({
      phase: "idle",
      total: 1,
      completed: 1,
      pending: 0,
    });

    const internals = state.manager as unknown as {
      processingMutex: { runExclusive<T>(callback: () => Promise<T>): Promise<T> };
      requestFileProcessing(file: TFile, reason: string): void;
    };
    let releaseLock: (() => void) | undefined;
    const heldLock = internals.processingMutex.runExclusive(() => new Promise<void>((resolve) => {
      releaseLock = resolve;
    }));
    while (!releaseLock) await Promise.resolve();
    state.plugin.settings.embeddingsEnabled = true;
    internals.requestFileProcessing(state.file, "modify");
    state.setContent("This note now has enough meaningful content to require a managed embedding. ".repeat(3));
    expect(state.manager.getStats()).toMatchObject({ processed: 0, needsProcessing: 1 });
    releaseLock();
    await heldLock;
    await waitFor(() => state.index.mock.calls.length > 0 && !state.manager.isCurrentlyProcessing());

    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toMatchObject({ processed: 1, present: 1, needsProcessing: 0 });
  });

  it("keeps rebuild intent pending and isolates a note that cannot be read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = harness("This note has enough content to require preparation and embedding. ".repeat(3));
    state.vault.read.mockRejectedValueOnce(new Error("disk read failed"));
    await state.manager.initialize();

    const result = await state.manager.processVault();

    expect(result).toMatchObject({ status: "complete", processed: 0, partialSuccess: true });
    expect(state.plugin.settings.embeddingsRebuildPending).toBe(true);
    expect(state.manager.getStats()).toMatchObject({ failed: 1, needsProcessing: 1 });
    expect(state.index).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[SystemSculpt][WARN] Failed to index note with managed embeddings",
      {
        source: "EmbeddingsProcessor",
        method: "processFiles",
        metadata: {
          path: "Note.md",
          code: "local_preparation_failed",
          status: 0,
        },
      },
    );
  });

  it("checks authoritative spendable credits before reading a vault note", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = harness("This note would otherwise be uploaded for embeddings. ".repeat(4));
    (state.plugin as any).aiService = {
      getCreditsBalance: jest.fn(async () => ({
        usageClass: "customer",
        totalRemaining: 5,
        heldInFlight: 5,
        availableUnreserved: 0,
      })),
    };
    await state.manager.initialize();
    state.vault.read.mockClear();

    await expect(state.manager.processVault()).resolves.toMatchObject({
      status: "aborted",
      failure: { code: "payment_required", status: 402 },
    });

    expect(state.vault.read).not.toHaveBeenCalled();
    expect(state.index).not.toHaveBeenCalled();
    expect(state.manager.isSuspended()).toBe(true);
    warn.mockRestore();
  });

  it("cancels a competing worker before note reads when metadata fails fatally", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = harness("This note must not be read after a concurrent fatal suspension. ".repeat(4));
    let releaseBalance!: () => void;
    let signalBalanceStarted!: () => void;
    const balanceStarted = new Promise<void>((resolve) => { signalBalanceStarted = resolve; });
    const balanceRelease = new Promise<void>((resolve) => { releaseBalance = resolve; });
    (state.plugin as any).aiService = {
      getCreditsBalance: jest.fn(async () => {
        signalBalanceStarted();
        await balanceRelease;
        return {
          usageClass: "customer",
          totalRemaining: 5,
          heldInFlight: 0,
          availableUnreserved: 5,
        };
      }),
    };
    state.getMetadata
      .mockResolvedValueOnce(managedMetadata)
      .mockRejectedValueOnce(new ManagedEmbeddingsError(
        "capability_unavailable",
        "Managed embeddings are unavailable.",
        503,
        "request-concurrent-metadata",
      ));
    await state.manager.initialize();
    state.vault.read.mockClear();

    const worker = state.manager.processVault();
    await balanceStarted;
    await expect(state.manager.processVault()).rejects.toMatchObject({
      code: "capability_unavailable",
      status: 503,
    });
    releaseBalance();
    await expect(worker).resolves.toMatchObject({ status: "aborted", processed: 0 });

    expect(state.manager.isSuspended()).toBe(true);
    expect(state.vault.read).not.toHaveBeenCalled();
    expect(state.index).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not reset a fatal suspension before queued processor dispatch", async () => {
    const state = harness("Queued work must honor a suspension raised during preparation. ".repeat(4));
    await state.manager.initialize();
    state.plugin.settings.embeddingsEnabled = true;
    const queue = (state.manager as any).workQueue;
    await queue.enqueueImmediate(state.file.path, "modify", state.file.stat.mtime);
    const complete = queue.complete.bind(queue);
    jest.spyOn(queue, "complete").mockImplementation(async (items: unknown[]) => {
      await complete(items);
      (state.manager as any).processingSuspended = true;
      (state.manager as any).fatalSuspensionCode = "capability_unavailable";
    });
    const processFiles = jest.spyOn((state.manager as any).processor, "processFiles");
    state.vault.read.mockClear();

    await (state.manager as any).processQueuedWork();

    expect(processFiles).not.toHaveBeenCalled();
    expect(state.vault.read).not.toHaveBeenCalled();
    expect(state.index).not.toHaveBeenCalled();
  });

  it("persists the managed request ID with a failed work item", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = harness("This note reaches the managed embeddings route. ".repeat(4));
    state.index.mockRejectedValueOnce(new ManagedEmbeddingsError(
      "payment_required",
      "Not enough credits are available.",
      402,
      "request-embeddings-payment",
    ));
    await state.manager.initialize();

    await state.manager.processVault();

    expect((state.manager as any).workQueue.get(state.file.path)).toMatchObject({
      failure: {
        code: "payment_required",
        status: 402,
        requestId: "request-embeddings-payment",
      },
    });
    await (state.manager as any).workQueue.settled();

    const restored = harness("This note reaches the managed embeddings route. ".repeat(4));
    restored.plugin.settings.embeddingsEnabled = true;
    restored.getMetadata.mockClear();
    restored.vault.read.mockClear();
    restored.index.mockClear();
    await restored.manager.initialize();
    await Promise.resolve();
    await Promise.resolve();
    expect((restored.manager as any).workQueue.get(restored.file.path)).toMatchObject({
      failure: {
        code: "payment_required",
        status: 402,
        requestId: "request-embeddings-payment",
      },
    });
    expect(restored.manager.isSuspended()).toBe(true);
    expect(restored.getMetadata).not.toHaveBeenCalled();
    expect(restored.vault.read).not.toHaveBeenCalled();
    expect(restored.index).not.toHaveBeenCalled();

    restored.plugin.settings.embeddingsEnabled = false;
    await restored.manager.resumeProcessing("explicit");
    await waitFor(() => !restored.manager.isSuspended());
    expect(mockState.has("semantic-fatal-suspension-v1")).toBe(false);

    const afterResume = harness("This note reaches the managed embeddings route. ".repeat(4));
    await afterResume.manager.initialize();
    expect(afterResume.manager.isSuspended()).toBe(false);
    expect((afterResume.manager as any).workQueue.get(afterResume.file.path)?.failure).toBeNull();
    warn.mockRestore();
  });

  it("persists a fatal metadata rejection and blocks automatic work after restart", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = harness("Metadata admission must fail closed after restart. ".repeat(4));
    first.getMetadata.mockRejectedValueOnce(new ManagedEmbeddingsError(
      "license_rejected",
      "The managed capability is unavailable.",
      403,
      "request-metadata-license",
    ));
    await first.manager.initialize();

    await expect(first.manager.processVault()).rejects.toMatchObject({
      code: "license_rejected",
      status: 403,
    });
    expect(first.manager.isSuspended()).toBe(true);
    expect(mockState.get("semantic-fatal-suspension-v1")).toMatchObject({
      version: 1,
      code: "license_rejected",
      status: 403,
      requestId: "request-metadata-license",
    });

    const restored = harness("Metadata admission must fail closed after restart. ".repeat(4));
    restored.plugin.settings.embeddingsEnabled = true;
    restored.getMetadata.mockClear();
    restored.vault.read.mockClear();
    restored.index.mockClear();
    await restored.manager.initialize();
    await Promise.resolve();
    await Promise.resolve();

    expect(restored.manager.isSuspended()).toBe(true);
    expect(restored.getMetadata).not.toHaveBeenCalled();
    expect(restored.vault.read).not.toHaveBeenCalled();
    expect(restored.index).not.toHaveBeenCalled();

    await restored.manager.resumeProcessing("funding");
    expect(restored.manager.isSuspended()).toBe(true);
    expect(mockState.has("semantic-fatal-suspension-v1")).toBe(true);
    restored.plugin.settings.embeddingsEnabled = false;
    await restored.manager.resumeProcessing("explicit");
    expect(restored.manager.isSuspended()).toBe(false);
    warn.mockRestore();
  });

  it("queues corrupted stored paths for an explicit retry and rebuild", async () => {
    const state = harness("A note whose corrupted stored vector must be rebuilt.");
    (mockStorage.purgeCorruptedVectors as jest.Mock).mockResolvedValueOnce({
      removedCount: 1,
      correctedCount: 0,
      removedPaths: [state.file.path],
      correctedPaths: [],
    });

    await state.manager.initialize();

    expect(state.manager.getStats()).toMatchObject({
      failed: 1,
      needsProcessing: 1,
    });
    expect((state.manager as any).workQueue.get(state.file.path)).toMatchObject({
      path: state.file.path,
      reason: "reconcile",
      failure: {
        code: "invalid_response",
        message: "Stored vector was invalid.",
      },
    });

    await expect(state.manager.retryFailedFiles()).resolves.toMatchObject({
      status: "complete",
      processed: 1,
    });
    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toMatchObject({
      processed: 1,
      needsProcessing: 0,
      failed: 0,
    });
  });

  it("keeps edits durable while processing is paused", async () => {
    const state = harness("A note that starts current.");
    await state.manager.initialize();
    await state.manager.processVault();
    state.plugin.settings.embeddingsEnabled = true;
    state.manager.suspendProcessing();
    state.setContent("A changed note that must be reconciled after resume.");

    state.watchers.get("modify")?.(state.file);
    await (state.manager as any).workQueue.settled();
    await Promise.resolve();

    expect((state.manager as any).workQueue.get(state.file.path)).toMatchObject({
      path: state.file.path,
      reason: "modify",
    });
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({ phase: "paused", pending: 1 });
  });

  it("keeps a newer queued edit pending and never publishes the stale response", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = harness("Original note content sent for managed inference.");
    await state.manager.initialize();
    let releaseResponse: (() => void) | undefined;
    state.index.mockImplementationOnce(async (operation: ManagedEmbeddingsIndexOperation) => {
      const markdown = operation.prepare().markdown;
      await new Promise<void>((resolve) => { releaseResponse = resolve; });
      return nonEmptyIndexResult(markdown);
    });

    const processing = state.manager.processVault();
    for (let attempt = 0; attempt < 20 && !releaseResponse; attempt += 1) await Promise.resolve();
    expect(releaseResponse).toBeDefined();
    const queue = (state.manager as any).workQueue;
    const claimed = queue.get(state.file.path);
    expect(claimed).toMatchObject({ sourceMtime: 1 });

    state.setContent("A newer edit that must remain queued after the old response returns.");
    const newer = await queue.enqueueImmediate(
      state.file.path,
      "modify",
      state.file.stat.mtime,
      Date.now(),
    );
    releaseResponse?.();
    await processing;

    const storedRoot = mockVectors.get(buildVectorId(buildManagedNamespace(3), state.file.path, 0));
    expect(storedRoot).toBeUndefined();
    expect(queue.get(state.file.path)).toMatchObject({
      revision: newer.revision,
      sourceMtime: state.file.stat.mtime,
      failure: null,
    });
    expect(state.manager.getFileIndexSnapshot(state.file.path)).toMatchObject({
      state: "pending",
      ready: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "[SystemSculpt][WARN] Failed to index note with managed embeddings",
      expect.objectContaining({
        metadata: expect.objectContaining({
          path: "Note.md",
          code: "source_changed",
        }),
      }),
    );
  });

  it("automatically indexes whenever semantic indexing is enabled", async () => {
    const state = harness("Enabled semantic indexing starts without a second legacy switch.");
    state.plugin.settings.embeddingsEnabled = true;

    await state.manager.initialize();
    for (let attempt = 0; attempt < 30 && (state.index.mock.calls.length === 0 || state.manager.isCurrentlyProcessing()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toMatchObject({ processed: 1, needsProcessing: 0 });
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({ phase: "idle", completed: 1, pending: 0 });
  });

  it.each([
    ["license_required", 401],
    ["temporarily_unavailable", 503],
  ] as const)("surfaces startup %s failures and recovers on the next automatic run", async (code, status) => {
    const state = harness("Enabled semantic indexing must never report a false-ready state.");
    state.plugin.settings.embeddingsEnabled = true;
    state.getMetadata.mockRejectedValueOnce(new ManagedEmbeddingsError(code, "Managed catalog unavailable.", status));

    await state.manager.initialize();
    for (let attempt = 0; attempt < 30 && state.manager.getLifecycleSnapshot().phase !== "error"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(state.manager.getLifecycleSnapshot()).toMatchObject({
      phase: "error",
      lastError: { code, message: "Managed catalog unavailable." },
    });
    expect(state.index).not.toHaveBeenCalled();

    if (code === "license_required") {
      expect(state.manager.isSuspended()).toBe(true);
      state.manager.resumeProcessing();
      await waitFor(() => !state.manager.isSuspended());
    } else {
      state.manager.syncFromSettings();
    }
    await waitFor(() => state.manager.getLifecycleSnapshot().phase === "idle");

    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({ phase: "idle", lastError: null });
  });

  it("embeds a short non-empty note and closes coverage in one run", async () => {
    const state = harness("Tiny idea");
    await state.manager.initialize();

    const result = await state.manager.processVault();

    expect(result).toMatchObject({ status: "complete", processed: 1 });
    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toEqual({
      total: 1,
      processed: 1,
      present: 1,
      needsProcessing: 0,
      failed: 0,
    });
    await expect(state.manager.listPendingFiles()).resolves.toEqual([]);
  });

  it("persists normalized-empty notes as complete without polluting the managed namespace", async () => {
    const state = harness("---\ntags: [image]\n---\n![[cover.png]]");
    state.index.mockImplementationOnce(async (operation: ManagedEmbeddingsIndexOperation) => (
      emptyIndexResult(operation.prepare().markdown)
    ));
    await state.manager.initialize();

    const first = await state.manager.processVault();

    expect(first).toMatchObject({ status: "complete", processed: 1 });
    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toEqual({
      total: 1,
      processed: 1,
      present: 0,
      needsProcessing: 0,
      failed: 0,
    });
    expect([...mockVectors.values()]).toEqual([
      expect.objectContaining({
        path: "Note.md",
        metadata: expect.objectContaining({
          namespace: "systemsculpt:local-empty:v1:1",
          isEmpty: true,
          complete: true,
        }),
      }),
    ]);

    await expect(state.manager.processVault()).resolves.toMatchObject({ status: "complete", processed: 0 });
    expect(state.index).toHaveBeenCalledTimes(1);

    state.setContent("Tiny but meaningful");
    await expect(state.manager.processVault()).resolves.toMatchObject({ status: "complete", processed: 1 });
    expect(state.index).toHaveBeenCalledTimes(2);
    expect(state.manager.getStats()).toMatchObject({ processed: 1, present: 1, needsProcessing: 0 });
  });

  it("reconciles rename, delete, and clear through the same durable lifecycle", async () => {
    const state = harness("A note that will be renamed and deleted.");
    await state.manager.initialize();
    await state.manager.processVault();

    state.watchers.get("rename")?.(state.file, "Old.md");
    while (!(mockStorage.renameByPath as jest.Mock).mock.calls.length || state.manager.isCurrentlyProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockStorage.renameByPath).toHaveBeenCalledWith("Old.md", "Note.md", "Note");

    state.watchers.get("delete")?.(state.file);
    while (state.manager.isCurrentlyProcessing()) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockStorage.removeByPath).toHaveBeenCalledWith("Note.md");
    expect((state.manager as any).workQueue.snapshot()).toEqual([]);

    await state.manager.clearAll();
    expect(mockStorage.clear).toHaveBeenCalled();
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({
      phase: "idle",
      pending: 0,
      failed: 0,
      generation: null,
    });
  });
});
