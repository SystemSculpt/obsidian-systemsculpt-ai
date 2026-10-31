import { Notice } from "obsidian";
import { AutomaticBackupService } from "../AutomaticBackupService";

// Mock Notice
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

const createMockPlugin = () => {
  const backupMtimes = new Map<string, number>();
  const adapter = {
    exists: jest.fn(async () => true),
    write: jest.fn(async (path: string) => {
      backupMtimes.set(path, Date.now());
    }),
    list: jest.fn(async () => ({ files: [...backupMtimes.keys()], folders: [] })),
    stat: jest.fn(async (path: string) => {
      const mtime = backupMtimes.get(path);
      return mtime === undefined ? null : { mtime };
    }),
    remove: jest.fn(async (path: string) => {
      backupMtimes.delete(path);
    }),
  };
  const vault = {
    createFolder: jest.fn(async () => {}),
    adapter,
  };
  const app = { vault } as any;
  const updateSettings = jest.fn(async () => {});
  const storage = {
    writeFile: jest.fn(async () => ({ success: true })),
    listFiles: jest.fn(async () => []),
    deleteFile: jest.fn(async () => {}),
  };
  return {
    app,
    storage,
    registerInterval: jest.fn((id: number) => id),
    getSettingsManager: () => ({
      getSettings: () => ({
        automaticBackupsEnabled: true,
        automaticBackupInterval: 24, // 24 hours
        automaticBackupRetentionDays: 30,
      }),
      updateSettings,
    }),
    _updateSettings: updateSettings,
  } as any;
};

describe("AutomaticBackupService", () => {
  let mockPlugin: ReturnType<typeof createMockPlugin>;
  let service: AutomaticBackupService;
  let setIntervalSpy: jest.SpyInstance;
  let clearIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-15T12:00:00Z"));
    setIntervalSpy = jest.spyOn(window, "setInterval");
    clearIntervalSpy = jest.spyOn(window, "clearInterval");
    mockPlugin = createMockPlugin();
    service = new AutomaticBackupService(mockPlugin);
  });

  afterEach(async () => {
    service.stop();
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  describe("constructor", () => {
    it("creates instance with plugin", () => {
      expect(service).toBeInstanceOf(AutomaticBackupService);
    });
  });

  describe("start", () => {
    it("starts the backup timer", () => {
      service.start();

      expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("sets interval to check every hour", () => {
      service.start();

      // CHECK_INTERVAL_MS is 60 * 60 * 1000 (1 hour)
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        60 * 60 * 1000
      );
    });

    it("arms one timer however often it is started", () => {
      service.start();
      service.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).not.toHaveBeenCalled();
    });

    it("arms no timer and writes nothing while automatic backups are off", async () => {
      const settings = mockPlugin.getSettingsManager().getSettings();
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({ ...settings, automaticBackupsEnabled: false }),
        updateSettings: mockPlugin._updateSettings,
      });

      service.start();
      await jest.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.list).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.stat).not.toHaveBeenCalled();
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });

    it("clears its timer when backups are turned off and arms it again when they are turned on", () => {
      let enabled = true;
      const settings = mockPlugin.getSettingsManager().getSettings();
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({ ...settings, automaticBackupsEnabled: enabled }),
        updateSettings: mockPlugin._updateSettings,
      });

      service.start();
      expect(jest.getTimerCount()).toBe(1);

      enabled = false;
      service.start();
      expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0].value);
      expect(jest.getTimerCount()).toBe(0);

      enabled = true;
      service.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(1);
    });

    it("arms nothing while the plugin unloads", () => {
      mockPlugin.isPluginUnloading = () => true;

      service.start();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("registers the interval with the plugin so Obsidian clears it on unload", () => {
      service.start();

      const timerId = setIntervalSpy.mock.results[0].value;
      expect(mockPlugin.registerInterval).toHaveBeenCalledWith(timerId);
    });

    it("checks for backup immediately on start", async () => {
      service.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("stops the backup timer", () => {
      service.start();
      service.stop();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it("does nothing if timer not started", () => {
      expect(() => service.stop()).not.toThrow();
    });

    it("can be called multiple times", () => {
      service.start();
      service.stop();
      service.stop();

      expect(() => service.stop()).not.toThrow();
    });
  });

  describe("scheduled backups", () => {
    it("creates a backup when the newest automatic backup mtime reaches the interval", async () => {
      const older = ".systemsculpt/settings-backups/settings-backup-2025-01-15.json";
      const newest = ".systemsculpt/settings-backups/settings-backup-2025-01-13.json";
      const oldest = ".systemsculpt/settings-backups/settings-backup-2025-01-14.json";
      const now = Date.now();
      const hour = 60 * 60 * 1000;
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [older, newest, oldest],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockImplementation(async (path: string) => ({
        mtime: now - (path === newest ? 23 : 48) * hour,
      }));

      service.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledWith(older);
      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledWith(newest);
      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledWith(oldest);
      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(hour);

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });

    it("respects the saved backup mtime after a fresh service starts", async () => {
      await service.createAutomaticBackup();
      mockPlugin.app.vault.adapter.write.mockClear();
      jest.setSystemTime(Date.now() + 23 * 60 * 60 * 1000);
      service = new AutomaticBackupService(mockPlugin);

      service.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledWith(
        ".systemsculpt/settings-backups/settings-backup-2025-01-15.json"
      );

      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });

    it("does not let latest-save snapshots or other non-automatic backups postpone dated history", async () => {
      const automatic = ".systemsculpt/settings-backups/settings-backup-2025-01-13.json";
      const otherBackups = [
        ".systemsculpt/settings-backups/settings-backup-latest.json",
        ".systemsculpt/settings-backups/settings-backup-manual-2025-01-15.json",
        ".systemsculpt/settings-backups/settings-backup-emergency-2025-01-15.json",
        ".systemsculpt/settings-backups/settings-backup-premigration-v3.json",
      ];
      const now = Date.now();
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [automatic, ...otherBackups],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockImplementation(async (path: string) => ({
        mtime: path === automatic ? now - 48 * 60 * 60 * 1000 : now,
      }));

      service.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      for (const path of otherBackups) {
        expect(mockPlugin.app.vault.adapter.stat).not.toHaveBeenCalledWith(path);
      }
    });

    it("still considers readable backups when another backup is missing or cannot be statted", async () => {
      const missing = ".systemsculpt/settings-backups/settings-backup-2025-01-13.json";
      const unreadable = ".systemsculpt/settings-backups/settings-backup-2025-01-14.json";
      const recent = ".systemsculpt/settings-backups/settings-backup-2025-01-15.json";
      const now = Date.now();
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [missing, unreadable, recent],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockImplementation(async (path: string) => {
        if (path === missing) return null;
        if (path === unreadable) throw new Error("Stat failed");
        return { mtime: now };
      });

      service.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledWith(recent);
      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
    });

    it("creates the first backup when the backup directory cannot be listed", async () => {
      mockPlugin.app.vault.adapter.list.mockRejectedValue(new Error("Directory missing"));

      service.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(Notice).not.toHaveBeenCalled();
    });

    it("handles unreadable settings without arming a timer", () => {
      mockPlugin.getSettingsManager = () => {
        throw new Error("Settings error");
      };

      expect(() => service.start()).not.toThrow();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    });
  });

  describe("createAutomaticBackup", () => {
    it("returns true on success", async () => {
      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
    });

    it("creates backup with metadata", async () => {
      await service.createAutomaticBackup();

      const writeCall = mockPlugin.app.vault.adapter.write.mock.calls[0];
      const backupData = JSON.parse(writeCall[1]);

      expect(backupData._backupMeta).toBeDefined();
      expect(backupData._backupMeta.type).toBe("automatic");
      expect(backupData._backupMeta.version).toBe("1.1");
      expect(backupData._backupMeta.redactedSecrets).toBe(true);
      expect(backupData._backupMeta.timestamp).toBeGreaterThan(0);
      expect(backupData._backupMeta.createdAt).toBeDefined();
    });

    it("redacts secrets from automatic backups", async () => {
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({
          automaticBackupsEnabled: true,
          automaticBackupInterval: 24,
          automaticBackupRetentionDays: 30,
          licenseKey: "license-secret",
          openAiApiKey: "openai-secret",
          customTranscriptionApiKey: "transcription-secret",
          embeddingsCustomApiKey: "embeddings-secret",
          readwiseApiToken: "readwise-secret",
          customProviders: [
            { id: "provider-a", endpoint: "https://api.example.com", apiKey: "provider-secret" },
          ],
          mcpServers: [
            { id: "mcp-a", transport: "http", apiKey: "mcp-secret", isEnabled: true },
          ],
        }),
        updateSettings: mockPlugin._updateSettings,
      });

      service = new AutomaticBackupService(mockPlugin);
      await service.createAutomaticBackup();

      const writeCall = mockPlugin.app.vault.adapter.write.mock.calls[0];
      const backupData = JSON.parse(writeCall[1]);

      expect(backupData.licenseKey).toBe("");
      expect(backupData).not.toHaveProperty("openAiApiKey");
      expect(backupData).not.toHaveProperty("customTranscriptionApiKey");
      expect(backupData).not.toHaveProperty("embeddingsCustomApiKey");
      expect(backupData).not.toHaveProperty("readwiseApiToken");
      expect(backupData).not.toHaveProperty("customProviders");
      expect(backupData).not.toHaveProperty("mcpServers");
    });

    it("generates filename with current date", async () => {
      const mockDate = new Date("2025-01-15T12:00:00Z");
      jest.setSystemTime(mockDate);

      await service.createAutomaticBackup();

      const writeCall = mockPlugin.app.vault.adapter.write.mock.calls[0];
      expect(writeCall[0]).toContain("settings-backup-2025-01-15.json");
    });

    it("saves to vault adapter", async () => {
      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledWith(
        expect.stringContaining(".systemsculpt/settings-backups/"),
        expect.any(String)
      );
    });

    it("writes each backup once, to settings-backups only", async () => {
      jest.setSystemTime(new Date("2025-01-15T12:00:00Z"));

      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.adapter.write.mock.calls.map(([path]: [string]) => path)).toEqual([
        ".systemsculpt/settings-backups/settings-backup-2025-01-15.json",
      ]);
      expect(mockPlugin.storage.writeFile).not.toHaveBeenCalled();
    });

    it("creates a backup without cascading a settings save", async () => {
      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });

    it("creates backup directory if it does not exist", async () => {
      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.createFolder).toHaveBeenCalledWith(
        ".systemsculpt/settings-backups"
      );
    });

    it("handles existing directory gracefully", async () => {
      mockPlugin.app.vault.createFolder.mockRejectedValue(
        new Error("Folder already exists")
      );

      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
    });

    it("returns false on error", async () => {
      mockPlugin.app.vault.adapter.write.mockRejectedValue(
        new Error("Write failed")
      );

      const result = await service.createAutomaticBackup();

      expect(result).toBe(false);
    });

    it("shows notice on error", async () => {
      mockPlugin.app.vault.adapter.write.mockRejectedValue(
        new Error("Write failed")
      );

      await service.createAutomaticBackup();

      expect(Notice).toHaveBeenCalledWith(
        "Failed to create automatic settings backup",
        3000
      );
    });

    it("does not fall back to the hidden folder when the backup cannot be written", async () => {
      mockPlugin.app.vault.adapter.write.mockRejectedValue(
        new Error("Adapter write failed")
      );

      const result = await service.createAutomaticBackup();

      expect(result).toBe(false);
      expect(mockPlugin.storage.writeFile).not.toHaveBeenCalled();
    });

    it("handles missing storage gracefully", async () => {
      mockPlugin.storage = null;

      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
    });

    it("does not report a saved backup when the write fails", async () => {
      mockPlugin.app.vault.adapter.write.mockRejectedValue(new Error("disk full"));

      expect(await service.createAutomaticBackup()).toBe(false);
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.remove).not.toHaveBeenCalled();
    });
  });

  describe("backup retention", () => {
    it("cleans up old backups after creating new one", async () => {
      const oldBackupFile =
        ".systemsculpt/settings-backups/settings-backup-2024-01-01.json";
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [oldBackupFile],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({
        mtime: new Date("2024-01-01").getTime(),
      });

      await service.createAutomaticBackup();

      // Should attempt to clean up old backups
      expect(mockPlugin.app.vault.adapter.list).toHaveBeenCalled();
    });

    it("removes backups older than retention period", async () => {
      const now = Date.now();
      const oldDate = new Date(now - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      const oldBackupFile = `.systemsculpt/settings-backups/settings-backup-${oldDate.toISOString().split("T")[0]}.json`;

      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [oldBackupFile],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({
        mtime: oldDate.getTime(),
      });

      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.adapter.remove).toHaveBeenCalledWith(
        oldBackupFile
      );
    });

    it("keeps backups within retention period", async () => {
      const recentDate = new Date();
      const recentBackupFile = `.systemsculpt/settings-backups/settings-backup-${recentDate.toISOString().split("T")[0]}.json`;

      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [recentBackupFile],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({
        mtime: recentDate.getTime(),
      });

      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.adapter.remove).not.toHaveBeenCalled();
    });

    it("does not remove manual backups", async () => {
      const manualBackupFile =
        ".systemsculpt/settings-backups/settings-backup-manual-2024-01-01.json";
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [manualBackupFile],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({
        mtime: new Date("2024-01-01").getTime(),
      });

      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.adapter.remove).not.toHaveBeenCalled();
    });

    it("does not remove emergency backups", async () => {
      const emergencyBackupFile =
        ".systemsculpt/settings-backups/settings-backup-emergency-2024-01-01.json";
      mockPlugin.app.vault.adapter.list.mockResolvedValue({
        files: [emergencyBackupFile],
        folders: [],
      });
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({
        mtime: new Date("2024-01-01").getTime(),
      });

      await service.createAutomaticBackup();

      expect(mockPlugin.app.vault.adapter.remove).not.toHaveBeenCalled();
    });

    it("handles missing backup directory", async () => {
      mockPlugin.app.vault.adapter.exists.mockResolvedValue(false);

      await expect(service.createAutomaticBackup()).resolves.toBe(true);
    });

    it("handles list errors gracefully", async () => {
      mockPlugin.app.vault.adapter.list.mockRejectedValue(
        new Error("List failed")
      );

      await expect(service.createAutomaticBackup()).resolves.toBe(true);
    });

    it("still prunes old copies an older version wrote to the hidden folder", async () => {
      const oldBackup = "settings-backup-2024-01-01.json";
      mockPlugin.storage.listFiles.mockResolvedValue([oldBackup]);

      await service.createAutomaticBackup();

      expect(mockPlugin.storage.listFiles).toHaveBeenCalledWith(
        "settings",
        "backups"
      );
    });

    it("deletes old hidden copies past retention", async () => {
      const oldBackup = "settings-backup-2024-01-01.json";
      mockPlugin.storage.listFiles.mockResolvedValue([oldBackup]);

      await service.createAutomaticBackup();

      expect(mockPlugin.storage.deleteFile).toHaveBeenCalledWith(
        "settings",
        "backups/settings-backup-2024-01-01.json"
      );
    });

    it("skips cleanup when storage is null", async () => {
      mockPlugin.storage = null;

      await expect(service.createAutomaticBackup()).resolves.toBe(true);
    });

    it("handles storage list errors", async () => {
      mockPlugin.storage.listFiles.mockRejectedValue(
        new Error("Storage list failed")
      );

      await expect(service.createAutomaticBackup()).resolves.toBe(true);
    });

    it("handles storage delete errors", async () => {
      mockPlugin.storage.listFiles.mockResolvedValue([
        "settings-backup-2024-01-01.json",
      ]);
      mockPlugin.storage.deleteFile.mockRejectedValue(
        new Error("Delete failed")
      );

      await expect(service.createAutomaticBackup()).resolves.toBe(true);
    });
  });

  describe("timer behavior", () => {
    it("checks hourly without writing another backup before the configured interval", async () => {
      service.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      mockPlugin.app.vault.adapter.write.mockClear();

      await jest.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);

      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledTimes(1);
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });

    it("does not read or write backups after the setting is disabled between checks", async () => {
      let enabled = true;
      const settings = mockPlugin.getSettingsManager().getSettings();
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({ ...settings, automaticBackupsEnabled: enabled }),
        updateSettings: mockPlugin._updateSettings,
      });
      service.start();
      await jest.advanceTimersByTimeAsync(0);
      mockPlugin.app.vault.adapter.write.mockClear();
      mockPlugin.app.vault.adapter.list.mockClear();
      mockPlugin.app.vault.adapter.stat.mockClear();
      enabled = false;

      await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.list).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.stat).not.toHaveBeenCalled();
      expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
    });

    it("arms nothing when settings cannot be read", async () => {
      mockPlugin.getSettingsManager = () => {
        throw new Error("Settings error");
      };

      service = new AutomaticBackupService(mockPlugin);
      service.start();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });
  });
});
