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
import { EmbeddingsProviderError } from "../embeddings/providers/ProviderError";

function createPluginStub(settingsOverrides: Record<string, unknown> = {}) {
  const settings: Record<string, any> = {
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
    embeddingsPortableIndex: false,
    embeddingsRebuildPending: false,
    embeddingsRebuildRetryAt: 0,
    licenseKey: "fake-license",
    licenseValid: true,
    serverUrl: "https://api.systemsculpt.com/api/v1",
    ...settingsOverrides,
  };

  // Mirror the real SettingsManager: merge the patch into the live settings.
  const settingsManager = {
    updateSettings: jest.fn(async (patch: Record<string, unknown>) => {
      Object.assign(settings, patch);
    }),
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
    getSettingsManager: jest.fn(() => settingsManager),
  };
}

function transientError(): EmbeddingsProviderError {
  return new EmbeddingsProviderError("rate limited", {
    code: "RATE_LIMITED",
    transient: true,
    status: 429,
    retryInMs: 90_000,
    providerId: "systemsculpt",
  });
}

function licenseError(): EmbeddingsProviderError {
  return new EmbeddingsProviderError("unauthorized", {
    code: "LICENSE_INVALID",
    transient: false,
    status: 401,
    licenseRelated: true,
    providerId: "systemsculpt",
  });
}

describe("EmbeddingsManager rebuild resume (#208/#127)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("force-resumes an interrupted rebuild on init when pending + autoProcess OFF", async () => {
    const pluginStub = createPluginStub({
      embeddingsAutoProcess: false,
      embeddingsRebuildPending: true,
      embeddingsRebuildRetryAt: 0,
    });
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const spy = jest.spyOn(manager as any, "scheduleVaultProcessing").mockImplementation(() => {});

    await manager.initialize();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Number), { force: true });
  });

  it("does not resume on init when nothing is pending (autoProcess OFF)", async () => {
    const pluginStub = createPluginStub({
      embeddingsAutoProcess: false,
      embeddingsRebuildPending: false,
    });
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const spy = jest.spyOn(manager as any, "scheduleVaultProcessing").mockImplementation(() => {});

    await manager.initialize();

    expect(spy).not.toHaveBeenCalled();
  });

  it("defers to the normal autoProcess path (never force-schedules) when autoProcess ON", async () => {
    const pluginStub = createPluginStub({
      embeddingsAutoProcess: true,
      embeddingsRebuildPending: true,
    });
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const spy = jest.spyOn(manager as any, "scheduleVaultProcessing").mockImplementation(() => {});

    await manager.initialize();

    // scheduleAutoProcessing still runs, but the resume path must not force.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.every((call) => (call[1] as any)?.force !== true)).toBe(true);
  });

  it("persists resume intent and force-reschedules on a non-license vault failure", async () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const spy = jest.spyOn(manager as any, "scheduleVaultProcessing").mockImplementation(() => {});

    await (manager as any).handleVaultFailure(transientError(), 3);

    expect(pluginStub.settings.embeddingsRebuildPending).toBe(true);
    expect(pluginStub.settings.embeddingsRebuildRetryAt).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledWith(expect.any(Number), { force: true });
  });

  it("does NOT persist resume intent or reschedule on a license failure", async () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const spy = jest.spyOn(manager as any, "scheduleVaultProcessing").mockImplementation(() => {});

    await (manager as any).handleVaultFailure(licenseError(), 3);

    expect(pluginStub.settings.embeddingsRebuildPending).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("clears resume intent on a clean vault completion", () => {
    const pluginStub = createPluginStub({ embeddingsRebuildPending: true, embeddingsRebuildRetryAt: 12345 });
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    (manager as any).handleProcessingSuccess("vault");

    expect(pluginStub.settings.embeddingsRebuildPending).toBe(false);
    expect(pluginStub.settings.embeddingsRebuildRetryAt).toBe(0);
  });

  it("does not touch resume intent on a per-file success", () => {
    const pluginStub = createPluginStub({ embeddingsRebuildPending: true, embeddingsRebuildRetryAt: 12345 });
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const settingsManager = pluginStub.getSettingsManager();

    (manager as any).handleProcessingSuccess("file");

    // A single file finishing is not a completed rebuild.
    expect(pluginStub.settings.embeddingsRebuildPending).toBe(true);
    expect(settingsManager.updateSettings).not.toHaveBeenCalled();
  });
});
