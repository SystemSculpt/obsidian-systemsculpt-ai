/** @jest-environment node */

jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
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
