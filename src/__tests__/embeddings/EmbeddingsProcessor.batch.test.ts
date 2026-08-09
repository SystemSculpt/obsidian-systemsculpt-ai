jest.mock("../../utils/errorLogger", () => ({
  errorLogger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  ManagedEmbeddingsError,
  type ManagedEmbeddingsIndexResult,
} from "../../services/embeddings/gateway/ManagedEmbeddingsIndexAdapter";
import { EmbeddingsProcessor } from "../../services/embeddings/processing/EmbeddingsProcessor";
import { buildVectorId } from "../../services/embeddings/utils/vectorId";

const SOURCE_HASH = "a".repeat(64);
const TEXT_HASH = "b".repeat(64);

function indexedResult(options: {
  generationId?: string;
  schema?: number;
  dimensions?: number;
  chunks?: number;
  empty?: boolean;
} = {}): ManagedEmbeddingsIndexResult {
  if (options.empty) {
    return {
      contract: "managed-embeddings-index-v1",
      source: { contentSha256: SOURCE_HASH },
      empty: true,
      vectorEncoding: "float32-le-base64",
      generation: null,
      chunks: [],
    };
  }
  const generationId = options.generationId ?? "semantic-v1";
  const schema = options.schema ?? 3;
  const dimensions = options.dimensions ?? 3;
  const namespace = `systemsculpt:managed:${generationId}:v${schema}:${dimensions}`;
  return {
    contract: "managed-embeddings-index-v1",
    source: { contentSha256: SOURCE_HASH },
    empty: false,
    vectorEncoding: "float32-le-base64",
    generation: {
      id: generationId,
      indexSchemaVersion: schema,
      indexNamespace: namespace,
      dimensions,
    },
    chunks: Array.from({ length: options.chunks ?? 2 }, (_, ordinal) => ({
      ordinal,
      textHash: ordinal === 0 ? TEXT_HASH : "c".repeat(64),
      headingPath: ordinal === 0 ? ["Heading"] : [],
      excerpt: `Chunk ${ordinal}`,
      length: 20 + ordinal,
      vector: dimensions === 3
        ? new Float32Array(ordinal === 0 ? [1, 0, 0] : [0, 1, 0])
        : new Float32Array(Array.from({ length: dimensions }, (_, index) => index === ordinal ? 1 : 0)),
    })),
  };
}

function fixture(result = indexedResult()) {
  const index = jest.fn(async (operation: { prepare: () => { markdown: string } }) => {
    operation.prepare();
    return result;
  });
  const storage = {
    publishPath: jest.fn(async () => undefined),
    replacePath: jest.fn(async () => undefined),
  };
  const processor = new EmbeddingsProcessor({ index } as never, storage as never);
  const file = {
    path: "Note.md",
    basename: "Note",
    stat: { mtime: 123, size: 20 },
  };
  let content = "# Heading\n\nPrivate note";
  const app = { vault: { read: jest.fn(async () => content) } };
  return {
    app,
    file,
    index,
    processor,
    storage,
    setContent(value: string) {
      content = value;
    },
  };
}

describe("EmbeddingsProcessor server indexing", () => {
  it("sends one raw note request and atomically publishes all returned chunks", async () => {
    const state = fixture(indexedResult({ chunks: 2 }));

    const processed = await state.processor.processFiles(
      [state.file] as never,
      state.app as never,
    );

    expect(processed).toMatchObject({
      completed: 1,
      completedPaths: ["Note.md"],
      failed: 0,
      cancelled: false,
      generation: {
        id: "semantic-v1",
        indexSchemaVersion: 3,
        indexNamespace: "systemsculpt:managed:semantic-v1:v3:3",
      },
    });
    expect(state.index).toHaveBeenCalledTimes(1);
    expect(state.index.mock.calls[0][0].prepare()).toEqual({
      markdown: "# Heading\n\nPrivate note",
    });
    expect(state.storage.publishPath).toHaveBeenCalledTimes(1);
    const [path, namespace, vectors] = state.storage.publishPath.mock.calls[0];
    expect(path).toBe("Note.md");
    expect(namespace).toBe("systemsculpt:managed:semantic-v1:v3:3");
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toMatchObject({
      id: buildVectorId(namespace, "Note.md", 0),
      path: "Note.md",
      chunkId: 0,
      metadata: {
        title: "Note",
        contentHash: TEXT_HASH,
        generation: "semantic-v1",
        namespace,
        complete: true,
        partial: false,
        chunkCount: 2,
      },
    });
    expect(vectors[1].metadata.complete).toBeUndefined();
  });

  it("dispatches exactly once per note and continues after an isolated failure", async () => {
    const state = fixture();
    const failed = { path: "Failed.md", basename: "Failed", stat: { mtime: 1 } };
    const healthy = { path: "Healthy.md", basename: "Healthy", stat: { mtime: 2 } };
    state.app.vault.read.mockImplementation(async (file: { path: string }) => (
      file.path === "Failed.md" ? "failed" : "healthy"
    ));
    state.index
      .mockRejectedValueOnce(new ManagedEmbeddingsError("rate_limited", "Try later.", 429))
      .mockResolvedValueOnce(indexedResult({ chunks: 1 }));

    const processed = await state.processor.processFiles(
      [failed, healthy] as never,
      state.app as never,
    );

    expect(state.index).toHaveBeenCalledTimes(2);
    expect(processed).toMatchObject({
      completed: 1,
      completedPaths: ["Healthy.md"],
      failed: 1,
      failedPaths: ["Failed.md"],
      failedDetails: {
        "Failed.md": { code: "rate_limited", status: 429 },
      },
    });
    expect(state.storage.publishPath).toHaveBeenCalledTimes(1);
    expect(state.storage.publishPath).toHaveBeenCalledWith(
      "Healthy.md",
      "systemsculpt:managed:semantic-v1:v3:3",
      expect.any(Array),
    );
  });

  it("stops on an authoritative zero-balance preflight before reading or uploading a note", async () => {
    const state = fixture();
    const failure = new ManagedEmbeddingsError(
      "payment_required",
      "You have no credits left. Add credits to continue indexing notes.",
      402,
    );
    const preflight = jest.fn().mockRejectedValue(failure);

    const processed = await state.processor.processFiles(
      [state.file] as never,
      state.app as never,
      undefined,
      { preflight },
    );

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(state.app.vault.read).not.toHaveBeenCalled();
    expect(state.index).not.toHaveBeenCalled();
    expect(processed).toMatchObject({
      completed: 0,
      failed: 1,
      failedPaths: ["Note.md"],
      fatalError: failure,
    });
  });

  it("stops the vault run after one out-of-credits response", async () => {
    const state = fixture();
    const first = { path: "First.md", basename: "First", stat: { mtime: 1 } };
    const remaining = { path: "Remaining.md", basename: "Remaining", stat: { mtime: 2 } };
    const failure = new ManagedEmbeddingsError(
      "payment_required",
      "You have no credits left. Add credits to continue indexing notes.",
      402,
      "request-credits-1",
    );
    state.index.mockRejectedValueOnce(failure);

    const processed = await state.processor.processFiles(
      [first, remaining] as never,
      state.app as never,
    );

    expect(state.index).toHaveBeenCalledTimes(1);
    expect(processed).toMatchObject({
      completed: 0,
      failed: 1,
      failedPaths: ["First.md"],
      fatalError: failure,
      failedDetails: {
        "First.md": {
          code: "payment_required",
          status: 402,
          requestId: "request-credits-1",
        },
      },
    });
  });

  it("atomically replaces every prior generation with a local empty marker", async () => {
    const state = fixture(indexedResult({ empty: true }));

    const processed = await state.processor.processFiles(
      [state.file] as never,
      state.app as never,
    );

    expect(processed).toMatchObject({ completed: 1, failed: 0 });
    expect(state.storage.publishPath).not.toHaveBeenCalled();
    expect(state.storage.replacePath).toHaveBeenCalledWith("Note.md", [
      expect.objectContaining({
        path: "Note.md",
        metadata: expect.objectContaining({
          isEmpty: true,
          complete: true,
          chunkCount: 0,
        }),
      }),
    ]);
  });

  it("accepts a validated dynamic generation without rewriting its namespace", async () => {
    const state = fixture(indexedResult({
      generationId: "semantic-v2.1",
      schema: 17,
      dimensions: 2,
      chunks: 1,
    }));

    const processed = await state.processor.processFiles(
      [state.file] as never,
      state.app as never,
    );

    expect(processed.generation).toEqual({
      id: "semantic-v2.1",
      indexSchemaVersion: 17,
      indexNamespace: "systemsculpt:managed:semantic-v2.1:v17:2",
      dimensions: 2,
    });
    expect(state.storage.publishPath).toHaveBeenCalledWith(
      "Note.md",
      "systemsculpt:managed:semantic-v2.1:v17:2",
      expect.any(Array),
    );
  });

  it("suppresses an already-dispatched result after local cancellation", async () => {
    const state = fixture();
    let release!: (result: ManagedEmbeddingsIndexResult) => void;
    state.index.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const processing = state.processor.processFiles(
      [state.file] as never,
      state.app as never,
    );
    for (let attempt = 0; attempt < 20 && !release; attempt += 1) await Promise.resolve();
    state.processor.cancel();
    release(indexedResult());
    const processed = await processing;

    expect(processed).toMatchObject({
      completed: 0,
      failed: 0,
      cancelled: true,
      failedPaths: [],
    });
    expect(state.storage.publishPath).not.toHaveBeenCalled();
  });

  it("rejects a stale source revision without publishing old vectors", async () => {
    const state = fixture();
    let release!: (result: ManagedEmbeddingsIndexResult) => void;
    state.index.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const processing = state.processor.processFiles(
      [state.file] as never,
      state.app as never,
      undefined,
      {
        sourceRevisions: new Map([[
          state.file as never,
          { path: "Note.md", basename: "Note", mtime: 123 },
        ]]),
      },
    );
    for (let attempt = 0; attempt < 20 && !release; attempt += 1) await Promise.resolve();
    state.file.stat.mtime = 124;
    state.setContent("New content");
    release(indexedResult());
    const processed = await processing;

    expect(processed).toMatchObject({
      completed: 0,
      failed: 1,
      failedPaths: ["Note.md"],
      failedDetails: {
        "Note.md": { code: "source_changed", status: 0 },
      },
    });
    expect(state.storage.publishPath).not.toHaveBeenCalled();
    expect(state.storage.replacePath).not.toHaveBeenCalled();
  });

  it("records invalid server output without deleting a previously committed path", async () => {
    const state = fixture();
    state.index.mockRejectedValueOnce(new ManagedEmbeddingsError(
      "invalid_response",
      "Managed embedding index returned an invalid response.",
      200,
    ));

    const processed = await state.processor.processFiles(
      [state.file] as never,
      state.app as never,
    );

    expect(processed.failedDetails?.["Note.md"]).toMatchObject({
      code: "invalid_response",
      status: 200,
    });
    expect(state.storage.publishPath).not.toHaveBeenCalled();
    expect(state.storage.replacePath).not.toHaveBeenCalled();
  });
});
