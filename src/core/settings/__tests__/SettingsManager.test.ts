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
  TFolder: class TFolder {},
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
    expect(manager.settings.thinAgentClientId).toMatch(/^client_[a-f0-9]{32}$/);
  });

  it("persists one stable thin-agent installation client id across reloads", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      vaultInstanceId: "12345678-1234-4abc-8def-1234567890ab",
    });
    const first = new SettingsManager(plugin);
    await first.loadSettings();
    expect(first.settings.thinAgentClientId)
      .toBe("client_1234567812344abc8def1234567890ab");

    const reloadedPlugin = createPlugin(first.settings);
    const second = new SettingsManager(reloadedPlugin);
    await second.loadSettings();
    expect(second.settings.thinAgentClientId).toBe(first.settings.thinAgentClientId);
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

  it("seeds the known chats folders from the configured folder and only ever appends to them", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chatsDirectory: "Archive/Chats",
    });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    // Chats saved before the list existed are in the folder configured now.
    expect(manager.settings.knownChatsDirectories).toEqual(["Archive/Chats"]);

    await Promise.all([
      manager.updateSettings({ knownChatsDirectories: ["Work/Chats"] }),
      manager.updateSettings({ knownChatsDirectories: ["Home/Chats"] }),
      manager.updateSettings({ chatsDirectory: "Home/Chats" }),
    ]);
    expect(manager.settings.knownChatsDirectories)
      .toEqual(["Archive/Chats", "Work/Chats", "Home/Chats"]);

    // A restored backup, which carries its own list, cannot drop a folder
    // that chats may still be in.
    await manager.restoreFromExternalSettings({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chatsDirectory: "SystemSculpt/Chats",
      knownChatsDirectories: ["SystemSculpt/Chats"],
    });
    expect(manager.settings.knownChatsDirectories)
      .toEqual(["Archive/Chats", "Work/Chats", "Home/Chats", "SystemSculpt/Chats"]);
    expect(plugin.saveData.mock.calls.at(-1)?.[0]).toMatchObject({
      knownChatsDirectories: ["Archive/Chats", "Work/Chats", "Home/Chats", "SystemSculpt/Chats"],
    });
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

  it("keeps the in-progress marker of a recording that was streaming to disk", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        {
          filePath: "SystemSculpt/Recordings/streaming.webm",
          startedAt: 1,
          durationMs: 0,
          sizeBytes: 12_000,
          stopReason: "interrupted",
          destination: "chat",
          captureInProgress: true,
        },
        {
          filePath: "SystemSculpt/Recordings/finished.webm",
          startedAt: 1,
          durationMs: 2_000,
          sizeBytes: 24_000,
          stopReason: "manual",
          destination: "note",
          captureInProgress: "yes",
        },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures[0]).toMatchObject({ captureInProgress: true });
    expect(manager.settings.pendingRecorderCaptures[1]).not.toHaveProperty("captureInProgress");
  });

  it("keeps a discarded recording fragment even though it has no recorded size", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        {
          filePath: ".systemsculpt/recordings-in-progress/fragment.webm",
          startedAt: 1,
          durationMs: 0,
          sizeBytes: 0,
          stopReason: "interrupted",
          destination: "note",
          discarded: true,
        },
        {
          filePath: "SystemSculpt/Recordings/empty.webm",
          startedAt: 1,
          durationMs: 0,
          sizeBytes: 0,
          stopReason: "manual",
          destination: "note",
        },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures).toEqual([
      expect.objectContaining({ filePath: ".systemsculpt/recordings-in-progress/fragment.webm", discarded: true }),
    ]);
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

  it("writes the settings backup when a concurrent save already created its folder", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    plugin.app.vault.adapter.write.mockClear();

    const backupDir = ".systemsculpt/settings-backups";
    plugin.app.vault.adapter.exists.mockImplementation(async () => false);
    plugin.app.vault.createFolder.mockImplementationOnce(async () => {
      plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => path === backupDir);
      throw new Error("Folder already exists.");
    });
    plugin.app.vault.getAbstractFileByPath = jest.fn(() => null);
    plugin.app.vault.adapter.stat = jest.fn().mockResolvedValue({ type: "folder" });

    await manager.updateSettings({ chatFontSize: "large" });

    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      `${backupDir}/settings-backup-latest.json`,
      expect.any(String),
    );
    expect(plugin.logger.error).not.toHaveBeenCalledWith(
      "Failed to write SystemSculpt settings backup",
      expect.anything(),
      expect.anything(),
    );
  });

  describe("empty or unreadable data.json", () => {
    const LATEST_BACKUP = ".systemsculpt/settings-backups/settings-backup-latest.json";
    const restoredBackup = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chatFontSize: "large",
      defaultChatTag: "restored-from-backup",
    };

    function installLatestBackup(plugin: ReturnType<typeof createPlugin>) {
      plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => path === LATEST_BACKUP);
      plugin.app.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path !== LATEST_BACKUP) throw new Error(`ENOENT: ${path}`);
        return JSON.stringify(restoredBackup);
      });
    }

    it("restores the latest backup when loadData resolves null instead of saving defaults over it", async () => {
      const plugin = createPlugin(null);
      installLatestBackup(plugin);
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.chatFontSize).toBe("large");
      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
      expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({
        chatFontSize: "large",
        defaultChatTag: "restored-from-backup",
      }));
      expect(plugin.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Restored SystemSculpt settings from backup"),
        expect.objectContaining({ source: "SettingsManager" }),
      );
    });

    it("consults the backup for an empty data.json object as well", async () => {
      const plugin = createPlugin({});
      installLatestBackup(plugin);
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
    });

    it("skips corrupt or empty backups until it finds a valid dated backup", async () => {
      const plugin = createPlugin(null);
      const paths = [
        LATEST_BACKUP,
        ".systemsculpt/settings-backups/settings-backup-2026-09-16.json",
        ".systemsculpt/settings-backups/settings-backup-2026-09-15.json",
      ];
      plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => paths.includes(path));
      plugin.app.vault.adapter.list.mockResolvedValue({ files: paths.slice(1), folders: [] });
      plugin.app.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === LATEST_BACKUP) return "{truncated";
        if (path === paths[1]) return "{}";
        return JSON.stringify(restoredBackup);
      });
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
    });

    it("still ends up with defaults on a fresh install with no data and no backup", async () => {
      const plugin = createPlugin(null);
      plugin.app.vault.adapter.list.mockRejectedValue(new Error("ENOENT: .systemsculpt/settings-backups"));
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(manager.settings.chatFontSize).toBe("medium");
      expect(manager.settings.defaultChatTag).toBe("");
      expect(plugin.saveData).toHaveBeenCalledWith(manager.settings);
      expect(plugin.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("serialized persistence", () => {
    it("applies concurrent updates in order so no key is dropped", async () => {
      const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
      const manager = new SettingsManager(plugin);
      await manager.loadSettings();
      plugin.saveData.mockClear();

      await Promise.all([
        manager.updateSettings({ chatFontSize: "large" }),
        manager.updateSettings({ defaultChatTag: "queued" }),
        manager.saveSettings(),
      ]);

      expect(manager.settings).toMatchObject({ chatFontSize: "large", defaultChatTag: "queued" });
      expect(plugin._internal_settings_systemsculpt_plugin).toMatchObject({
        chatFontSize: "large",
        defaultChatTag: "queued",
      });
      expect(plugin.saveData).toHaveBeenCalledTimes(3);
      expect(plugin.saveData.mock.calls.map(([data]: [any]) => data.chatFontSize)).toEqual(["large", "large", "large"]);
      expect(plugin.saveData.mock.calls.at(-1)?.[0]).toMatchObject({ chatFontSize: "large", defaultChatTag: "queued" });
    });

    it("keeps the queue usable after a failed save", async () => {
      const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
      const manager = new SettingsManager(plugin);
      await manager.loadSettings();
      plugin.saveData.mockRejectedValueOnce(new Error("disk full"));

      const failing = manager.updateSettings({ chatFontSize: "large" });
      const following = manager.updateSettings({ defaultChatTag: "after-failure" });

      await expect(failing).resolves.toBeUndefined();
      await expect(following).resolves.toBeUndefined();
      expect(manager.settings).toMatchObject({ chatFontSize: "large", defaultChatTag: "after-failure" });
      expect(plugin.saveData.mock.calls.at(-1)?.[0]).toMatchObject({ defaultChatTag: "after-failure" });
    });
  });
});
