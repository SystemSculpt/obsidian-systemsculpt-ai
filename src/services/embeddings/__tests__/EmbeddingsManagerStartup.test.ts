import { createHash } from "node:crypto";
import type { Mutex } from "async-mutex";
import { TFile } from "obsidian";
import { EmbeddingsManager, type EmbeddingsRunResult } from "../EmbeddingsManager";
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
  type ManagedEmbeddingsIndexAdapter,
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

async function harness(files: TFile[], records = files.map(root)) {
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
  const gateway = {
    activeGeneration: undefined,
    metadata: undefined,
    getMetadata: jest.fn(async () => undefined),
    query: jest.fn(), index: jest.fn(),
  } as unknown as jest.Mocked<ManagedEmbeddingsIndexAdapter>;
  const updateSettings = jest.fn(async () => undefined);
  const plugin = {
    settings,
    getManagedCapabilityGraph: () => ({ embeddingsIndex: gateway }),
    getSettingsManager: () => ({ updateSettings }),
  };
  const manager = new EmbeddingsManager({ vault } as never, plugin as never);
  return { manager, seed, settings, vault, gateway, updateSettings };
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
      expect(gateway.getMetadata).not.toHaveBeenCalled();
      releaseMutation();
    }
    const result = await completed;
    if (!failOne) expect(manager.getLifecycleSnapshot().lastError).toBeNull();
    const alreadyIndexed = discovery === "queued edit" ? 1 : 0;
    expect(result).toMatchObject({ status: "complete", processed: (failOne ? 1 : 2) - alreadyIndexed });

    expect(gateway.getMetadata).toHaveBeenCalledTimes(1);
    expect(gateway.index).toHaveBeenCalledTimes(2);
    expect(manager.getFileIndexSnapshot("A.md").generation?.namespace).toBe(failOne ? NAMESPACE : NEXT_NAMESPACE);
    await manager.cleanup();
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
