import type { EmbeddingVector } from "../embeddings/types";

const mockVectors = new Map<string, EmbeddingVector>();
const mockStorage = {
  initialize: jest.fn(async () => undefined),
  loadEmbeddings: jest.fn(async () => undefined),
  getAllVectors: jest.fn(async () => [...mockVectors.values()]),
  removeIds: jest.fn(async (ids: Iterable<string>) => {
    for (const id of ids) mockVectors.delete(id);
  }),
  peekBestNamespaceForPrefix: jest.fn((prefix: string) => (
    [...mockVectors.values()].find((vector) => vector.metadata.namespace.startsWith(prefix))?.metadata.namespace ?? null
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
        indexSchemaVersion: 1,
        indexNamespace: "systemsculpt:managed:v1:3",
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
    embeddingsEnabled: true,
    embeddingsAutoProcess: false,
    embeddingsPortableIndex: false,
    embeddingsRebuildPending: false,
    embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
    chatsDirectory: "Chats",
    savedChatsDirectory: "Saved Chats",
  };
  const updateSettings = jest.fn(async (patch: Partial<typeof settings>) => Object.assign(settings, patch));
  const vault = {
    adapter: null,
    getMarkdownFiles: jest.fn(() => [file]),
    getAbstractFileByPath: jest.fn(() => file),
    read: jest.fn(async () => content),
    on: jest.fn(() => ({})),
    offref: jest.fn(),
  };
  const plugin = {
    settings,
    emitter: { emit: jest.fn() },
    getManagedCapabilityClient: jest.fn(() => ({ request })),
    getSettingsManager: jest.fn(() => ({ updateSettings })),
  };
  const manager = new EmbeddingsManager({ vault } as never, plugin as never);
  return {
    file,
    manager,
    plugin,
    request,
    updateSettings,
    vault,
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

    const internals = state.manager as unknown as {
      processingMutex: { runExclusive<T>(callback: () => Promise<T>): Promise<T> };
      requestFileProcessing(file: TFile, reason: string): void;
    };
    let releaseLock: (() => void) | undefined;
    const heldLock = internals.processingMutex.runExclusive(() => new Promise<void>((resolve) => {
      releaseLock = resolve;
    }));
    while (!releaseLock) await Promise.resolve();
    internals.requestFileProcessing(state.file, "modify");
    state.setContent("This note now has enough meaningful content to require a managed embedding. ".repeat(3));
    expect(state.manager.getStats()).toMatchObject({ processed: 0, needsProcessing: 1 });
    releaseLock();
    await heldLock;
    for (let attempt = 0; attempt < 20 && (state.request.mock.calls.length === 0 || state.manager.isCurrentlyProcessing()); attempt += 1) {
      await Promise.resolve();
    }

    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.manager.getStats()).toMatchObject({ processed: 1, present: 1, needsProcessing: 0 });
  });

  it("keeps rebuild intent pending and aborts when a note cannot be read", async () => {
    const state = harness("This note has enough content to require preparation and embedding. ".repeat(3));
    state.vault.read.mockRejectedValueOnce(new Error("disk read failed"));
    await state.manager.initialize();

    const result = await state.manager.processVault();

    expect(result).toMatchObject({ status: "aborted", failure: { code: "local_preparation_failed" } });
    expect(state.plugin.settings.embeddingsRebuildPending).toBe(true);
    expect(state.manager.getStats()).toMatchObject({ failed: 1, needsProcessing: 1 });
    expect(state.request).not.toHaveBeenCalled();
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
});
