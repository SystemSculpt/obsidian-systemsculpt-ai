jest.mock("../../../utils/errorLogger", () => ({
  errorLogger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createHash } from "node:crypto";
import type { Mutex } from "async-mutex";
import { TFile } from "obsidian";
import { EmbeddingsManager, type EmbeddingsRunResult } from "../EmbeddingsManager";
import { ManagedEmbeddingsIndexAdapter } from "../gateway/ManagedEmbeddingsIndexAdapter";
import { HostedTransportAdapter } from "../../managed/adapters/HostedTransportAdapter";
import { EmbeddingsStorage } from "../storage/EmbeddingsStorage";
import { SemanticWorkQueue } from "../SemanticWorkQueue";
import { createLocalEmptyEmbeddingMarkerForRevision } from "../LocalEmptyEmbeddingMarker";
import type { EmbeddingVector } from "../types";
import { buildVectorId } from "../utils/vectorId";
import { installFakeIndexedDb } from "./support/fakeIndexedDb";
import {
  MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
  ManagedEmbeddingsError,
} from "../gateway/ManagedEmbeddingsIndexAdapter";

const NAMESPACE = "systemsculpt:managed:semantic-v1:v3:2";
const NEXT_NAMESPACE = "systemsculpt:managed:semantic-v2:v3:2";
const VAULT_ID = "startup-work";

function file(path = "A.md", mtime = 1, size = 100): TFile {
  return new TFile({ path, name: path, extension: "md", stat: { mtime, size } });
}

function root(note: TFile): EmbeddingVector {
  return {
    id: buildVectorId(NAMESPACE, note.path, 0),
    path: note.path,
    chunkId: 0,
    vector: new Float32Array([1, 0]),
    metadata: {
      title: note.basename, mtime: note.stat.mtime, contentHash: note.path,
      generation: "semantic-v1", dimension: 2, createdAt: 1,
      namespace: NAMESPACE, complete: true, chunkCount: 1,
    },
  };
}

async function harness(files: TFile[], records = files.map(root), override?: ManagedEmbeddingsIndexAdapter) {
  const seed = new EmbeddingsStorage(EmbeddingsStorage.buildDbName(VAULT_ID));
  await seed.initialize();
  await seed.storeVectors(records);
  await seed.writeState("semantic-vector-validation", { version: 1 });
  await seed.writeState("semantic-committed-namespace-v1", {
    version: 1, namespace: NAMESPACE, committedAt: 1,
  });
  const settings = {
    vaultInstanceId: VAULT_ID,
    embeddingsVectorFormatVersion: 8,
    embeddingsEnabled: true,
    embeddingsPortableIndex: false,
    embeddingsExclusions: { folders: [] as string[], patterns: [], ignoreChatHistory: false, respectObsidianExclusions: false },
    chatsDirectory: "Chats", savedChatsDirectory: "Saved Chats",
  };
  const vault = {
    adapter: null,
    getMarkdownFiles: jest.fn(() => files),
    getAbstractFileByPath: jest.fn((path: string) => files.find((note) => note.path === path) ?? null),
    read: jest.fn(async (_note: TFile) => "content"),
    cachedRead: jest.fn(async (_note: TFile) => "content"),
    on: jest.fn(() => ({})), offref: jest.fn(),
  };
  const gateway = (override ?? {
    activeGeneration: undefined,
    metadata: undefined,
    getMetadata: jest.fn(async () => undefined),
    query: jest.fn(), index: jest.fn(),
  }) as jest.Mocked<ManagedEmbeddingsIndexAdapter>;
  const updateSettings = jest.fn(async () => undefined);
  const plugin = {
    settings,
    getManagedCapabilityGraph: () => ({ embeddingsIndex: gateway }),
    getSettingsManager: () => ({ updateSettings }),
  };
  const manager = new EmbeddingsManager({ vault } as never, plugin as never);
  return { manager, seed, settings, vault, gateway, updateSettings, plugin };
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function jsonResponse(body: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return new Response(bytes, { status: 200, headers: {
    "content-type": "application/json", "cache-control": "no-store, max-age=0",
    "x-request-id": "test-request", "x-systemsculpt-embeddings-index-contract": MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    "x-systemsculpt-content-sha256": hash, "x-systemsculpt-content-size": String(bytes.byteLength),
  } });
}

function waitForSnapshot(manager: EmbeddingsManager, predicate: (snapshot: ReturnType<EmbeddingsManager["getLifecycleSnapshot"]>) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = manager.subscribeLifecycle((snapshot) => {
      if (!predicate(snapshot)) return;
      queueMicrotask(() => unsubscribe());
      resolve();
    });
  });
}

describe("EmbeddingsManager startup work (#343)", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => { jest.restoreAllMocks(); fake.restore(); });

  it("opens an unchanged enabled vault without metadata, content reads or settings writes", async () => {
    const { manager, seed, gateway, vault, updateSettings } = await harness([file()]);
    const process = jest.spyOn(manager, "processVault");

    await manager.initialize();
    await nextTask();

    expect(process).not.toHaveBeenCalled();
    expect(gateway.getMetadata).not.toHaveBeenCalled();
    expect(vault.read).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(manager.getFileIndexSnapshot("A.md")).toMatchObject({ ready: true });
    await manager.cleanup();
    seed.close();
  });

  it.each(["missing", "modified", "incomplete"])("still reconciles a %s note at startup", async (kind) => {
    const note = file();
    const stored = root(note);
    if (kind === "modified") note.stat.mtime = 2;
    if (kind === "incomplete") stored.metadata.complete = false;
    const { manager, seed } = await harness([note], kind === "missing" ? [] : [stored]);
    const process = jest.spyOn(manager, "processVault").mockResolvedValue({ status: "complete", processed: 0 });

    await manager.initialize();
    await nextTask();

    expect(process).toHaveBeenCalledTimes(1);
    await manager.cleanup();
    seed.close();
  });

  it("lists a note created 3 s after load at once, before any file event (#395)", async () => {
    // Obsidian Sync often delivers notes in the first seconds after load. The
    // vault's own list is the only source, so nothing waits for a 'create'
    // event or a cache refresh before the note counts.
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] });
    try {
      const files = [file()];
      const { manager, seed } = await harness(files);
      const process = jest.spyOn(manager, "processVault").mockResolvedValue({ status: "complete", processed: 0 });

      await jest.advanceTimersByTimeAsync(3_000);
      files.push(file("Synced.md", Date.now()));
      await manager.initialize();
      await jest.advanceTimersByTimeAsync(0);

      expect(process).toHaveBeenCalledTimes(1);
      expect(manager.getStats()).toMatchObject({ total: 2, needsProcessing: 1 });
      expect((await manager.listPendingFiles()).map((pending) => pending.path)).toEqual(["Synced.md"]);
      await manager.cleanup();
      seed.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not connect for empty notes or current local-empty markers", async () => {
    const blank = file("Blank.md", 1, 0);
    const noText = file("Frontmatter.md");
    const marker = createLocalEmptyEmbeddingMarkerForRevision({ path: noText.path, basename: noText.basename, mtime: 1 }, "hash");
    const { manager, seed, gateway } = await harness([blank, noText], [marker]);

    await manager.initialize();
    await nextTask();

    expect(gateway.getMetadata).not.toHaveBeenCalled();
    await manager.cleanup();
    seed.close();
  });

  it("removes old vectors when a note became empty while Obsidian was closed", async () => {
    const note = file();
    const stored = root(note);
    note.stat.size = 0;
    const { manager, seed } = await harness([note], [stored]);
    const process = jest.spyOn(manager, "processVault");

    await manager.initialize();
    await nextTask();
    await manager.cleanup();

    expect(process).toHaveBeenCalledTimes(1);
    expect(await seed.countVectors()).toBe(0);
    seed.close();
  });

  it("resumes persisted same-mtime work even when every stored root looks current", async () => {
    const { manager, seed, gateway } = await harness([file()]);
    await new SemanticWorkQueue(seed).enqueueImmediate("A.md", "modify", 1);
    const queued = jest.spyOn(manager as unknown as { scheduleQueuedWork(): void }, "scheduleQueuedWork")
      .mockImplementation(() => undefined);

    await manager.initialize();
    await nextTask();

    expect(queued).toHaveBeenCalled();
    expect(gateway.getMetadata).not.toHaveBeenCalled();
    expect(manager.getFileIndexSnapshot("A.md")).toMatchObject({ state: "pending" });
    await manager.cleanup();
    seed.close();
  });

  it("a query discovers a new server generation and requests reconciliation without exposing it as committed", async () => {
    const { manager, seed, gateway } = await harness([file()]);
    await manager.initialize();
    await nextTask();
    const process = jest.spyOn(manager, "processVault").mockResolvedValue({ status: "complete", processed: 0 });
    gateway.query.mockResolvedValue({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      generation: { id: "semantic-v2", indexSchemaVersion: 3, indexNamespace: NEXT_NAMESPACE, dimensions: 2 },
      vector: new Float32Array([1, 0]),
    });

    await expect(manager.searchSimilar("candidate")).resolves.toEqual([]);
    await nextTask();

    expect(process).toHaveBeenCalledTimes(1);
    expect(gateway.activeGeneration?.indexNamespace).toBe(NEXT_NAMESPACE);
    expect(manager.getFileIndexSnapshot("A.md").generation?.namespace).toBe(NAMESPACE);
    await manager.cleanup();
    seed.close();
  });

  it.each([
    { discovery: "query", failOne: false, contention: false },
    { discovery: "query", failOne: true, contention: false },
    { discovery: "queued edit", failOne: false, contention: false },
    { discovery: "queued edit", failOne: true, contention: false },
    { discovery: "queued edit", failOne: false, contention: true },
  ])("rebuilds a generation discovered by $discovery (failure: $failOne, contention: $contention)", async ({ discovery, failOne, contention }) => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const { manager, seed, gateway, vault } = await harness([file("A.md"), file("B.md")]);
    if (discovery === "queued edit") {
      await new SemanticWorkQueue(seed).enqueueImmediate("A.md", "modify", 1);
    }
    const generation = { id: "semantic-v2", indexSchemaVersion: 3, indexNamespace: NEXT_NAMESPACE, dimensions: 2 };
    gateway.query.mockResolvedValue({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      generation, vector: new Float32Array([1, 0]),
    });
    gateway.getMetadata.mockImplementation(async () => {
      gateway.metadata = {
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: { id: generation.id, indexSchemaVersion: 3, indexNamespaceTemplate: "systemsculpt:managed:semantic-v2:v3:<dimensions>" },
        limits: { maxSourceBytes: 1024, maxResultBytes: 1024 },
      };
      return gateway.metadata;
    });
    vault.read.mockImplementation(async (note: TFile) => note.path);
    vault.cachedRead.mockImplementation(async (note: TFile) => note.path);
    const { processingMutex } = manager as unknown as { processingMutex: Mutex };
    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const mutationHold = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationReady = new Promise<void>((resolve) => { mutationStarted = resolve; });
    gateway.index.mockImplementation(async ({ prepare }) => {
      const { markdown } = prepare();
      if (contention && markdown === "A.md") {
        // A concurrent delete/rename waits for indexing, then owns the mutex
        // before the queued run can request full-corpus reconciliation.
        void processingMutex.runExclusive(async () => {
          mutationStarted();
          await mutationHold;
        });
      }
      if (failOne && markdown === "B.md") throw new ManagedEmbeddingsError("temporarily_unavailable", "Unavailable", 503);
      const hash = createHash("sha256").update(markdown).digest("hex");
      gateway.activeGeneration = generation;
      return {
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        source: { contentSha256: hash }, empty: false,
        vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation,
        chunks: [{ ordinal: 0, textHash: hash, headingPath: [], excerpt: markdown, length: markdown.length, vector: new Float32Array([1, 0]) }],
      };
    });
    const process = manager.processVault.bind(manager);
    const completed = new Promise<EmbeddingsRunResult>((resolve, reject) => {
      jest.spyOn(manager, "processVault").mockImplementation((onProgress) => {
        const run = process(onProgress);
        void run.then(resolve, reject);
        return run;
      });
    });

    await manager.initialize();
    if (discovery === "query") {
      await expect(manager.searchSimilar("candidate")).resolves.toEqual([]);
    }
    if (contention) {
      await mutationReady;
      await nextTask();
      // Queued work now obtains metadata before dispatch; the full-corpus
      // reconciliation still waits for the contending mutation to finish.
      expect(gateway.getMetadata).toHaveBeenCalledTimes(1);
      releaseMutation();
    }
    const result = await completed;
    if (!failOne) expect(manager.getLifecycleSnapshot().lastError).toBeNull();
    const alreadyIndexed = discovery === "queued edit" ? 1 : 0;
    expect(result).toMatchObject({ status: "complete", processed: (failOne ? 1 : 2) - alreadyIndexed });

    expect(gateway.getMetadata).toHaveBeenCalledTimes(discovery === "queued edit" ? 2 : 1);
    expect(gateway.index).toHaveBeenCalledTimes(2);
    expect(manager.getFileIndexSnapshot("A.md").generation?.namespace).toBe(failOne ? NAMESPACE : NEXT_NAMESPACE);
    await manager.cleanup();
    seed.close();
  });

  it("retries the same note after a lost charged response across restart without skipping same-mtime edits", async () => {
    const notes = [file("A.md"), file("B.md")];
    const old = notes.map(root);
    for (const vector of old) vector.metadata.sourceSha256 = createHash("sha256").update("old").digest("hex");
    const keys: string[] = [];
    const charges = new Map<string, number>();
    const results = new Map<string, unknown>();
    let dropped = false;
    const request = jest.fn(async (input: { method: string; headers: Record<string, string>; body?: ArrayBuffer }) => {
      if (input.method === "GET") return jsonResponse({
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: { id: "semantic-v1", index_schema_version: 3, index_namespace_template: "systemsculpt:managed:semantic-v1:v3:<dimensions>" },
        limits: { max_source_bytes: 8 * 1024 * 1024, max_result_bytes: 16 * 1024 * 1024 },
      });
      const markdown = new TextDecoder().decode(input.body);
      const hash = createHash("sha256").update(markdown).digest("hex");
      const key = input.headers["Idempotency-Key"];
      keys.push(key);
      if (!results.has(key)) {
        charges.set(key, (charges.get(key) ?? 0) + 1);
        results.set(key, {
          contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT, source: { content_sha256: hash }, empty: false,
          vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
          generation: { id: "semantic-v1", index_schema_version: 3, index_namespace: NAMESPACE, dimensions: 2 },
          chunks: [{ ordinal: 0, text_hash: hash, heading_path: [], excerpt: markdown, length: markdown.length, vector_base64: "AACAPwAAAAA=" }],
        });
      }
      if (markdown === "new A" && !dropped) {
        dropped = true;
        throw new TypeError("connection lost after the fake server charged");
      }
      return jsonResponse(results.get(key));
    });
    const makeGateway = () => new ManagedEmbeddingsIndexAdapter(new HostedTransportAdapter({
      baseUrl: "https://example.invalid", pluginVersion: "6.18.5", licenseKey: () => "test",
      requestClient: { request } as never,
    }));
    const { manager, seed, vault, plugin } = await harness(notes, old, makeGateway());
    vault.read.mockImplementation(async (note) => `new ${note.basename}`);
    vault.cachedRead.mockImplementation(async (note) => `new ${note.basename}`);
    const queue = new SemanticWorkQueue(seed);
    await queue.enqueueManyImmediate(notes.map((note) => ({ path: note.path, sourceMtime: 1 })), "retry");
    const failed = waitForSnapshot(manager, (snapshot) => snapshot.phase === "error" && snapshot.failed === 1);

    await manager.initialize();
    await failed;
    expect(manager.getFileIndexSnapshot("B.md").ready).toBe(true);
    expect(manager.getFileIndexSnapshot("A.md").state).toBe("failed");
    await manager.cleanup();

    const restarted = new EmbeddingsManager({ vault } as never, {
      ...plugin, getManagedCapabilityGraph: () => ({ embeddingsIndex: makeGateway() }),
    } as never);
    const recovered = waitForSnapshot(restarted, (snapshot) => snapshot.ready && snapshot.phase === "idle" && snapshot.pending === 0);
    await restarted.initialize();
    await recovered;

    const aKey = `idx:${createHash("sha256").update("new A").digest("hex")}`;
    const bKey = `idx:${createHash("sha256").update("new B").digest("hex")}`;
    expect(keys.filter((key) => key === aKey)).toHaveLength(2);
    expect(keys.filter((key) => key === bKey)).toHaveLength(1);
    expect(charges.get(aKey)).toBe(1);
    expect(charges.get(bKey)).toBe(1);
    expect(restarted.getFileIndexSnapshot("A.md").ready).toBe(true);
    await restarted.cleanup();
    seed.close();
  });

  it("retains one durable note and idempotency key through repeated 429s and restart until Retry-After permits recovery", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] });
    const markdown = "Synthetic note awaiting admission.";
    const hash = createHash("sha256").update(markdown).digest("hex");
    const key = `idx:${hash}`;
    const keys: string[] = [];
    // Exceeds the generic managed-dispatch attempt count: index recovery must
    // keep the paid work pending rather than abandon it after a few failures.
    const failures = 6;
    const request = jest.fn(async (input: { method: string; headers: Record<string, string>; body?: ArrayBuffer }) => {
      if (input.method === "GET") return jsonResponse({
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: { id: "semantic-v1", index_schema_version: 3, index_namespace_template: "systemsculpt:managed:semantic-v1:v3:<dimensions>" },
        limits: { max_source_bytes: 8 * 1024 * 1024, max_result_bytes: 16 * 1024 * 1024 },
      });
      keys.push(input.headers["Idempotency-Key"]);
      expect(new TextDecoder().decode(input.body)).toBe(markdown);
      if (keys.length <= failures) return new Response(JSON.stringify({ error: {
        code: "rate_limited", message: "Indexing is busy. Try again soon.", retryable: true,
      } }), { status: 429, headers: {
        "content-type": "application/json", "x-request-id": `test-rate-limit-${keys.length}`,
        "retry-after": String(20 + keys.length * 10),
      } });
      return jsonResponse({
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT, source: { content_sha256: hash }, empty: false,
        vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: { id: "semantic-v1", index_schema_version: 3, index_namespace: NAMESPACE, dimensions: 2 },
        chunks: [{ ordinal: 0, text_hash: hash, heading_path: [], excerpt: markdown, length: markdown.length, vector_base64: "AACAPwAAAAA=" }],
      });
    });
    const makeGateway = () => new ManagedEmbeddingsIndexAdapter(new HostedTransportAdapter({
      baseUrl: "https://example.invalid", pluginVersion: "6.18.5", licenseKey: () => "test",
      requestClient: { request } as never,
    }));
    const { manager, seed, vault, plugin } = await harness([file()], [], makeGateway());
    let current = manager;
    vault.read.mockResolvedValue(markdown);
    vault.cachedRead.mockResolvedValue(markdown);
    let claim: { revision: number; requestedAt: number; sourceMtime: number | null } | undefined;
    try {
      const firstFailure = waitForSnapshot(current, (snapshot) => snapshot.phase === "error" && snapshot.failed === 1);
      await current.initialize();
      await firstFailure;
      await jest.advanceTimersByTimeAsync(0);

      for (let attempt = 1; attempt <= failures; attempt += 1) {
        const restored = new SemanticWorkQueue(seed);
        await restored.restore();
        const item = restored.get("A.md")!;
        claim ??= { revision: item.revision, requestedAt: item.requestedAt, sourceMtime: item.sourceMtime };
        expect(item).toMatchObject({
          ...claim, path: "A.md", attempts: attempt,
          failure: { code: "rate_limited", status: 429, retryable: true, retryInMs: (20 + attempt * 10) * 1_000 },
        });
        expect(restored.size).toBe(1);
        expect(current.getLifecycleSnapshot()).toMatchObject({ completed: 0, pending: 1, failed: 1 });
        expect(await seed.countVectors()).toBe(0);
        expect(keys).toHaveLength(attempt);
        expect(keys.every((sent) => sent === key)).toBe(true);

        if (attempt === 3) {
          await current.cleanup();
          current = new EmbeddingsManager({ vault } as never, {
            ...plugin, getManagedCapabilityGraph: () => ({ embeddingsIndex: makeGateway() }),
          } as never);
          await current.initialize();
          await jest.advanceTimersByTimeAsync(0);
        }
        const retryInMs = item.readyAt - Date.now();
        expect(retryInMs).toBe((20 + attempt * 10) * 1_000);
        await jest.advanceTimersByTimeAsync(retryInMs - 1);
        expect(keys).toHaveLength(attempt);
        expect(current.getLifecycleSnapshot()).toMatchObject({ completed: 0, pending: 1, failed: 1 });
        expect(await seed.countVectors()).toBe(0);

        const next = waitForSnapshot(current, (snapshot) => keys.length === attempt + 1 && (attempt === failures
          ? snapshot.phase === "idle" && snapshot.completed === 1 && snapshot.pending === 0 && snapshot.failed === 0
          : snapshot.phase === "error" && snapshot.failed === 1));
        await jest.advanceTimersByTimeAsync(1);
        await next;
        await jest.advanceTimersByTimeAsync(0);
      }

      expect(keys).toEqual(Array.from({ length: failures + 1 }, () => key));
      expect(current.getFileIndexSnapshot("A.md")).toMatchObject({ ready: true });
      expect(await seed.readState("semantic-work-v1")).toBeNull();
      expect(await seed.countVectors()).toBe(1);
    } finally {
      await current.cleanup();
      seed.close();
      jest.useRealTimers();
    }
  });

  it("retries a temporary metadata failure through the durable queue", async () => {
    const note = file();
    const { manager, seed, gateway, vault } = await harness([note], []);
    let firstMetadata!: () => void;
    const attempted = new Promise<void>((resolve) => { firstMetadata = resolve; });
    gateway.getMetadata.mockImplementationOnce(async () => {
      firstMetadata();
      throw new ManagedEmbeddingsError("temporarily_unavailable", "Try again.", 503, null, true);
    });
    gateway.getMetadata.mockResolvedValue(undefined as never);
    gateway.index.mockImplementation(async ({ prepare }) => {
      const markdown = prepare().markdown;
      const hash = createHash("sha256").update(markdown).digest("hex");
      return {
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT, source: { contentSha256: hash }, empty: false,
        vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: { id: "semantic-v1", indexSchemaVersion: 3, indexNamespace: NAMESPACE, dimensions: 2 },
        chunks: [{ ordinal: 0, textHash: hash, headingPath: [], excerpt: markdown, length: markdown.length, vector: new Float32Array([1, 0]) }],
      };
    });
    const done = waitForSnapshot(manager, (snapshot) => snapshot.ready && snapshot.phase === "idle" && snapshot.pending === 0);
    await manager.initialize();
    await attempted;
    await done;
    expect(gateway.getMetadata).toHaveBeenCalledTimes(2);
    expect(vault.read).toHaveBeenCalledTimes(1);
    expect(manager.getFileIndexSnapshot(note.path).ready).toBe(true);
    await manager.cleanup();
    seed.close();
  });

  it("aborts a pending metadata request on cleanup without uploading notes", async () => {
    const { manager, seed, gateway } = await harness([file()], []);
    let requestStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { requestStarted = resolve; });
    gateway.getMetadata.mockImplementation((signal) => new Promise((_resolve, reject) => {
      requestStarted(signal!);
      signal!.addEventListener("abort", () => reject(new ManagedEmbeddingsError("request_cancelled", "Stopped.", 0)));
    }));
    await manager.initialize();
    const signal = await started;
    await manager.cleanup();
    expect(signal.aborted).toBe(true);
    expect(gateway.index).not.toHaveBeenCalled();
    seed.close();
  });

  it("does not start automatic reconciliation on a generation change while indexing is disabled", async () => {
    const { manager, seed, gateway, settings } = await harness([file()]);
    settings.embeddingsEnabled = false;
    await manager.initialize();
    const process = jest.spyOn(manager, "processVault");
    gateway.query.mockResolvedValue({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      generation: { id: "semantic-v2", indexSchemaVersion: 3, indexNamespace: NEXT_NAMESPACE, dimensions: 2 },
      vector: new Float32Array([1, 0]),
    });

    await expect(manager.searchSimilar("candidate")).resolves.toEqual([]);
    await nextTask();

    expect(process).not.toHaveBeenCalled();
    await manager.cleanup();
    seed.close();
  });
});
