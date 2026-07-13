jest.mock("../../utils/errorLogger", () => ({
  errorLogger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { EmbeddingsProcessor } from "../../services/embeddings/processing/EmbeddingsProcessor";
import { ManagedEmbeddingsError } from "../../services/embeddings/providers/ManagedEmbeddingsAdapter";
import type { EmbeddingsProvider } from "../../services/embeddings/types";
import { buildManagedNamespace } from "../../services/embeddings/utils/namespace";
import { buildVectorId } from "../../services/embeddings/utils/vectorId";

function fixture(options: { chunks?: number; batchSize?: number; chunkText?: string } = {}) {
  const chunkCount = options.chunks ?? 60;
  const provider: EmbeddingsProvider = {
    id: "systemsculpt",
    model: "managed",
    activeNamespace: buildManagedNamespace(3),
    expectedDimension: 3,
    generateEmbeddings: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
  const storage = {
    storeVectors: jest.fn(async () => undefined),
    removeByPathExceptIds: jest.fn(async () => undefined),
    getVectorSync: jest.fn(() => null),
    getVectorsByPath: jest.fn(async () => []),
    moveVectorId: jest.fn(async () => undefined),
    removeIds: jest.fn(async () => undefined),
    removeByPath: jest.fn(async () => undefined),
  };
  const preprocessor = {
    process: jest.fn(() => ({ content: "processed", source: "processed", hash: "doc", length: 1000 })),
    chunkContentWithHashes: jest.fn(() => Array.from({ length: chunkCount }, (_, index) => ({
      index,
      text: options.chunkText ?? `Chunk ${index} content`,
      hash: `hash-${index}`,
      headingPath: [],
      length: 200,
    }))),
  };
  const processor = new EmbeddingsProcessor(provider, storage as never, preprocessor as never, {
    batchSize: options.batchSize ?? 20,
    maxConcurrency: 1,
  });
  const file = { path: "Note.md", basename: "Note", stat: { mtime: 123 } };
  const app = { vault: { read: jest.fn(async () => "dummy") } };
  return { provider, storage, processor, file, app };
}

describe("EmbeddingsProcessor managed batching", () => {
  it("uses the managed operational batch size, stable order, deterministic ids, and unique dispatch keys", async () => {
    const { provider, storage, processor, file, app } = fixture();

    const result = await processor.processFiles([file] as never, app as never);

    expect(result).toMatchObject({ completed: 1, failed: 0, cancelled: false, fatalError: null });
    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(3);
    const calls = (provider.generateEmbeddings as jest.Mock).mock.calls;
    expect(calls.map((call) => call[0].length)).toEqual([20, 20, 20]);
    expect(calls.flatMap((call) => call[0])).toEqual(
      Array.from({ length: 60 }, (_, index) => `Chunk ${index} content`),
    );
    const keys = calls.map((call) => call[1].idempotencyKey);
    expect(new Set(keys).size).toBe(3);

    const namespace = buildManagedNamespace(3);
    expect(storage.removeByPathExceptIds).toHaveBeenCalledWith("Note.md", namespace, expect.any(Set));
    const keepIds = storage.removeByPathExceptIds.mock.calls[0][2] as Set<string>;
    expect(keepIds).toContain(buildVectorId(namespace, "Note.md", 0));
    expect(keepIds).toContain(buildVectorId(namespace, "Note.md", 59));
  });

  it("batches solely by processor config", async () => {
    const { provider, processor, file, app } = fixture({ chunks: 15, batchSize: 7 });

    await processor.processFiles([file] as never, app as never);

    const calls = (provider.generateEmbeddings as jest.Mock).mock.calls;
    expect(calls.map((call) => call[0].length)).toEqual([7, 7, 1]);
  });

  it("sends prepared chunks verbatim without client token-limit truncation", async () => {
    const preparedChunk = "vault-content:" + "x".repeat(40_000) + ":complete";
    const { provider, processor, file, app } = fixture({ chunks: 1, chunkText: preparedChunk });

    await processor.processFiles([file] as never, app as never);

    expect(provider.generateEmbeddings).toHaveBeenCalledWith(
      [preparedChunk],
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("stops after one failed managed dispatch and records the file failure", async () => {
    const { provider, processor, file, app } = fixture({ chunks: 10, batchSize: 5 });
    const failure = new ManagedEmbeddingsError("rate_limited", "Managed embeddings request failed.", 429);
    (provider.generateEmbeddings as jest.Mock).mockRejectedValue(failure);

    const result = await processor.processFiles([file] as never, app as never);

    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(result.fatalError).toBe(failure);
    expect(result.failedPaths).toEqual(["Note.md"]);
    expect(result.failedDetails?.["Note.md"]).toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("seals normalized-empty content locally without a remote dispatch", async () => {
    const { storage, processor, file, app } = fixture({ chunks: 0 });

    const result = await processor.processFiles([file] as never, app as never);

    expect(result).toMatchObject({ completed: 1, failed: 0 });
    expect(storage.removeByPath).toHaveBeenCalledWith("Note.md");
    expect(storage.storeVectors).toHaveBeenCalledWith([
      expect.objectContaining({
        path: "Note.md",
        vector: expect.any(Float32Array),
        metadata: expect.objectContaining({ isEmpty: true, complete: true, chunkCount: 0 }),
      }),
    ]);
    expect(storage.storeVectors.mock.calls[0][0][0].vector).toHaveLength(1);
    expect(storage.removeByPathExceptIds).not.toHaveBeenCalled();
  });

  it("records a file preparation failure and aborts rather than reporting success", async () => {
    const { processor, file, app } = fixture({ chunks: 1 });
    app.vault.read.mockRejectedValueOnce(new Error("disk read failed"));

    const result = await processor.processFiles([file] as never, app as never);

    expect(result).toMatchObject({
      completed: 0,
      failed: 1,
      cancelled: true,
      failedPaths: ["Note.md"],
      fatalError: { code: "local_preparation_failed", status: 0 },
    });
  });

  it("suppresses an already-dispatched result after local cancellation without claiming a transport cancellation", async () => {
    const { provider, processor, file, app } = fixture({ chunks: 1 });
    let release: ((vectors: number[][]) => void) | undefined;
    (provider.generateEmbeddings as jest.Mock).mockImplementation(() => new Promise<number[][]>((resolve) => {
      release = resolve;
    }));

    const processing = processor.processFiles([file] as never, app as never);
    await Promise.resolve();
    await Promise.resolve();
    processor.cancel();
    release?.([[0.1, 0.2, 0.3]]);
    const result = await processing;

    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ cancelled: true, fatalError: null, failedPaths: [] });
  });
});
