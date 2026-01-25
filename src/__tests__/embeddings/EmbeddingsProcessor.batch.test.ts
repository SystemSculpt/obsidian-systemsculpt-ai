import { EmbeddingsProcessor } from "../../services/embeddings/processing/EmbeddingsProcessor";
import type { EmbeddingsProvider } from "../../services/embeddings/types";
import { EmbeddingsProviderError } from "../../services/embeddings/providers/ProviderError";
import { buildNamespace } from "../../services/embeddings/utils/namespace";
import { buildVectorId } from "../../services/embeddings/utils/vectorId";

describe("EmbeddingsProcessor batching", () => {
  const createChunks = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      index,
      text: `Chunk ${index} content`,
      hash: `hash-${index}`,
      headingPath: [] as string[],
      length: 200,
    }));

  const createFile = (path: string) =>
    ({
      path,
      basename: path.replace(/\.md$/, ""),
      stat: { mtime: Date.now() },
    } as any);

  const createApp = () =>
    ({
      vault: {
        read: jest.fn(async () => "dummy"),
      },
    } as any);

  const createProcessor = (options?: { chunkCount?: number; providerLimit?: number; maxConcurrency?: number }) => {
    const chunkCount = options?.chunkCount ?? 60;
    const providerLimit = options?.providerLimit ?? 25;
    const maxConcurrency = options?.maxConcurrency ?? 2;

    const provider: EmbeddingsProvider = {
      id: "test",
      name: "Test Provider",
      supportsModels: false,
      generateEmbeddings: jest.fn(async (texts: string[]) =>
        texts.map(() => Array.from({ length: 3 }, () => 0.1))
      ),
      validateConfiguration: jest.fn(async () => true),
      getMaxBatchSize: jest.fn(() => providerLimit),
    };

    const storage = {
      storeVectors: jest.fn(async () => undefined),
      removeByPathExceptHashes: jest.fn(async () => undefined),
      removeByPathExceptIds: jest.fn(async () => undefined),
      getVectorSync: jest.fn(() => null),
      getVectorsByPath: jest.fn(async () => []),
    };

    const chunks = createChunks(chunkCount);

    const preprocessor = {
      process: jest.fn(() => ({
        content: "processed",
        source: "processed",
        hash: "doc-hash",
        length: 1000,
      })),
      chunkContentWithHashes: jest.fn(() => chunks),
    };

    const processor = new EmbeddingsProcessor(
      provider,
      storage as any,
      preprocessor as any,
      {
        batchSize: 64,
        maxConcurrency,
      }
    );

    return {
      provider,
      storage,
      preprocessor,
      processor,
      chunks,
    };
  };

  it("splits batches to respect the provider limit for single-file updates", async () => {
    const { processor, provider, storage } = createProcessor({ chunkCount: 60, providerLimit: 25 });
    const file = createFile("Note.md");
    const app = createApp();

    await processor.processFiles([file], app);

    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(3);
    for (const call of (provider.generateEmbeddings as jest.Mock).mock.calls) {
      const texts = call[0] as string[];
      expect(texts.length).toBeLessThanOrEqual(25);
    }

    const namespace = buildNamespace("test", "unknown", 3);

    expect(storage.removeByPathExceptIds).toHaveBeenCalledWith("Note.md", namespace, expect.any(Set));
    const keepIds = Array.from(
      (storage.removeByPathExceptIds as jest.Mock).mock.calls[0][2] as Set<string>
    );
    expect(keepIds).toHaveLength(60);
    expect(keepIds).toContain(buildVectorId(namespace, "Note.md", 0));
    expect(keepIds).toContain(buildVectorId(namespace, "Note.md", 59));
  });

  it("truncates incoming batch size when provider advertises a smaller cap", async () => {
    const { processor, provider } = createProcessor({ chunkCount: 10, providerLimit: 5 });
    const file = createFile("Small.md");
    const app = createApp();

    await processor.processFiles([file], app);

    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(2);
    for (const call of (provider.generateEmbeddings as jest.Mock).mock.calls) {
      const texts = call[0] as string[];
      expect(texts.length).toBeLessThanOrEqual(5);
    }
  });

  it("propagates provider failures and cancels outstanding batches", async () => {
    const { processor, provider } = createProcessor({ chunkCount: 10, providerLimit: 5, maxConcurrency: 1 });
    const fatalError = new EmbeddingsProviderError("gateway blocked", {
      code: "HOST_UNAVAILABLE",
      status: 403,
    });
    (provider.generateEmbeddings as jest.Mock).mockRejectedValueOnce(fatalError);

    const file = createFile("Broken.md");
    const app = createApp();

    const result = await processor.processFiles([file], app);
    expect(result.fatalError).toMatchObject({
      code: "HOST_UNAVAILABLE",
      status: 403,
    });

    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on transient provider cooldown/rate-limit errors instead of spamming retries", async () => {
    const { processor, provider } = createProcessor({ chunkCount: 60, providerLimit: 5, maxConcurrency: 1 });
    const cooldownError = new EmbeddingsProviderError("cooldown", {
      code: "HOST_UNAVAILABLE",
      status: 403,
      transient: true,
      retryInMs: 110_000,
    });
    (provider.generateEmbeddings as jest.Mock).mockRejectedValue(cooldownError);

    const file = createFile("Blocked.md");
    const app = createApp();

    const result = await processor.processFiles([file], app);

    expect(provider.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(result.fatalError).toBe(cooldownError);
    expect(result.failedPaths).toEqual([]);
  });

  it("isolates HTML 403 blocks to the offending chunk and continues embedding others", async () => {
    const marker = "E2E_WAF_BLOCK";

    const provider: EmbeddingsProvider = {
      id: "test",
      name: "Test Provider",
      supportsModels: false,
      validateConfiguration: jest.fn(async () => true),
      getMaxBatchSize: jest.fn(() => 25),
      generateEmbeddings: jest.fn(async (texts: string[]) => {
        if (texts.some((t) => t.includes(marker))) {
          throw new EmbeddingsProviderError("API error 403: Received HTML (HTTP 403) instead of JSON", {
            code: "HOST_UNAVAILABLE",
            status: 403,
            transient: true,
            details: { kind: "html-response", sample: "<html>forbidden</html>" },
            providerId: "test",
          });
        }
        return texts.map(() => [0.1, 0.2, 0.3]);
      }),
    };

    const storage = {
      storeVectors: jest.fn(async () => undefined),
      removeByPathExceptHashes: jest.fn(async () => undefined),
      removeByPathExceptIds: jest.fn(async () => undefined),
      getVectorSync: jest.fn(() => null),
      getVectorsByPath: jest.fn(async () => []),
    };

    const preprocessor = {
      process: jest.fn((content: string) => ({
        content,
        source: content,
        hash: `doc-hash-${content.includes(marker) ? "blocked" : "safe"}`,
        length: content.length,
      })),
      chunkContentWithHashes: jest.fn((content: string) => [
        { index: 0, text: content, hash: `chunk-hash-${content.includes(marker) ? "blocked" : "safe"}`, headingPath: [], length: content.length },
      ]),
    };

    const processor = new EmbeddingsProcessor(provider, storage as any, preprocessor as any, { batchSize: 25, maxConcurrency: 1 });

    const contentsByPath: Record<string, string> = {
      "Safe.md": `This is safe content and should embed successfully. ${"x".repeat(200)}`,
      "Blocked.md": `This contains a WAF marker ${marker} and should be isolated. ${"y".repeat(200)}`,
    };

    const app = {
      vault: {
        read: jest.fn(async (file: any) => contentsByPath[file.path]),
      },
    } as any;

    const safeFile = createFile("Safe.md");
    const blockedFile = createFile("Blocked.md");

    const result = await processor.processFiles([safeFile, blockedFile], app);

    expect(result.fatalError).toBeNull();
    expect(result.failedPaths).toContain("Blocked.md");
    expect(result.failedPaths).not.toContain("Safe.md");

    const stored = (storage.storeVectors as jest.Mock).mock.calls.flatMap((call) => call[0] as any[]);
    expect(stored.some((v) => v.path === "Safe.md")).toBe(true);
    expect(stored.some((v) => v.path === "Blocked.md")).toBe(false);
  });

  it("marks a file incomplete when any chunk is skipped due to HTML 403 blocks", async () => {
    const marker = "E2E_WAF_BLOCK";

    const provider: EmbeddingsProvider = {
      id: "test",
      name: "Test Provider",
      supportsModels: false,
      validateConfiguration: jest.fn(async () => true),
      getMaxBatchSize: jest.fn(() => 25),
      generateEmbeddings: jest.fn(async (texts: string[]) => {
        if (texts.some((t) => t.includes(marker))) {
          throw new EmbeddingsProviderError("API error 403: Received HTML (HTTP 403) instead of JSON", {
            code: "HOST_UNAVAILABLE",
            status: 403,
            transient: true,
            details: { kind: "html-response", sample: "<html>forbidden</html>" },
            providerId: "test",
          });
        }
        return texts.map(() => [0.1, 0.2, 0.3]);
      }),
    };

    const vectorsById = new Map<string, any>();
    const storage = {
      storeVectors: jest.fn(async (vectors: any[]) => {
        for (const v of vectors) {
          vectorsById.set(v.id, v);
        }
      }),
      removeByPathExceptHashes: jest.fn(async () => undefined),
      removeByPathExceptIds: jest.fn(async () => undefined),
      getVectorSync: jest.fn((id: string) => vectorsById.get(id) ?? null),
      getVectorsByPath: jest.fn(async () => []),
    };

    const preprocessor = {
      process: jest.fn((content: string) => ({
        content,
        source: content,
        hash: "doc-hash",
        length: content.length,
      })),
      chunkContentWithHashes: jest.fn(() => [
        { index: 0, text: `safe chunk ${"x".repeat(200)}`, hash: "hash-safe", headingPath: [], length: 250 },
        { index: 1, text: `blocked ${marker} chunk ${"y".repeat(200)}`, hash: "hash-blocked", headingPath: [], length: 270 },
      ]),
    };

    const processor = new EmbeddingsProcessor(provider, storage as any, preprocessor as any, { batchSize: 25, maxConcurrency: 1 });
    const app = {
      vault: {
        read: jest.fn(async () => `root content ${"z".repeat(200)}`),
      },
    } as any;
    const file = createFile("Mixed.md");

    const result = await processor.processFiles([file], app);
    expect(result.fatalError).toBeNull();
    expect(result.failedPaths).toContain("Mixed.md");

    const root = Array.from(vectorsById.values()).find((v) => v.path === "Mixed.md" && v.chunkId === 0);
    expect(root).toBeTruthy();
    expect(root.metadata.complete).toBe(false);
    expect(root.metadata.chunkCount).toBe(2);
  });
});
