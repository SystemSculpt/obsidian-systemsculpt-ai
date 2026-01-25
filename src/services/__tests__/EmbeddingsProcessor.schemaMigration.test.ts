import { TFile } from "obsidian";
import { EMBEDDING_SCHEMA_VERSION } from "../../constants/embeddings";
import { buildNamespace, buildNamespaceWithSchema } from "../embeddings/utils/namespace";
import { buildVectorId } from "../embeddings/utils/vectorId";
import { ContentPreprocessor } from "../embeddings/processing/ContentPreprocessor";
import { EmbeddingsProcessor } from "../embeddings/processing/EmbeddingsProcessor";

describe("EmbeddingsProcessor schema migration", () => {
  it("migrates schema-mismatched vectors when content matches", async () => {
    const provider = {
      id: "systemsculpt",
      model: "openrouter/openai/text-embedding-3-small",
      expectedDimension: 3,
      getMaxBatchSize: () => 25,
      generateEmbeddings: jest.fn(),
    } as any;

    const content =
      "# Title\n\nThis is a note with enough content to exceed the minimum length threshold for embeddings.\n\nMore text here.";
    const file = new TFile({
      path: "Note.md",
      name: "Note.md",
      extension: "md",
      stat: { mtime: 1234, size: content.length },
    });

    const preprocessor = new ContentPreprocessor();
    const processed = preprocessor.process(content, file);
    expect(processed).toBeTruthy();
    const chunks = preprocessor.chunkContentWithHashes(processed!.content, processed!.source ?? content);
    expect(chunks).toHaveLength(1);

    const dimension = 3;
    const legacySchema = Math.max(0, EMBEDDING_SCHEMA_VERSION - 1);
    const legacyNamespace = buildNamespaceWithSchema(provider.id, provider.model, legacySchema, dimension);
    const expectedNamespace = buildNamespace(provider.id, provider.model, dimension);

    const existingVector = {
      id: buildVectorId(legacyNamespace, "Note.md", 0),
      path: "Note.md",
      chunkId: 0,
      vector: new Float32Array([1, 0, 0]),
      metadata: {
        title: "Note",
        excerpt: "",
        mtime: 1234,
        contentHash: chunks[0].hash,
        provider: provider.id,
        model: provider.model,
        dimension,
        createdAt: 1200,
        namespace: legacyNamespace,
        complete: true,
        chunkCount: 1,
      },
    };

    const storage = {
      getVectorsByPath: jest.fn(async () => [existingVector]),
      getVectorSync: jest.fn(() => existingVector),
      storeVectors: jest.fn(async () => {}),
      removeIds: jest.fn(async () => {}),
      removeByPathExceptIds: jest.fn(async () => {}),
      moveVectorId: jest.fn(async () => {}),
    } as any;

    const app = {
      vault: {
        read: jest.fn(async () => content),
      },
    } as any;

    const processor = new EmbeddingsProcessor(provider, storage, preprocessor, {
      batchSize: 10,
      maxConcurrency: 1,
    });

    await processor.processFiles([file], app);

    expect(provider.generateEmbeddings).not.toHaveBeenCalled();
    expect(storage.storeVectors).toHaveBeenCalled();

    const storedVectors = storage.storeVectors.mock.calls.flatMap((call: any[]) => call[0] || []);
    expect(storedVectors.some((v: any) => v?.metadata?.namespace === expectedNamespace)).toBe(true);
  });
});
