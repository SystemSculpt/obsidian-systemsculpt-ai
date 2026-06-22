import { EmbeddingsProcessor } from "../embeddings/processing/EmbeddingsProcessor";
import { ContentPreprocessor } from "../embeddings/processing/ContentPreprocessor";
import { EmbeddingsProviderError } from "../embeddings/providers/ProviderError";

/**
 * #127 / #150: a 429 used to cancel the whole embedding run on the first hit
 * (handleBatchError treats RATE_LIMITED as a global-backoff stop). The provider
 * call is now wrapped in withProviderRetry, so a transient rate limit is retried
 * with backoff before it can reach that stop logic.
 */
function makeProcessor(provider: any) {
  const storage = {
    storeVectors: jest.fn(),
    getVectorSync: jest.fn(),
    removeByPathExceptIds: jest.fn(),
  } as any;

  return new EmbeddingsProcessor(provider, storage, new ContentPreprocessor(), {
    batchSize: 1,
    maxConcurrency: 1,
    // Instant, deterministic retries — no real timers in the test.
    retryDeps: { sleep: jest.fn(async () => undefined), random: () => 1, onRetry: jest.fn() },
  });
}

const batch = [
  { file: { path: "a.md" } as any, content: "hello", hash: "h", chunkId: 0, length: 5 },
];

describe("EmbeddingsProcessor retry wiring (#127/#150)", () => {
  it("retries a transient 429 and returns the embeddings instead of stopping", async () => {
    const provider = {
      id: "custom",
      getMaxBatchSize: () => 25,
      generateEmbeddings: jest
        .fn()
        .mockRejectedValueOnce(
          new EmbeddingsProviderError("rate limited", {
            code: "RATE_LIMITED",
            transient: true,
            retryInMs: 5,
            providerId: "custom",
          })
        )
        .mockResolvedValueOnce([[0.1, 0.2, 0.3]]),
    } as any;

    const processor = makeProcessor(provider);
    const result = await (processor as any).generateEmbeddingsWithHtmlForbiddenIsolation(
      batch,
      ["hello"],
      { batchIndex: 0 }
    );

    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent (non-transient) error", async () => {
    const provider = {
      id: "custom",
      getMaxBatchSize: () => 25,
      generateEmbeddings: jest.fn().mockRejectedValue(
        new EmbeddingsProviderError("bad request", {
          code: "HTTP_ERROR",
          transient: false,
          status: 400,
          providerId: "custom",
        })
      ),
    } as any;

    const processor = makeProcessor(provider);

    await expect(
      (processor as any).generateEmbeddingsWithHtmlForbiddenIsolation(batch, ["hello"], {
        batchIndex: 0,
      })
    ).rejects.toMatchObject({ code: "HTTP_ERROR" });
    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(1);
  });
});
