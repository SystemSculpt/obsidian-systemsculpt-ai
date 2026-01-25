jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const storageMock = {
    initialize: jest.fn(),
    loadEmbeddings: jest.fn(),
    clear: jest.fn(),
    countVectors: jest.fn(() => 0),
    importFromLegacyGlobalDb: jest.fn(async () => ({ imported: 0, skipped: 0 })),
    upgradeVectorsToCanonicalFormat: jest.fn(async () => ({ updated: 0, skipped: 0, removed: 0 })),
    backfillRootCompleteness: jest.fn(async () => ({ updated: 0, skipped: 0 })),
    getAllVectors: jest.fn(() => []),
    getVectorsByPath: jest.fn(() => []),
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
  };
  const EmbeddingsStorage = jest.fn(() => storageMock);
  (EmbeddingsStorage as any).buildDbName = jest.fn(() => "SystemSculptEmbeddings::test-vault");
  return {
    EmbeddingsStorage,
  };
});

jest.mock("../embeddings/processing/EmbeddingsProcessor", () => {
  return {
    EmbeddingsProcessor: jest.fn().mockImplementation(() => ({
      processFiles: jest.fn(),
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

function createPluginStub(overrides?: Partial<any>) {
  const settingsManager = {
    updateSettings: jest.fn(async () => {}),
  };

  const settings = {
    vaultInstanceId: "test-vault",
    embeddingsVectorFormatVersion: 2,
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
    embeddingsEnabled: false,
    embeddingsQuietPeriodMs: 500,
    licenseKey: "fake-license",
    licenseValid: true,
    serverUrl: "https://api.systemsculpt.com/api/v1",
    ...(overrides?.settings || {}),
  };

  const vault = {
    getMarkdownFiles: jest.fn(() => [new TFile({ path: "Note.md", name: "Note.md", extension: "md" })]),
    getAbstractFileByPath: jest.fn(() => null),
    read: jest.fn(),
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
    ...(overrides || {}),
  };
}

describe("EmbeddingsManager migration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("skips legacy import when vault-scoped DB already has vectors", async () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const storageMock = (
      (require("../embeddings/storage/EmbeddingsStorage") as any).EmbeddingsStorage.mock.results.slice(-1)[0].value
    );
    storageMock.countVectors.mockResolvedValue(42);

    await manager.initialize();

    expect(storageMock.importFromLegacyGlobalDb).not.toHaveBeenCalled();
    expect(storageMock.upgradeVectorsToCanonicalFormat).toHaveBeenCalledTimes(1);
    expect(storageMock.backfillRootCompleteness).toHaveBeenCalledTimes(1);

    const settingsManager = pluginStub.getSettingsManager.mock.results[0].value;
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({ embeddingsVectorFormatVersion: 4 });
  });

  it("imports from legacy global DB when vault-scoped DB is empty", async () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const storageMock = (
      (require("../embeddings/storage/EmbeddingsStorage") as any).EmbeddingsStorage.mock.results.slice(-1)[0].value
    );
    storageMock.countVectors.mockResolvedValue(0);

    await manager.initialize();

    expect(storageMock.importFromLegacyGlobalDb).toHaveBeenCalledTimes(1);
    expect(storageMock.upgradeVectorsToCanonicalFormat).toHaveBeenCalledTimes(1);
    expect(storageMock.backfillRootCompleteness).toHaveBeenCalledTimes(1);
  });
});
