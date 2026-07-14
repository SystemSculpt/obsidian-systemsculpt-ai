import type { EmbeddingVector } from "../embeddings/types";

const mockVectors = new Map<string, EmbeddingVector>();
const mockStorage = {
  initialize: jest.fn(async () => undefined),
  loadEmbeddings: jest.fn(async () => undefined),
  getAllVectors: jest.fn(async () => [...mockVectors.values()]),
  removeIds: jest.fn(async (ids: Iterable<string>) => {
    for (const id of ids) mockVectors.delete(id);
  }),
  peekCurrentManagedNamespace: jest.fn(() => (
    [...mockVectors.values()].find((vector) => vector.metadata.namespace.startsWith("systemsculpt:managed:semantic-v1:v2:"))?.metadata.namespace ?? null
  )),
  purgeCorruptedVectors: jest.fn(async () => ({ removedCount: 0, correctedCount: 0, removedPaths: [], correctedPaths: [] })),
  getVectorsByPath: jest.fn(async (path: string) => [...mockVectors.values()].filter((vector) => vector.path === path)),
  getVectorSync: jest.fn((id: string) => mockVectors.get(id) ?? null),
  storeVectors: jest.fn(async (vectors: EmbeddingVector[]) => {
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
import { ManagedEmbeddingsError } from "../embeddings/gateway/ManagedEmbeddingsAdapter";
import { buildManagedNamespace } from "../embeddings/utils/namespace";
import { buildVectorId } from "../embeddings/utils/vectorId";

const managedCatalog = {
  capabilities: [{
    alias: "systemsculpt/embeddings",
    availability: "available",
    limits: { max_texts: 128, max_chars_per_text: 8000, max_total_chars: 200000 },
    generation: {
      id: "semantic-v1",
      index_schema_version: 2,
      index_namespace: "systemsculpt:managed:semantic-v1:v2:<dimensions>",
    },
  }],
};

function harness(initialContent: string) {
  let content = initialContent;
  const file = new TFile({
    path: "Note.md",
    name: "Note.md",
    extension: "md",
    stat: { mtime: 1, size: initialContent.length },
  });
  const request = jest.fn(async (operation: { body: () => unknown }) => {
    operation.body();
    return {
      response: new Response(JSON.stringify({
        embeddings: [[0.1, 0.2, 0.3]],
        dimensions: 3,
        generation: {
          id: "semantic-v1",
          indexSchemaVersion: 2,
          indexNamespace: "systemsculpt:managed:semantic-v1:v2:3",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      diagnostics: {
        status: 200,
        requestId: "request-1",
        contentType: "application/json",
        rateLimitLimit: null,
        rateLimitRemaining: null,
        rateLimitReset: null,
        retryAfter: null,
        errorText: "",
      },
    };
  });
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
  const getCatalog = jest.fn(async () => managedCatalog);
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
    getManagedCapabilityClient: jest.fn(() => ({ request, getCatalog })),
    getSettingsManager: jest.fn(() => ({ updateSettings })),
  };
  const manager = new EmbeddingsManager({ vault } as never, plugin as never);
  return {
    file,
    manager,
    getCatalog,
    plugin,
    request,
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

describe("EmbeddingsManager local empty-note lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVectors.clear();
  });

  it("completes an all-empty vault without remote work and processes the note after content appears", async () => {
    const state = harness("");
    await state.manager.initialize();

    expect(state.manager.getStats()).toEqual({ total: 1, processed: 1, present: 0, needsProcessing: 0, failed: 0 });
    await expect(state.manager.processVault()).resolves.toMatchObject({ status: "complete", processed: 0 });
    expect(state.request).not.toHaveBeenCalled();
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
    await new Promise((resolve) => setTimeout(resolve, 450));
    for (let attempt = 0; attempt < 20 && (state.request.mock.calls.length === 0 || state.manager.isCurrentlyProcessing()); attempt += 1) {
      await Promise.resolve();
    }

    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toMatchObject({ processed: 1, present: 1, needsProcessing: 0 });
  });

  it("keeps rebuild intent pending and isolates a note that cannot be read", async () => {
    const state = harness("This note has enough content to require preparation and embedding. ".repeat(3));
    state.vault.read.mockRejectedValueOnce(new Error("disk read failed"));
    await state.manager.initialize();

    const result = await state.manager.processVault();

    expect(result).toMatchObject({ status: "complete", processed: 0, partialSuccess: true });
    expect(state.plugin.settings.embeddingsRebuildPending).toBe(true);
    expect(state.manager.getStats()).toMatchObject({ failed: 1, needsProcessing: 1 });
    expect(state.request).not.toHaveBeenCalled();
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

  it("keeps a newer queued edit pending and stamps only the source revision sent for inference", async () => {
    const state = harness("Original note content sent for managed inference.");
    await state.manager.initialize();
    let releaseResponse: (() => void) | undefined;
    state.request.mockImplementationOnce(async (operation: { body: () => unknown }) => {
      operation.body();
      await new Promise<void>((resolve) => { releaseResponse = resolve; });
      return {
        response: new Response(JSON.stringify({
          embeddings: [[0.1, 0.2, 0.3]],
          dimensions: 3,
          generation: {
            id: "semantic-v1",
            indexSchemaVersion: 2,
            indexNamespace: buildManagedNamespace(3),
          },
        }), { status: 200, headers: { "content-type": "application/json" } }),
        diagnostics: {
          status: 200,
          requestId: "request-race",
          contentType: "application/json",
          rateLimitLimit: null,
          rateLimitRemaining: null,
          rateLimitReset: null,
          retryAfter: null,
          errorText: "",
        },
      };
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
    expect(storedRoot?.metadata.mtime).toBe(1);
    expect(queue.get(state.file.path)).toMatchObject({
      revision: newer.revision,
      sourceMtime: state.file.stat.mtime,
      failure: null,
    });
    expect(state.manager.getFileIndexSnapshot(state.file.path)).toMatchObject({
      state: "pending",
      ready: false,
    });
  });

  it("automatically indexes whenever semantic indexing is enabled", async () => {
    const state = harness("Enabled semantic indexing starts without a second legacy switch.");
    state.plugin.settings.embeddingsEnabled = true;

    await state.manager.initialize();
    for (let attempt = 0; attempt < 30 && (state.request.mock.calls.length === 0 || state.manager.isCurrentlyProcessing()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toMatchObject({ processed: 1, needsProcessing: 0 });
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({ phase: "idle", completed: 1, pending: 0 });
  });

  it.each([
    ["license_required", 401],
    ["temporarily_unavailable", 503],
  ] as const)("surfaces startup %s failures and recovers on the next automatic run", async (code, status) => {
    const state = harness("Enabled semantic indexing must never report a false-ready state.");
    state.plugin.settings.embeddingsEnabled = true;
    state.getCatalog.mockRejectedValueOnce(new ManagedEmbeddingsError(code, "Managed catalog unavailable.", status));

    await state.manager.initialize();
    for (let attempt = 0; attempt < 30 && state.manager.getLifecycleSnapshot().phase !== "error"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(state.manager.getLifecycleSnapshot()).toMatchObject({
      phase: "error",
      lastError: { code, message: "Managed catalog unavailable." },
    });
    expect(state.request).not.toHaveBeenCalled();

    state.manager.syncFromSettings();
    for (let attempt = 0; attempt < 30 && state.manager.getLifecycleSnapshot().phase !== "idle"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.manager.getLifecycleSnapshot()).toMatchObject({ phase: "idle", lastError: null });
  });

  it("embeds a short non-empty note and closes coverage in one run", async () => {
    const state = harness("Tiny idea");
    await state.manager.initialize();

    const result = await state.manager.processVault();

    expect(result).toMatchObject({ status: "complete", processed: 1 });
    expect(state.request).toHaveBeenCalledTimes(1);
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
    await state.manager.initialize();

    const first = await state.manager.processVault();

    expect(first).toMatchObject({ status: "complete", processed: 1 });
    expect(state.request).not.toHaveBeenCalled();
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
    expect(state.request).not.toHaveBeenCalled();

    state.setContent("Tiny but meaningful");
    await expect(state.manager.processVault()).resolves.toMatchObject({ status: "complete", processed: 1 });
    expect(state.request).toHaveBeenCalledTimes(1);
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
