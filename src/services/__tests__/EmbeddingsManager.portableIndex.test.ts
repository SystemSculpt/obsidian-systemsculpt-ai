jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const storageMock = {
    initialize: jest.fn(),
    loadEmbeddings: jest.fn(),
    clear: jest.fn(),
    countVectors: jest.fn(async () => 0),
    importFromLegacyGlobalDb: jest.fn(async () => ({ imported: 0, skipped: 0 })),
    upgradeVectorsToCanonicalFormat: jest.fn(async () => ({ updated: 0, skipped: 0, removed: 0 })),
    backfillRootCompleteness: jest.fn(async () => ({ updated: 0, skipped: 0 })),
    getAllVectors: jest.fn(() => []),
    peekBestNamespaceForPrefix: jest.fn(() => null),
    size: jest.fn(() => 0),
    storeVectors: jest.fn(),
    purgeCorruptedVectors: jest.fn(() => ({
      removedCount: 0,
      correctedCount: 0,
      removedPaths: [],
      correctedPaths: [],
    })),
  };
  const EmbeddingsStorage = jest.fn(() => storageMock);
  (EmbeddingsStorage as any).buildDbName = jest.fn(() => "SystemSculptEmbeddings::test-vault");
  return { EmbeddingsStorage };
});

jest.mock("../embeddings/processing/EmbeddingsProcessor", () => ({
  EmbeddingsProcessor: jest.fn().mockImplementation(() => ({
    processFiles: jest.fn(),
    cancel: jest.fn(),
    setProvider: jest.fn(),
    setConfig: jest.fn(),
    cleanup: jest.fn(),
  })),
}));

jest.mock("../embeddings/storage/EmbeddingsPortableIndex", () => ({
  restoreEmbeddingsIndexIfEmpty: jest.fn(async () => ({ restored: false, imported: 0, reason: "no-snapshot" })),
  writeEmbeddingsIndexSnapshot: jest.fn(async () => ({ written: false, count: 0 })),
}));

jest.mock("../../core/ui/notifications", () => ({
  showNoticeWhenReady: jest.fn(),
}));

import { TFile } from "obsidian";
import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";
import { EmbeddingsIndexFile } from "../embeddings/storage/EmbeddingsIndexFile";
import { restoreEmbeddingsIndexIfEmpty } from "../embeddings/storage/EmbeddingsPortableIndex";

function createPluginStub(settingsOverrides: Record<string, unknown> = {}) {
  const settings = {
    vaultInstanceId: "test-vault",
    embeddingsVectorFormatVersion: 5,
    embeddingsAutoProcess: false,
    embeddingsExclusions: {
      folders: [],
      patterns: [],
      ignoreChatHistory: true,
      respectObsidianExclusions: true,
    },
    embeddingsEnabled: false,
    licenseKey: "fake-license",
    licenseValid: true,
    serverUrl: "https://api.systemsculpt.com/api/v1",
    ...settingsOverrides,
  };

  const vault = {
    getMarkdownFiles: jest.fn(() => [new TFile({ path: "Note.md", name: "Note.md", extension: "md" })]),
    getAbstractFileByPath: jest.fn(() => null),
    read: jest.fn(),
    on: jest.fn(() => jest.fn()),
    offref: jest.fn(),
    adapter: {
      exists: jest.fn(async () => false),
      read: jest.fn(),
      write: jest.fn(),
      mkdir: jest.fn(),
    },
  };

  return {
    app: { vault },
    settings,
    emitter: { emit: jest.fn(), on: jest.fn(() => jest.fn()) },
    getManagedCapabilityClient: jest.fn(() => ({ request: jest.fn() })),
    getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn(async () => {}) })),
  };
}

describe("EmbeddingsManager portable index restore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("restores from the vault snapshot on init when enabled (default)", async () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    await manager.initialize();

    expect(restoreEmbeddingsIndexIfEmpty).toHaveBeenCalledTimes(1);
    const call = (restoreEmbeddingsIndexIfEmpty as jest.Mock).mock.calls[0][0];
    expect(call.file).toBeInstanceOf(EmbeddingsIndexFile);
    expect(call.store).toBeTruthy();
  });

  it("does not restore when the portable-index setting is disabled", async () => {
    const pluginStub = createPluginStub({ embeddingsPortableIndex: false });
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    await manager.initialize();

    expect(restoreEmbeddingsIndexIfEmpty).not.toHaveBeenCalled();
  });
});
