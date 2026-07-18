/** @jest-environment node */

jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
  Platform: {
    isDesktopApp: true,
    isMobile: false,
    isMobileApp: false,
  },
  normalizePath: (value: string) => String(value || "").replace(/\\/g, "/"),
}));

const backupStart = jest.fn();
jest.mock("../AutomaticBackupService", () => ({
  AutomaticBackupService: jest.fn().mockImplementation(() => ({
    start: backupStart,
    stop: jest.fn(),
  })),
}));

import { SettingsManager } from "../SettingsManager";
import { CURRENT_SCHEMA_VERSION } from "../migrations/schemaVersion";
import {
  getCurrentHostPreferredMicrophoneId,
  setCurrentHostPreferredMicrophoneId,
} from "../../../services/recorder/RecorderPreferenceStore";

function installOwnerWindow(): Window {
  const values = new Map<string, string>();
  const ownerWindow = {
    localStorage: {
      getItem: jest.fn((key: string) => values.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => values.set(key, value)),
    },
  } as unknown as Window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: ownerWindow,
  });
  return ownerWindow;
}

function createPlugin(loadDataResult: unknown = {}) {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  return {
    manifest: { id: "systemsculpt-ai" },
    loadData: jest.fn().mockResolvedValue(loadDataResult),
    saveData: jest.fn().mockResolvedValue(undefined),
    storage: null,
    register: jest.fn(),
    getLogger: () => logger,
    logger,
    app: {
      vault: {
        configDir: ".obsidian",
        getName: jest.fn(() => "settings-manager-vault"),
        adapter: {
          basePath: "/tmp/systemsculpt-test-vault",
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn(),
          write: jest.fn().mockResolvedValue(undefined),
          list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
        },
        createFolder: jest.fn().mockResolvedValue(undefined),
      },
      workspace: { trigger: jest.fn() },
    },
    _internal_settings_systemsculpt_plugin: {},
  } as any;
}

describe("SettingsManager managed settings contract", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    delete (globalThis as typeof globalThis & { window?: Window }).window;
  });

  it("loads current settings, stamps v4, and prunes retired client authority", async () => {
    const plugin = createPlugin({
      schemaVersion: 3,
      licenseKey: "license_test",
      serverUrl: "http://localhost:3002/api/plugin",
      customProviders: [{ id: "retired" }],
      selectedModelId: "retired@@model",
      readwiseApiToken: "secret",
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manager.settings.licenseKey).toBe("license_test");
    expect(manager.settings).not.toHaveProperty("serverUrl");
    expect(manager.settings).not.toHaveProperty("customProviders");
    expect(manager.settings).not.toHaveProperty("selectedModelId");
    expect(manager.settings).not.toHaveProperty("readwiseApiToken");
    expect(plugin.saveData).toHaveBeenCalledWith(manager.settings);
    expect(backupStart).toHaveBeenCalledTimes(1);
  });

  it("uses the current defaults for invalid persisted data", async () => {
    const plugin = createPlugin([]);
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(typeof manager.settings.chatsDirectory).toBe("string");
    expect(typeof manager.settings.vaultInstanceId).toBe("string");
  });

  it("persists updates and emits the settings-updated event", async () => {
    const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    plugin.saveData.mockClear();
    plugin.app.workspace.trigger.mockClear();

    await manager.updateSettings({ chatFontSize: "large" });

    expect(manager.settings.chatFontSize).toBe("large");
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ chatFontSize: "large" }));
    expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
      "systemsculpt:settings-updated",
      expect.any(Object),
      manager.settings,
    );
  });

  it("migrates a restored v3 backup before applying it", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    await manager.restoreFromExternalSettings({
      schemaVersion: 3,
      licenseKey: "backup-license",
      customProviders: [{ id: "retired" }],
      serverUrl: "http://localhost:3002/api/plugin",
    });

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manager.settings.licenseKey).toBe("backup-license");
    expect(manager.settings).not.toHaveProperty("customProviders");
    expect(manager.settings).not.toHaveProperty("serverUrl");
  });

  it("removes retired recorder settings and synced microphone preferences", async () => {
    const plugin = createPlugin({
      schemaVersion: 8,
      preferredMicrophoneId: "default",
      postProcessingPromptType: "preset",
      postProcessingPromptPresetId: "transcript-cleaner",
      postProcessingPromptFilePath: "",
      showTranscriptionFormatChooserInModal: false,
      enableAutoAudioResampling: true,
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneIdsByHost");
    expect(manager.settings).not.toHaveProperty("postProcessingPromptType");
    expect(manager.settings).not.toHaveProperty("postProcessingPromptPresetId");
    expect(manager.settings).not.toHaveProperty("postProcessingPromptFilePath");
    expect(manager.settings).not.toHaveProperty("showTranscriptionFormatChooserInModal");
    expect(manager.settings).not.toHaveProperty("enableAutoAudioResampling");
  });

  it("prunes retired workflow automations while preserving inbox transcription settings", async () => {
    const plugin = createPlugin({
      schemaVersion: 11,
      workflowEngine: {
        enabled: false,
        inboxRoutingEnabled: false,
        inboxFolder: "Capture/Audio",
        processedNotesFolder: "Capture/Processed",
        autoTranscribeInboxNotes: true,
        futureWorkflowField: { keep: true },
        automations: { meeting: { enabled: true } },
        templates: { legacy: { enabled: true } },
        managedTextOperations: { "automation::meeting::note.md": { phase: "queued" } },
        skippedFiles: {
          "automation::meeting::note.md": {
            path: "note.md",
            type: "automation",
            skippedAt: "2026-07-18T00:00:00.000Z",
          },
          "transcription::default::Capture/Audio/audio.mp3": {
            path: "Capture/Audio/audio.mp3",
            type: "transcription",
            skippedAt: "2026-07-18T00:00:00.000Z",
          },
        },
      },
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.workflowEngine).toMatchObject({
      enabled: false,
      inboxRoutingEnabled: false,
      inboxFolder: "Capture/Audio",
      processedNotesFolder: "Capture/Processed",
      autoTranscribeInboxNotes: true,
      skippedFiles: {
        "transcription::default::Capture/Audio/audio.mp3": {
          path: "Capture/Audio/audio.mp3",
          type: "transcription",
          skippedAt: "2026-07-18T00:00:00.000Z",
        },
      },
      futureWorkflowField: { keep: true },
    });
    expect(manager.settings.workflowEngine).not.toHaveProperty("automations");
    expect(manager.settings.workflowEngine).not.toHaveProperty("templates");
    expect(manager.settings.workflowEngine).not.toHaveProperty("managedTextOperations");
  });

  it("moves the current-host v9 microphone preference to device-local storage", async () => {
    const ownerWindow = installOwnerWindow();
    const plugin = createPlugin({
      schemaVersion: 9,
      vaultInstanceId: "legacy-recorder-vault",
      preferredMicrophoneId: "fallback-mic",
      preferredMicrophoneIdsByHost: {
        desktop: "desktop-mic",
        mobile: "phone-mic",
      },
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(getCurrentHostPreferredMicrophoneId(
      ownerWindow,
      "legacy-recorder-vault",
    )).toBe("desktop-mic");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneIdsByHost");
    const persisted = plugin.saveData.mock.calls.at(-1)?.[0];
    expect(persisted).not.toHaveProperty("preferredMicrophoneId");
    expect(persisted).not.toHaveProperty("preferredMicrophoneIdsByHost");
  });

  it("falls back to the legacy scalar microphone preference during v10 migration", async () => {
    const ownerWindow = installOwnerWindow();
    const vaultIdentity = "legacy-scalar-recorder-vault";
    const plugin = createPlugin({
      schemaVersion: 9,
      vaultInstanceId: vaultIdentity,
      preferredMicrophoneId: "legacy-scalar-mic",
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(getCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity)).toBe(
      "legacy-scalar-mic",
    );
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
  });

  it("does not overwrite a local microphone when importing an old backup", async () => {
    const ownerWindow = installOwnerWindow();
    const vaultIdentity = "restored-recorder-vault";
    setCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity, "local-mic");
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      vaultInstanceId: vaultIdentity,
    });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    await manager.restoreFromExternalSettings({
      schemaVersion: 9,
      vaultInstanceId: vaultIdentity,
      preferredMicrophoneId: "backup-mic",
    });

    expect(getCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity)).toBe("local-mic");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneIdsByHost");
  });

  it("keeps only valid bounded pending recorder recovery entries", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        {
          filePath: "SystemSculpt/Recordings/saved.webm",
          startedAt: 1,
          durationMs: 2_000,
          sizeBytes: 24_000,
          stopReason: "background-hidden",
          destination: "note",
          transcriptionIntent: "manual",
          operationId: "transcription-safe-1",
        },
        {
          filePath: "",
          startedAt: -1,
          durationMs: -1,
          sizeBytes: 0,
          stopReason: "unknown",
          destination: "somewhere",
          operationId: "not valid!",
        },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures).toEqual([{
      filePath: "SystemSculpt/Recordings/saved.webm",
      startedAt: 1,
      durationMs: 2_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
      transcriptionIntent: "manual",
      operationId: "transcription-safe-1",
    }]);
  });

  it("deduplicates synced recorder recovery and blocks conflicting operation ids", async () => {
    const base = {
      startedAt: 1,
      durationMs: 2_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
    };
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        { ...base, filePath: "same.webm", transcriptionIntent: "manual" },
        { ...base, filePath: "same.webm", startedAt: 2, operationId: "same-op" },
        { ...base, filePath: "conflict.webm", operationId: "first-op" },
        { ...base, filePath: "conflict.webm", startedAt: 3, operationId: "second-op" },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures).toEqual([
      expect.objectContaining({
        filePath: "same.webm",
        startedAt: 2,
        transcriptionIntent: "manual",
        operationId: "same-op",
      }),
      expect.objectContaining({
        filePath: "conflict.webm",
        startedAt: 3,
        recoveryBlocked: "conflicting-operation-ids",
      }),
    ]);
    expect(manager.settings.pendingRecorderCaptures[1]).not.toHaveProperty("operationId");
  });

  it("logs primary save and backup failures without breaking updates", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    plugin.saveData.mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.updateSettings({ chatFontSize: "large" })).resolves.toBeUndefined();
    expect(plugin.logger.error).toHaveBeenCalledWith(
      "Failed to save SystemSculpt settings",
      expect.any(Error),
      expect.objectContaining({ source: "SettingsManager" }),
    );

    plugin.saveData.mockResolvedValue(undefined);
    plugin.app.vault.adapter.write.mockRejectedValueOnce(new Error("backup unavailable"));
    await expect(manager.updateSettings({ chatFontSize: "small" })).resolves.toBeUndefined();
    expect(plugin.logger.error).toHaveBeenCalledWith(
      "Failed to write SystemSculpt settings backup",
      expect.any(Error),
      expect.objectContaining({ source: "SettingsManager" }),
    );
  });
});
