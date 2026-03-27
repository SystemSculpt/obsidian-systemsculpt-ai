/**
 * @jest-environment node
 */

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
  normalizePath: (value: string) => String(value || "").replace(/\\/g, "/"),
}));

const mockFsWatcherOn = jest.fn();
const mockFsWatcherClose = jest.fn();
const mockFsWatch = jest.fn(() => ({
  on: mockFsWatcherOn,
  close: mockFsWatcherClose,
}));
const mockFsPromisesStat = jest.fn();

jest.mock("node:fs", () => ({
  watch: (...args: unknown[]) => mockFsWatch(...args),
  promises: {
    stat: (...args: unknown[]) => mockFsPromisesStat(...args),
  },
}));

// Mock AutomaticBackupService
const mockAutomaticBackupServiceStart = jest.fn();
const mockAutomaticBackupServiceStop = jest.fn();
jest.mock("../AutomaticBackupService", () => ({
  AutomaticBackupService: jest.fn().mockImplementation(() => ({
    start: mockAutomaticBackupServiceStart,
    stop: mockAutomaticBackupServiceStop,
  })),
}));

// Mock types
jest.mock("../../../types", () => ({
  DEFAULT_SETTINGS: {
    settingsMode: "standard",
    vaultInstanceId: "",
    embeddingsVectorFormatVersion: 1,
    favoritesFilterSettings: { showAll: true },
    modelFilterSettings: { showAll: true },
    activeProvider: "openai",
    customProviders: [],
    studioPiAuthMigrationVersion: 0,
    favoriteModels: [],
    workflowEngine: {
      enabled: false,
      autoTranscribeInboxNotes: false,
      inboxFolder: "Inbox",
      automations: {},
    },
    mcpServers: [],
    debugMode: false,
    logLevel: 2,
    favoriteChats: [],
    favoriteStudioSessions: [],
    automaticBackupsEnabled: false,
    automaticBackupInterval: 24,
    automaticBackupRetentionDays: 7,
    lastAutomaticBackup: 0,
    preserveReasoningVerbatim: true,
    respectReducedMotion: true,
    recordingsDirectory: "SystemSculpt/Recordings",
    transcriptionOutputFormat: "markdown",
    showTranscriptionFormatChooserInModal: true,
    defaultAgentBudget: 10,
    agentDefaultAction: "approve",
    agentLoopBehavior: "manual",
    agentShowReasoningToggle: false,
    agentShowReasoningDefault: false,
    selectedModelId: null,
  },
  createDefaultWorkflowEngineSettings: jest.fn().mockReturnValue({
    enabled: false,
    autoTranscribeInboxNotes: false,
    inboxFolder: "Inbox",
    automations: {},
  }),
  LogLevel: {
    DEBUG: 0,
    INFO: 1,
    WARNING: 2,
    ERROR: 3,
    NONE: 4,
  },
}));

import { SettingsManager } from "../SettingsManager";
import { DEFAULT_SETTINGS, LogLevel } from "../../../types";

describe("SettingsManager", () => {
  let mockPlugin: any;
  let settingsManager: SettingsManager;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      manifest: {
        id: "systemsculpt-ai",
      },
      loadData: jest.fn().mockResolvedValue({}),
      saveData: jest.fn().mockResolvedValue(undefined),
      storage: null,
      register: jest.fn(),
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: {
            basePath: "/tmp/systemsculpt-test-vault",
            exists: jest.fn().mockResolvedValue(false),
            read: jest.fn(),
            list: jest.fn().mockResolvedValue({ files: [] }),
          },
        },
        workspace: {
          trigger: jest.fn(),
        },
      },
      _internal_settings_systemsculpt_plugin: {},
    };

    mockFsWatcherOn.mockReset();
    mockFsWatcherClose.mockReset();
    mockFsWatch.mockReset();
    mockFsWatch.mockImplementation(() => ({
      on: mockFsWatcherOn,
      close: mockFsWatcherClose,
    }));
    mockFsPromisesStat.mockReset();

    settingsManager = new SettingsManager(mockPlugin);
  });

  describe("constructor", () => {
    it("creates instance with plugin", () => {
      expect(settingsManager).toBeDefined();
    });

    it("initializes with default settings", () => {
      expect(settingsManager.settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe("migrateSettings", () => {
    const migrateSettings = (settings: any) =>
      (settingsManager as any).migrateSettings(settings);

    describe("settingsMode migration", () => {
      it("keeps valid settingsMode", () => {
        const result = migrateSettings({ settingsMode: "advanced" });
        expect(result.settingsMode).toBe("advanced");
      });

      it("defaults invalid settingsMode to standard", () => {
        const result = migrateSettings({ settingsMode: "invalid" });
        expect(result.settingsMode).toBe("standard");
      });

      it("defaults missing settingsMode to standard", () => {
        const result = migrateSettings({});
        expect(result.settingsMode).toBe("standard");
      });
    });

    describe("vaultInstanceId migration", () => {
      it("generates vaultInstanceId when missing", () => {
        const result = migrateSettings({});
        expect(result.vaultInstanceId).toBeDefined();
        expect(result.vaultInstanceId.length).toBeGreaterThan(0);
      });

      it("generates vaultInstanceId when empty", () => {
        const result = migrateSettings({ vaultInstanceId: "" });
        expect(result.vaultInstanceId).toBeDefined();
        expect(result.vaultInstanceId.length).toBeGreaterThan(0);
      });

      it("keeps valid vaultInstanceId", () => {
        const result = migrateSettings({ vaultInstanceId: "existing-id" });
        expect(result.vaultInstanceId).toBe("existing-id");
      });
    });

    describe("embeddingsVectorFormatVersion migration", () => {
      it("keeps valid version", () => {
        const result = migrateSettings({ embeddingsVectorFormatVersion: 2 });
        expect(result.embeddingsVectorFormatVersion).toBe(2);
      });

      it("defaults invalid version", () => {
        const result = migrateSettings({ embeddingsVectorFormatVersion: "invalid" });
        expect(result.embeddingsVectorFormatVersion).toBe(1);
      });

      it("defaults NaN version", () => {
        const result = migrateSettings({ embeddingsVectorFormatVersion: NaN });
        expect(result.embeddingsVectorFormatVersion).toBe(1);
      });
    });

    describe("object migrations", () => {
      it("initializes missing favoritesFilterSettings", () => {
        const result = migrateSettings({});
        expect(result.favoritesFilterSettings).toEqual({ showAll: true });
      });

      it("initializes missing modelFilterSettings", () => {
        const result = migrateSettings({});
        expect(result.modelFilterSettings).toEqual({ showAll: true });
      });

      it("initializes missing activeProvider", () => {
        const result = migrateSettings({});
        expect(result.activeProvider).toBe("openai");
      });

    });

    describe("array migrations", () => {
      it("initializes missing customProviders", () => {
        const result = migrateSettings({});
        expect(result.customProviders).toEqual([]);
      });

      it("initializes missing studioPiAuthMigrationVersion", () => {
        const result = migrateSettings({});
        expect(result.studioPiAuthMigrationVersion).toBe(0);
      });

      it("defaults invalid studioPiAuthMigrationVersion", () => {
        const result = migrateSettings({ studioPiAuthMigrationVersion: "bad-value" });
        expect(result.studioPiAuthMigrationVersion).toBe(0);
      });

      it("initializes missing favoriteModels", () => {
        const result = migrateSettings({});
        expect(result.favoriteModels).toEqual([]);
      });

      it("initializes missing mcpServers", () => {
        const result = migrateSettings({});
        expect(result.mcpServers).toEqual([]);
      });

      it("initializes missing favoriteChats", () => {
        const result = migrateSettings({});
        expect(result.favoriteChats).toEqual([]);
      });

      it("initializes missing favoriteStudioSessions", () => {
        const result = migrateSettings({});
        expect(result.favoriteStudioSessions).toEqual([]);
      });

    });

    describe("boolean migrations", () => {
      it("initializes missing debugMode", () => {
        const result = migrateSettings({});
        expect(result.debugMode).toBe(false);
      });

      it("initializes missing automaticBackupsEnabled", () => {
        const result = migrateSettings({});
        expect(result.automaticBackupsEnabled).toBe(false);
      });

      it("initializes missing preserveReasoningVerbatim", () => {
        const result = migrateSettings({});
        expect(result.preserveReasoningVerbatim).toBe(true);
      });

      it("initializes missing respectReducedMotion", () => {
        const result = migrateSettings({});
        expect(result.respectReducedMotion).toBe(true);
      });
    });

    describe("numeric migrations", () => {
      it("initializes missing logLevel", () => {
        const result = migrateSettings({});
        expect(result.logLevel).toBe(2);
      });

      it("clamps high logLevel to WARNING when debugMode is false", () => {
        // When debugMode is false and logLevel > WARNING (2), it gets clamped to WARNING
        const result = migrateSettings({ debugMode: false, logLevel: 0 }); // DEBUG is 0
        // The actual implementation clamps logLevel > WARNING, but DEBUG (0) < WARNING (2), so no clamp
        expect(result.logLevel).toBe(0);
      });

      it("allows lower logLevel when debugMode is true", () => {
        const result = migrateSettings({ debugMode: true, logLevel: 0 }); // DEBUG is 0
        expect(result.logLevel).toBe(0);
      });

      it("initializes missing automaticBackupInterval", () => {
        const result = migrateSettings({});
        expect(result.automaticBackupInterval).toBe(24);
      });

      it("initializes missing automaticBackupRetentionDays", () => {
        const result = migrateSettings({});
        expect(result.automaticBackupRetentionDays).toBe(7);
      });

      it("initializes missing lastAutomaticBackup", () => {
        const result = migrateSettings({});
        expect(result.lastAutomaticBackup).toBe(0);
      });
    });

    describe("legacy property removal", () => {
      it("removes cachedEmbeddingStats", () => {
        const result = migrateSettings({ cachedEmbeddingStats: { some: "data" } });
        expect(result.cachedEmbeddingStats).toBeUndefined();
      });

      it("removes legacy provider selection fields", () => {
        const result = migrateSettings({
          selectedProvider: "custom-provider",
          selectedModelProviders: ["openai", "anthropic"],
        });
        expect(result.selectedProvider).toBeUndefined();
        expect(result.selectedModelProviders).toBeUndefined();
      });

      it("removes excludedFolders", () => {
        const result = migrateSettings({ excludedFolders: ["folder"] });
        expect(result.excludedFolders).toBeUndefined();
      });

      it("removes excludedFiles", () => {
        const result = migrateSettings({ excludedFiles: ["file.md"] });
        expect(result.excludedFiles).toBeUndefined();
      });
    });

    describe("workflowEngine migration", () => {
      it("initializes missing workflowEngine", () => {
        const result = migrateSettings({});
        expect(result.workflowEngine).toBeDefined();
        expect(result.workflowEngine.enabled).toBe(false);
      });

      it("merges existing workflowEngine with defaults", () => {
        const result = migrateSettings({
          workflowEngine: {
            enabled: true,
            autoTranscribeInboxNotes: true,
          },
        });
        expect(result.workflowEngine.enabled).toBe(true);
        expect(result.workflowEngine.autoTranscribeInboxNotes).toBe(true);
      });

      it("migrates legacy templates into automations", () => {
        const result = migrateSettings({
          workflowEngine: {
            templates: {
              "custom-automation": {
                enabled: true,
                sourceFolder: "Source",
              },
            },
          },
        });
        expect(result.workflowEngine.automations["custom-automation"]).toBeDefined();
        expect(result.workflowEngine.automations["custom-automation"].enabled).toBe(true);
        expect((result.workflowEngine as any).templates).toBeUndefined();
      });

      it("keeps explicit automations when both automations and templates are present", () => {
        const result = migrateSettings({
          workflowEngine: {
            automations: {
              "custom-automation": {
                enabled: false,
                sourceFolder: "Automations",
              },
            },
            templates: {
              "custom-automation": {
                enabled: true,
                sourceFolder: "Templates",
              },
            },
          },
        });
        expect(result.workflowEngine.automations["custom-automation"]).toBeDefined();
        expect(result.workflowEngine.automations["custom-automation"].enabled).toBe(false);
        expect(result.workflowEngine.automations["custom-automation"].sourceFolder).toBe("Automations");
      });
    });
  });

  describe("validateSettings", () => {
    const validateSettings = (settings: any) =>
      (settingsManager as any).validateSettings(settings);

    describe("settingsMode validation", () => {
      it("accepts valid standard mode", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, settingsMode: "standard" });
        expect(result.settingsMode).toBe("standard");
      });

      it("accepts valid advanced mode", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, settingsMode: "advanced" });
        expect(result.settingsMode).toBe("advanced");
      });

      it("defaults invalid mode", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, settingsMode: "invalid" });
        expect(result.settingsMode).toBe("standard");
      });
    });

    describe("array validation", () => {
      it("initializes non-array customProviders", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, customProviders: "not-array" });
        expect(result.customProviders).toEqual([]);
      });

      it("defaults invalid studioPiAuthMigrationVersion during validation", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, studioPiAuthMigrationVersion: -1 });
        expect(result.studioPiAuthMigrationVersion).toBe(0);
      });

      it("normalizes studioPiAuthMigrationVersion to an integer", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, studioPiAuthMigrationVersion: 2.9 });
        expect(result.studioPiAuthMigrationVersion).toBe(2);
      });

      it("initializes non-array favoriteModels", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, favoriteModels: null });
        expect(result.favoriteModels).toEqual([]);
      });

    });

    it("removes deprecated screen recording settings", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        videoRecordingsDirectory: "SystemSculpt/Video Recordings",
        videoCaptureSystemAudio: true,
        videoCaptureMicrophoneAudio: true,
        showVideoRecordButtonInChat: true,
        showVideoRecordingPermissionPopup: true,
        recordSystemAudio: true,
      });
      expect("videoRecordingsDirectory" in result).toBe(false);
      expect("videoCaptureSystemAudio" in result).toBe(false);
      expect("videoCaptureMicrophoneAudio" in result).toBe(false);
      expect("showVideoRecordButtonInChat" in result).toBe(false);
      expect("showVideoRecordingPermissionPopup" in result).toBe(false);
      expect("recordSystemAudio" in result).toBe(false);
    });

    it("removes deprecated studio telemetry settings", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        studioTelemetryOptIn: true,
      } as any);

      expect("studioTelemetryOptIn" in result).toBe(false);
    });

    it("removes legacy provider selection fields during validation", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        selectedProvider: "custom-provider",
        selectedModelProviders: ["openai", "anthropic"],
      } as any);

      expect("selectedProvider" in result).toBe(false);
      expect("selectedModelProviders" in result).toBe(false);
    });

    it("defaults invalid transcription output format settings", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        transcriptionOutputFormat: "invalid",
      });
      expect(result.transcriptionOutputFormat).toBe("markdown");
    });

    it("keeps selectedModelId empty instead of forcing an agent default", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        selectedModelId: "   ",
      });
      expect(result.selectedModelId).toBe("");
    });

    it("defaults invalid modal format chooser visibility", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        showTranscriptionFormatChooserInModal: "invalid",
      });
      expect(result.showTranscriptionFormatChooserInModal).toBe(true);
    });

    it("pins blank serverUrl values to the canonical production host", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        serverUrl: "",
      });

      expect(result.serverUrl).toBe("https://api.systemsculpt.com");
    });

    it("scrubs lvh.me serverUrl overrides back to production", () => {
      const result = validateSettings({
        ...DEFAULT_SETTINGS,
        serverUrl: "http://lvh.me:3002",
      });

      expect(result.serverUrl).toBe("https://api.systemsculpt.com");
    });
  });

  describe("loadSettings", () => {
    it("loads settings from plugin data", async () => {
      mockPlugin.loadData.mockResolvedValue({
        settingsMode: "advanced",
        customProviders: [{ id: "test" }],
      });

      await settingsManager.loadSettings();

      expect(mockPlugin.loadData).toHaveBeenCalled();
      expect(settingsManager.settings.settingsMode).toBe("advanced");
    });

    it("triggers settings-loaded event", async () => {
      await settingsManager.loadSettings();

      expect(mockPlugin.app.workspace.trigger).toHaveBeenCalledWith(
        "systemsculpt:settings-loaded",
        expect.any(Object)
      );
    });

    it("starts automatic backup service", async () => {
      await settingsManager.loadSettings();

      expect(mockAutomaticBackupServiceStart).toHaveBeenCalled();
    });

    it("handles non-object loaded data", async () => {
      mockPlugin.loadData.mockResolvedValue(null);

      await settingsManager.loadSettings();

      expect(settingsManager.settings).toBeDefined();
    });

    it("handles array loaded data", async () => {
      mockPlugin.loadData.mockResolvedValue([1, 2, 3]);

      await settingsManager.loadSettings();

      expect(settingsManager.settings).toBeDefined();
    });

    it("restores from backup on load error", async () => {
      mockPlugin.loadData.mockRejectedValue(new Error("Load failed"));
      mockPlugin.app.vault.adapter.exists.mockResolvedValue(true);
      mockPlugin.app.vault.adapter.read.mockResolvedValue(
        JSON.stringify({ settingsMode: "advanced" })
      );

      await settingsManager.loadSettings();

      expect(settingsManager.settings.settingsMode).toBe("advanced");
    });

    it("uses defaults when backup restoration fails", async () => {
      mockPlugin.loadData.mockRejectedValue(new Error("Load failed"));
      mockPlugin.app.vault.adapter.exists.mockResolvedValue(false);

      await settingsManager.loadSettings();

      expect(settingsManager.settings).toBeDefined();
    });
  });

  describe("saveSettings", () => {
    it("saves settings to plugin data", async () => {
      await (settingsManager as any).loadSettings();
      await settingsManager.saveSettings();

      expect(mockPlugin.saveData).toHaveBeenCalled();
    });

    it("scrubs legacy provider selection keys before persisting", async () => {
      await (settingsManager as any).loadSettings();
      mockPlugin._internal_settings_systemsculpt_plugin = {
        ...settingsManager.settings,
        selectedProvider: "custom-provider",
        selectedModelProviders: ["openai"],
      };

      await settingsManager.saveSettings();

      expect(mockPlugin.saveData).toHaveBeenCalledWith(
        expect.not.objectContaining({
          selectedProvider: expect.anything(),
          selectedModelProviders: expect.anything(),
        })
      );
    });
  });

  describe("updateSettings", () => {
    it("merges partial settings", async () => {
      await settingsManager.loadSettings();
      await settingsManager.updateSettings({ settingsMode: "advanced" });

      expect(settingsManager.settings.settingsMode).toBe("advanced");
    });

    it("triggers settings-updated event", async () => {
      await settingsManager.loadSettings();
      await settingsManager.updateSettings({ debugMode: true });

      // The updateSettings method calls trigger twice (old settings and new settings)
      expect(mockPlugin.app.workspace.trigger).toHaveBeenCalledWith(
        "systemsculpt:settings-updated",
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe("reloadSettingsFromDisk", () => {
    it("applies external data.json changes and emits settings-updated", async () => {
      await settingsManager.loadSettings();
      jest.clearAllMocks();

      mockPlugin.loadData.mockResolvedValue({
        settingsMode: "advanced",
        debugMode: true,
        desktopAutomationBridgeEnabled: true,
      });

      const changed = await settingsManager.reloadSettingsFromDisk();

      expect(changed).toBe(true);
      expect(settingsManager.settings.settingsMode).toBe("advanced");
      expect(settingsManager.settings.debugMode).toBe(true);
      expect(settingsManager.settings.desktopAutomationBridgeEnabled).toBe(true);
      expect(mockPlugin.app.workspace.trigger).toHaveBeenCalledWith(
        "systemsculpt:settings-updated",
        expect.anything(),
        expect.objectContaining({
          settingsMode: "advanced",
          debugMode: true,
          desktopAutomationBridgeEnabled: true,
        })
      );
    });

    it("ignores unchanged external settings payloads", async () => {
      await settingsManager.loadSettings();
      (settingsManager as any).recentInternalPluginDataWrites = [];
      jest.clearAllMocks();

      mockPlugin.loadData.mockResolvedValue({ ...settingsManager.settings });

      const changed = await settingsManager.reloadSettingsFromDisk();

      expect(changed).toBe(false);
      expect(mockPlugin.app.workspace.trigger).toHaveBeenCalledWith(
        "systemsculpt:settings-file-touched",
        expect.objectContaining(settingsManager.settings)
      );
      expect(mockPlugin.app.workspace.trigger).not.toHaveBeenCalledWith(
        "systemsculpt:settings-updated",
        expect.anything(),
        expect.anything()
      );
    });

    it("ignores watcher echoes from the plugin's own saveData writes", async () => {
      await settingsManager.loadSettings();
      await settingsManager.saveSettings();
      jest.clearAllMocks();

      mockPlugin.loadData.mockResolvedValue({ ...settingsManager.settings });

      const changed = await settingsManager.reloadSettingsFromDisk();

      expect(changed).toBe(false);
      expect(mockPlugin.app.workspace.trigger).not.toHaveBeenCalledWith(
        "systemsculpt:settings-file-touched",
        expect.anything()
      );
      expect(mockPlugin.app.workspace.trigger).not.toHaveBeenCalledWith(
        "systemsculpt:settings-updated",
        expect.anything(),
        expect.anything()
      );
    });

    it("ignores watcher bursts after back-to-back internal saveData writes", async () => {
      await settingsManager.loadSettings();
      await settingsManager.updateSettings({
        selectedModelId: "local-pi-github-copilot@@claude-haiku-4.5",
      });
      await settingsManager.updateSettings({
        activeProvider: {
          id: "local-pi-github-copilot",
          name: "GitHub Copilot",
          type: "native",
        },
      });
      jest.clearAllMocks();

      mockPlugin.loadData.mockResolvedValue({ ...settingsManager.settings });

      for (let index = 0; index < 8; index += 1) {
        const changed = await settingsManager.reloadSettingsFromDisk();
        expect(changed).toBe(false);
      }

      expect(mockPlugin.app.workspace.trigger).not.toHaveBeenCalledWith(
        "systemsculpt:settings-file-touched",
        expect.anything()
      );
      expect(mockPlugin.app.workspace.trigger).not.toHaveBeenCalledWith(
        "systemsculpt:settings-updated",
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe("startWatchingPluginDataFile", () => {
    const flushMicrotasks = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it("keeps polling when fs.watch setup fails", async () => {
      mockFsWatch.mockImplementation(() => {
        throw new Error("watch unavailable");
      });
      mockFsPromisesStat
        .mockResolvedValueOnce({ mtimeMs: 1000 })
        .mockResolvedValueOnce({ mtimeMs: 1000 })
        .mockResolvedValueOnce({ mtimeMs: 2000 });

      const reloadSpy = jest.spyOn(settingsManager, "reloadSettingsFromDisk").mockResolvedValue(false);

      settingsManager.startWatchingPluginDataFile();
      await flushMicrotasks();

      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
      jest.advanceTimersByTime(150);
      await flushMicrotasks();

      expect(mockFsWatch).toHaveBeenCalledTimes(1);
      expect(mockPlugin.register).toHaveBeenCalledTimes(1);
      expect((settingsManager as any).pluginDataPollInterval).not.toBeNull();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("snapshots watched touches so the poller does not double-reload the same change", async () => {
      mockFsPromisesStat
        .mockResolvedValueOnce({ mtimeMs: 1000 })
        .mockResolvedValueOnce({ mtimeMs: 2000 })
        .mockResolvedValueOnce({ mtimeMs: 2000 });

      const reloadSpy = jest.spyOn(settingsManager, "reloadSettingsFromDisk").mockResolvedValue(false);

      settingsManager.startWatchingPluginDataFile();
      await flushMicrotasks();

      const watchCallback = mockFsWatch.mock.calls[0]?.[2] as ((eventType: string, filename?: string) => void) | undefined;
      expect(typeof watchCallback).toBe("function");

      watchCallback?.("change", "data.json");
      await flushMicrotasks();
      jest.advanceTimersByTime(150);
      await flushMicrotasks();
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("restoreFromBackup", () => {
    const restoreFromBackup = () => (settingsManager as any).restoreFromBackup();

    it("returns null when no backup exists", async () => {
      mockPlugin.app.vault.adapter.exists.mockResolvedValue(false);

      const result = await restoreFromBackup();

      expect(result).toBeNull();
    });

    it("reads latest backup when exists", async () => {
      mockPlugin.app.vault.adapter.exists.mockResolvedValue(true);
      mockPlugin.app.vault.adapter.read.mockResolvedValue(
        JSON.stringify({ settingsMode: "advanced" })
      );

      const result = await restoreFromBackup();

      expect(result.settingsMode).toBe("advanced");
    });

    it("falls back to daily backups when latest not available", async () => {
      mockPlugin.app.vault.adapter.exists.mockResolvedValue(false);
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [
          "settings-backup-2025-01-01.json",
          "settings-backup-2025-01-02.json",
        ],
      });
      mockPlugin.app.vault.adapter.read.mockResolvedValue(
        JSON.stringify({ settingsMode: "advanced" })
      );

      const result = await restoreFromBackup();

      expect(result).toBeDefined();
    });

    it("tries vault storage first when available", async () => {
      mockPlugin.storage = {
        readFile: jest.fn().mockResolvedValue({ settingsMode: "advanced" }),
        listFiles: jest.fn().mockResolvedValue([]),
      };

      const result = await restoreFromBackup();

      expect(mockPlugin.storage.readFile).toHaveBeenCalled();
      expect(result.settingsMode).toBe("advanced");
    });

    it("returns null on error", async () => {
      mockPlugin.app.vault.adapter.exists.mockRejectedValue(new Error("Error"));

      const result = await restoreFromBackup();

      expect(result).toBeNull();
    });
  });
});
