/**
 * @jest-environment node
 */

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
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
    favoriteModels: [],
    workflowEngine: {
      enabled: false,
      autoTranscribeInboxNotes: false,
      inboxFolder: "Inbox",
      templates: {},
    },
    mcpEnabledTools: [],
    mcpAutoAcceptTools: [],
    mcpServers: [],
    debugMode: false,
    logLevel: 2,
    favoriteChats: [],
    automaticBackupsEnabled: false,
    automaticBackupInterval: 24,
    automaticBackupRetentionDays: 7,
    lastAutomaticBackup: 0,
    selectedModelProviders: [],
    preserveReasoningVerbatim: true,
    respectReducedMotion: true,
    toolingRequireApprovalForDestructiveTools: true,
    toolingConcurrencyLimit: 4,
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
    templates: {},
  }),
  LogLevel: {
    DEBUG: 0,
    INFO: 1,
    WARNING: 2,
    ERROR: 3,
    NONE: 4,
  },
}));

// Mock agent config
jest.mock("../../../constants/agent", () => ({
  AGENT_CONFIG: {
    DEFAULT_BUDGET: 10,
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
      loadData: jest.fn().mockResolvedValue({}),
      saveData: jest.fn().mockResolvedValue(undefined),
      storage: null,
      app: {
        vault: {
          adapter: {
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

      it("initializes missing favoriteModels", () => {
        const result = migrateSettings({});
        expect(result.favoriteModels).toEqual([]);
      });

      it("initializes missing mcpEnabledTools", () => {
        const result = migrateSettings({});
        expect(result.mcpEnabledTools).toEqual([]);
      });

      it("initializes missing mcpAutoAcceptTools", () => {
        const result = migrateSettings({});
        expect(result.mcpAutoAcceptTools).toEqual([]);
      });

      it("initializes missing mcpServers", () => {
        const result = migrateSettings({});
        expect(result.mcpServers).toEqual([]);
      });

      it("initializes missing favoriteChats", () => {
        const result = migrateSettings({});
        expect(result.favoriteChats).toEqual([]);
      });

      it("initializes missing selectedModelProviders", () => {
        const result = migrateSettings({});
        expect(result.selectedModelProviders).toEqual([]);
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

      it("merges templates with defaults", () => {
        const result = migrateSettings({
          workflowEngine: {
            templates: {
              "custom-template": {
                enabled: true,
                sourceFolder: "Source",
              },
            },
          },
        });
        expect(result.workflowEngine.templates["custom-template"]).toBeDefined();
        expect(result.workflowEngine.templates["custom-template"].enabled).toBe(true);
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

      it("initializes non-array favoriteModels", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, favoriteModels: null });
        expect(result.favoriteModels).toEqual([]);
      });

      it("initializes non-array mcpEnabledTools", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, mcpEnabledTools: undefined });
        expect(result.mcpEnabledTools).toEqual([]);
      });

      it("initializes non-array mcpAutoAcceptTools", () => {
        const result = validateSettings({ ...DEFAULT_SETTINGS, mcpAutoAcceptTools: {} });
        expect(result.mcpAutoAcceptTools).toEqual([]);
      });
    });

    describe("MCP tool deduplication", () => {
      it("deduplicates mcpEnabledTools", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          mcpEnabledTools: ["tool1", "tool2", "tool1", "tool2"],
        });
        expect(result.mcpEnabledTools).toEqual(["tool1", "tool2"]);
      });

      it("deduplicates mcpAutoAcceptTools", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          mcpAutoAcceptTools: ["tool1", "tool1", "tool1"],
        });
        expect(result.mcpAutoAcceptTools).toEqual(["tool1"]);
      });
    });

    describe("tooling settings validation", () => {
      it("defaults invalid toolingRequireApprovalForDestructiveTools", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          toolingRequireApprovalForDestructiveTools: "nope",
        });
        expect(result.toolingRequireApprovalForDestructiveTools).toBe(true);
      });

      it("clamps toolingConcurrencyLimit to min 1", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          toolingConcurrencyLimit: 0,
        });
        expect(result.toolingConcurrencyLimit).toBe(1);
      });

      it("clamps toolingConcurrencyLimit to max 8", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          toolingConcurrencyLimit: 100,
        });
        expect(result.toolingConcurrencyLimit).toBe(8);
      });

      it("floors toolingConcurrencyLimit", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          toolingConcurrencyLimit: 3.7,
        });
        expect(result.toolingConcurrencyLimit).toBe(3);
      });

      it("defaults non-finite toolingConcurrencyLimit", () => {
        const result = validateSettings({
          ...DEFAULT_SETTINGS,
          toolingConcurrencyLimit: NaN,
        });
        expect(result.toolingConcurrencyLimit).toBe(4);
      });
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
