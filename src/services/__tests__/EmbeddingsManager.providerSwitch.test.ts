jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const storageMock = {
    initialize: jest.fn(),
    loadEmbeddings: jest.fn(),
    clear: jest.fn(),
    countVectors: jest.fn(() => 10),
    importFromLegacyGlobalDb: jest.fn(async () => ({ imported: 0, skipped: 0 })),
    upgradeVectorsToCanonicalFormat: jest.fn(async () => ({ updated: 0, skipped: 0, removed: 0 })),
    backfillRootCompleteness: jest.fn(async () => ({ updated: 0, skipped: 0 })),
    getAllVectors: jest.fn(() => []),
    getVectorsByPath: jest.fn(() => []),
    getVectorsByNamespace: jest.fn(() => []),
    getVectorsByNamespacePrefix: jest.fn(() => []),
    peekBestNamespaceForPrefix: jest.fn(() => null),
    size: jest.fn(() => 0),
    storeVectors: jest.fn(),
    removeByNamespacePrefix: jest.fn(),
    removeByPath: jest.fn(),
    removeByPathExceptIds: jest.fn(),
    moveVectorId: jest.fn(),
    renameByPath: jest.fn(),
    renameByDirectory: jest.fn(),
    removeByDirectory: jest.fn(),
    getVectorSync: jest.fn(),
    purgeCorruptedVectors: jest.fn(() => ({
      removedCount: 0,
      correctedCount: 0,
      removedPaths: [],
      correctedPaths: [],
    })),
    getDistinctPaths: jest.fn(() => []),
  };
  const EmbeddingsStorage = jest.fn(() => storageMock);
  (EmbeddingsStorage as any).buildDbName = jest.fn(() => "SystemSculptEmbeddings::test-vault");
  return {
    EmbeddingsStorage,
    _getStorageMock: () => storageMock,
  };
});

jest.mock("../embeddings/processing/EmbeddingsProcessor", () => {
  return {
    EmbeddingsProcessor: jest.fn().mockImplementation(() => ({
      processFiles: jest.fn().mockResolvedValue({ processed: 0, skipped: 0, failed: 0 }),
      cancel: jest.fn(),
      setProvider: jest.fn(),
      setConfig: jest.fn(),
    })),
  };
});

jest.mock("../../core/ui/notifications", () => ({
  showNoticeWhenReady: jest.fn(),
}));

import { TFile } from "obsidian";
import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";
import { EMBEDDING_SCHEMA_VERSION, DEFAULT_EMBEDDING_DIMENSION } from "../../constants/embeddings";

const getStorageMock = () =>
  (require("../embeddings/storage/EmbeddingsStorage") as any)._getStorageMock();

function createPluginStub(settingsOverrides: Record<string, any> = {}) {
  const settingsManager = {
    updateSettings: jest.fn(async () => {}),
  };

  const settings = {
    vaultInstanceId: "test-vault",
    embeddingsVectorFormatVersion: 4,
    embeddingsProvider: "systemsculpt",
    embeddingsCustomEndpoint: "",
    embeddingsCustomApiKey: "",
    embeddingsCustomModel: "",
    embeddingsModel: "",
    embeddingsBatchSize: 8,
    embeddingsAutoProcess: false,
    embeddingsExclusions: {
      folders: [],
      patterns: [],
      ignoreChatHistory: true,
      respectObsidianExclusions: true,
    },
    embeddingsRateLimitPerMinute: 30,
    embeddingsEnabled: true,
    embeddingsQuietPeriodMs: 500,
    licenseKey: "fake-license",
    licenseValid: true,
    serverUrl: "https://api.systemsculpt.com/api/v1",
    ...settingsOverrides,
  };

  const files = [
    new TFile({ path: "Note1.md", stat: { mtime: Date.now(), size: 1000 } }),
    new TFile({ path: "Note2.md", stat: { mtime: Date.now(), size: 1500 } }),
    new TFile({ path: "Note3.md", stat: { mtime: Date.now(), size: 2000 } }),
  ];

  const vault = {
    getMarkdownFiles: jest.fn(() => files),
    getAbstractFileByPath: jest.fn((path) => files.find((f) => f.path === path) || null),
    read: jest.fn(() => "# Test\n\nThis is test content with enough length to process."),
    on: jest.fn(() => jest.fn()),
    offref: jest.fn(),
  };

  const app = { vault };

  return {
    app,
    settings,
    emitter: {
      emit: jest.fn(),
      on: jest.fn(() => jest.fn()),
    },
    getSettingsManager: jest.fn(() => settingsManager),
    _files: files,
  };
}

describe("EmbeddingsManager provider switching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("switching from SystemSculpt to Custom provider", () => {
    it("marks existing SystemSculpt vectors as schema-mismatch when switching to Custom", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "custom",
        embeddingsCustomEndpoint: "http://localhost:11434/api/embeddings",
        embeddingsCustomModel: "nomic-embed-text",
      });

      const storageMock = getStorageMock();
      const systemSculptNamespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v${EMBEDDING_SCHEMA_VERSION}:${DEFAULT_EMBEDDING_DIMENSION}`;
      const customNamespace = `custom:nomic-embed-text:v${EMBEDDING_SCHEMA_VERSION}:768`;

      storageMock.peekBestNamespaceForPrefix.mockReturnValue(customNamespace);

      storageMock.getVectorSync.mockReturnValue({
        id: "Note1.md#0",
        path: "Note1.md",
        chunkId: 0,
        vector: new Float32Array([0.1, 0.2, 0.3]),
        metadata: {
          provider: "systemsculpt",
          model: "openrouter/openai/text-embedding-3-small",
          namespace: systemSculptNamespace,
          mtime: Date.now() - 1000,
          dimension: DEFAULT_EMBEDDING_DIMENSION,
          complete: true,
          chunkCount: 1,
        },
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const state = (manager as any).evaluateFileProcessingState(pluginStub._files[0]);

      expect(state.needsProcessing).toBe(true);
      expect(state.reason).toBe("schema-mismatch");
    });

    it("getStats reflects files needing reprocessing after provider switch", async () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "custom",
        embeddingsCustomEndpoint: "http://localhost:11434/api/embeddings",
        embeddingsCustomModel: "nomic-embed-text",
      });

      const storageMock = getStorageMock();
      const oldNamespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v${EMBEDDING_SCHEMA_VERSION}:${DEFAULT_EMBEDDING_DIMENSION}`;

      storageMock.getVectorSync.mockImplementation((path: string) => {
        if (path === "Note1.md" || path === "Note2.md") {
          return {
            id: `${path}#0`,
            path,
            chunkId: 0,
            vector: new Float32Array([0.1, 0.2, 0.3]),
            metadata: {
              provider: "systemsculpt",
              model: "openrouter/openai/text-embedding-3-small",
              namespace: oldNamespace,
              mtime: Date.now() - 1000,
              dimension: DEFAULT_EMBEDDING_DIMENSION,
              complete: true,
              chunkCount: 1,
            },
          };
        }
        return null;
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const stats = manager.getStats();

      expect(stats.needsProcessing).toBeGreaterThan(0);
    });
  });

  describe("switching from Custom to SystemSculpt provider", () => {
    it("marks existing Custom vectors as schema-mismatch when switching to SystemSculpt", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "systemsculpt",
      });

      const storageMock = getStorageMock();
      const customNamespace = `custom:nomic-embed-text:v${EMBEDDING_SCHEMA_VERSION}:768`;

      storageMock.getVectorSync.mockReturnValue({
        id: "Note1.md#0",
        path: "Note1.md",
        chunkId: 0,
        vector: new Float32Array(768).fill(0.1),
        metadata: {
          provider: "custom",
          model: "nomic-embed-text",
          namespace: customNamespace,
          mtime: Date.now() - 1000,
          dimension: 768,
          complete: true,
          chunkCount: 1,
        },
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const state = (manager as any).evaluateFileProcessingState(pluginStub._files[0]);

      expect(state.needsProcessing).toBe(true);
      expect(state.reason).toBe("schema-mismatch");
    });
  });

  describe("switching Custom provider models", () => {
    it("marks vectors as schema-mismatch when Custom model changes", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "custom",
        embeddingsCustomEndpoint: "http://localhost:11434/api/embeddings",
        embeddingsCustomModel: "mxbai-embed-large",
      });

      const storageMock = getStorageMock();
      const oldModelNamespace = `custom:nomic-embed-text:v${EMBEDDING_SCHEMA_VERSION}:768`;
      const newModelNamespace = `custom:mxbai-embed-large:v${EMBEDDING_SCHEMA_VERSION}:1024`;

      storageMock.peekBestNamespaceForPrefix.mockReturnValue(newModelNamespace);

      storageMock.getVectorSync.mockReturnValue({
        id: "Note1.md#0",
        path: "Note1.md",
        chunkId: 0,
        vector: new Float32Array(768).fill(0.1),
        metadata: {
          provider: "custom",
          model: "nomic-embed-text",
          namespace: oldModelNamespace,
          mtime: Date.now() - 1000,
          dimension: 768,
          complete: true,
          chunkCount: 1,
        },
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const state = (manager as any).evaluateFileProcessingState(pluginStub._files[0]);

      expect(state.needsProcessing).toBe(true);
      expect(state.reason).toBe("schema-mismatch");
    });
  });

  describe("namespace detection", () => {
    it("getCurrentNamespaceDescriptor returns correct provider info", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "custom",
        embeddingsCustomEndpoint: "http://localhost:11434/api/embeddings",
        embeddingsCustomModel: "nomic-embed-text",
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const descriptor = (manager as any).getCurrentNamespaceDescriptor();

      expect(descriptor.provider).toBe("custom");
      expect(descriptor.model).toBe("nomic-embed-text");
      expect(descriptor.schema).toBe(EMBEDDING_SCHEMA_VERSION);
    });

    it("getCurrentNamespaceDescriptor returns SystemSculpt info correctly", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "systemsculpt",
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const descriptor = (manager as any).getCurrentNamespaceDescriptor();

      expect(descriptor.provider).toBe("systemsculpt");
      expect(descriptor.schema).toBe(EMBEDDING_SCHEMA_VERSION);
    });
  });

  describe("files without embeddings", () => {
    it("detects files that have never been embedded", () => {
      const pluginStub = createPluginStub();
      const storageMock = getStorageMock();

      storageMock.getVectorSync.mockReturnValue(null);

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const state = (manager as any).evaluateFileProcessingState(pluginStub._files[0]);

      expect(state.needsProcessing).toBe(true);
      expect(state.reason).toBe("missing");
    });
  });

  describe("files with current provider embeddings", () => {
    it("detects files that are up-to-date with current provider", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "systemsculpt",
      });

      const storageMock = getStorageMock();
      const currentNamespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v${EMBEDDING_SCHEMA_VERSION}:${DEFAULT_EMBEDDING_DIMENSION}`;

      const file = pluginStub._files[0];
      storageMock.getVectorSync.mockReturnValue({
        id: `${file.path}#0`,
        path: file.path,
        chunkId: 0,
        vector: new Float32Array([0.1, 0.2, 0.3]),
        metadata: {
          provider: "systemsculpt",
          model: "openrouter/openai/text-embedding-3-small",
          namespace: currentNamespace,
          mtime: file.stat.mtime,
          dimension: DEFAULT_EMBEDDING_DIMENSION,
          complete: true,
          chunkCount: 1,
        },
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const state = (manager as any).evaluateFileProcessingState(file);

      expect(state.needsProcessing).toBe(false);
    });
  });

  describe("modified files", () => {
    it("detects files modified after embedding", () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "systemsculpt",
      });

      const storageMock = getStorageMock();
      const currentNamespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v${EMBEDDING_SCHEMA_VERSION}:${DEFAULT_EMBEDDING_DIMENSION}`;

      const file = pluginStub._files[0];
      storageMock.getVectorSync.mockReturnValue({
        id: `${file.path}#0`,
        path: file.path,
        chunkId: 0,
        vector: new Float32Array([0.1, 0.2, 0.3]),
        metadata: {
          provider: "systemsculpt",
          model: "openrouter/openai/text-embedding-3-small",
          namespace: currentNamespace,
          mtime: file.stat.mtime - 10000,
          dimension: DEFAULT_EMBEDDING_DIMENSION,
          complete: true,
          chunkCount: 1,
        },
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const state = (manager as any).evaluateFileProcessingState(file);

      expect(state.needsProcessing).toBe(true);
      expect(state.reason).toBe("modified");
    });
  });

  describe("listPendingFiles after provider switch", () => {
    it("lists all files needing reprocessing after switching providers", async () => {
      const pluginStub = createPluginStub({
        embeddingsProvider: "custom",
        embeddingsCustomEndpoint: "http://localhost:11434/api/embeddings",
        embeddingsCustomModel: "nomic-embed-text",
      });

      const storageMock = getStorageMock();
      const oldNamespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v${EMBEDDING_SCHEMA_VERSION}:${DEFAULT_EMBEDDING_DIMENSION}`;
      const customNamespace = `custom:nomic-embed-text:v${EMBEDDING_SCHEMA_VERSION}:768`;

      storageMock.peekBestNamespaceForPrefix.mockReturnValue(customNamespace);

      storageMock.getVectorSync.mockImplementation(() => ({
        id: `Note1.md#0`,
        path: "Note1.md",
        chunkId: 0,
        vector: new Float32Array([0.1, 0.2, 0.3]),
        metadata: {
          provider: "systemsculpt",
          model: "openrouter/openai/text-embedding-3-small",
          namespace: oldNamespace,
          mtime: Date.now() - 1000,
          dimension: DEFAULT_EMBEDDING_DIMENSION,
          complete: true,
          chunkCount: 1,
        },
      }));

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      const pendingFiles = await manager.listPendingFiles();

      expect(pendingFiles.length).toBe(3);
      expect(pendingFiles.every((f) => f.reason === "schema-mismatch")).toBe(true);
    });
  });

  describe("hasAnyEmbeddings behavior", () => {
    it("returns true when storage has vectors for current namespace prefix", () => {
      const pluginStub = createPluginStub();
      const storageMock = getStorageMock();

      const namespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v${EMBEDDING_SCHEMA_VERSION}:${DEFAULT_EMBEDDING_DIMENSION}`;

      storageMock.getDistinctPaths.mockReturnValue(["Note1.md"]);
      storageMock.getVectorSync.mockReturnValue({
        id: `${namespace}::Note1.md#0`,
        path: "Note1.md",
        chunkId: 0,
        vector: new Float32Array([0.1, 0.2, 0.3]),
        metadata: {
          provider: "systemsculpt",
          model: "openrouter/openai/text-embedding-3-small",
          namespace: namespace,
          mtime: Date.now(),
          dimension: DEFAULT_EMBEDDING_DIMENSION,
          complete: true,
          chunkCount: 1,
        },
      });

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      expect(manager.hasAnyEmbeddings()).toBe(true);
    });

    it("returns false when no vectors exist for current provider", () => {
      const pluginStub = createPluginStub();
      const storageMock = getStorageMock();

      storageMock.getDistinctPaths.mockReturnValue([]);
      storageMock.getVectorSync.mockReturnValue(null);

      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      expect(manager.hasAnyEmbeddings()).toBe(false);
    });
  });
});
