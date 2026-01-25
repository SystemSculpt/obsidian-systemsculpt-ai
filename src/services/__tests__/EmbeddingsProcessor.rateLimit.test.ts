import { EmbeddingsProcessor } from "../embeddings/processing/EmbeddingsProcessor";
import { ContentPreprocessor } from "../embeddings/processing/ContentPreprocessor";

describe("EmbeddingsProcessor rate limiting", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-12-14T00:00:00Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("paces provider calls to avoid bursty traffic", async () => {
    const provider = {
      id: "systemsculpt",
      getMaxBatchSize: () => 25,
      generateEmbeddings: jest.fn(),
    } as any;

    const storage = {
      storeVectors: jest.fn(),
      getVectorSync: jest.fn(),
      removeByPathExceptIds: jest.fn(),
    } as any;

    const processor = new EmbeddingsProcessor(
      provider,
      storage,
      new ContentPreprocessor(),
      { batchSize: 1, maxConcurrency: 1, rateLimitPerMinute: 60 } // 1 request/sec
    );

    await (processor as any).enforceRateLimit();

    let secondResolved = false;
    const second = (processor as any).enforceRateLimit().then(() => {
      secondResolved = true;
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(secondResolved).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await second;
    expect(secondResolved).toBe(true);
  });
});

