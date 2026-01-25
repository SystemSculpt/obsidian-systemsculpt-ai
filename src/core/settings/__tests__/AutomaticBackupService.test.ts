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
  const adapter = {
    exists: jest.fn(async () => true),
    write: jest.fn(async () => {}),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async () => ({ mtime: Date.now() })),
    remove: jest.fn(async () => {}),
  };
  const vault = {
    createFolder: jest.fn(async () => {}),
    adapter,
  };
  const app = { vault } as any;
  const updateSettings = jest.fn(async () => {});
  const storage = {
    writeFile: jest.fn(async () => {}),
    listFiles: jest.fn(async () => []),
    deleteFile: jest.fn(async () => {}),
  };
  return {
    app,
    storage,
    getSettingsManager: () => ({
      getSettings: () => ({
        automaticBackupsEnabled: true,
        automaticBackupInterval: 24, // 24 hours
        automaticBackupRetentionDays: 30,
        lastAutomaticBackup: 0,
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
    setIntervalSpy = jest.spyOn(global, "setInterval");
    clearIntervalSpy = jest.spyOn(global, "clearInterval");
    mockPlugin = createMockPlugin();
    service = new AutomaticBackupService(mockPlugin);
  });

  afterEach(() => {
    service.stop();
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

    it("stops existing timer before starting new one", () => {
      service.start();
      service.start();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it("checks for backup immediately on start", async () => {
      // With lastAutomaticBackup = 0, backup should be needed
      const writeSpy = mockPlugin.app.vault.adapter.write;

      service.start();

      // Allow microtasks to complete (the immediate check is async)
      await Promise.resolve();
      await Promise.resolve();

      expect(writeSpy).toHaveBeenCalled();
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

  describe("checkAndCreateBackup (private)", () => {
    it("skips backup when automatic backups disabled", async () => {
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({
          automaticBackupsEnabled: false,
          automaticBackupInterval: 24,
          automaticBackupRetentionDays: 30,
          lastAutomaticBackup: 0,
        }),
        updateSettings: jest.fn(),
      });

      service = new AutomaticBackupService(mockPlugin);
      service.start();

      // Allow microtasks to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
    });

    it("creates backup when interval has passed", async () => {
      // lastAutomaticBackup is 0, so backup should be needed
      service.start();

      // Allow microtasks to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalled();
    });

    it("skips backup when interval has not passed", async () => {
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({
          automaticBackupsEnabled: true,
          automaticBackupInterval: 24,
          automaticBackupRetentionDays: 30,
          lastAutomaticBackup: Date.now(), // Just backed up
        }),
        updateSettings: jest.fn(),
      });

      service = new AutomaticBackupService(mockPlugin);
      service.start();

      // Allow microtasks to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
    });

    it("handles errors gracefully", async () => {
      mockPlugin.getSettingsManager = () => {
        throw new Error("Settings error");
      };

      service = new AutomaticBackupService(mockPlugin);

      expect(() => service.start()).not.toThrow();
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
      expect(backupData._backupMeta.version).toBe("1.0");
      expect(backupData._backupMeta.timestamp).toBeGreaterThan(0);
      expect(backupData._backupMeta.createdAt).toBeDefined();
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

    it("saves to vault storage when available", async () => {
      await service.createAutomaticBackup();

      expect(mockPlugin.storage.writeFile).toHaveBeenCalledWith(
        "settings",
        expect.stringContaining("backups/"),
        expect.any(Object)
      );
    });

    it("updates lastAutomaticBackup timestamp", async () => {
      await service.createAutomaticBackup();

      expect(mockPlugin._updateSettings).toHaveBeenCalledWith({
        lastAutomaticBackup: expect.any(Number),
      });
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
      mockPlugin.storage.writeFile.mockRejectedValue(
        new Error("Storage write failed")
      );

      const result = await service.createAutomaticBackup();

      expect(result).toBe(false);
    });

    it("shows notice on error", async () => {
      mockPlugin.app.vault.adapter.write.mockRejectedValue(
        new Error("Write failed")
      );
      mockPlugin.storage.writeFile.mockRejectedValue(
        new Error("Storage write failed")
      );

      await service.createAutomaticBackup();

      expect(Notice).toHaveBeenCalledWith(
        "Failed to create automatic settings backup",
        3000
      );
    });

    it("succeeds if only vault adapter works", async () => {
      mockPlugin.storage.writeFile.mockRejectedValue(
        new Error("Storage write failed")
      );

      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
    });

    it("succeeds if only vault storage works", async () => {
      mockPlugin.app.vault.adapter.write.mockRejectedValue(
        new Error("Adapter write failed")
      );

      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
    });

    it("handles missing storage gracefully", async () => {
      mockPlugin.storage = null;

      const result = await service.createAutomaticBackup();

      expect(result).toBe(true);
    });
  });

  describe("cleanupOldBackups (private)", () => {
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

    it("cleans up from vault storage", async () => {
      const oldBackup = "settings-backup-2024-01-01.json";
      mockPlugin.storage.listFiles.mockResolvedValue([oldBackup]);

      await service.createAutomaticBackup();

      expect(mockPlugin.storage.listFiles).toHaveBeenCalledWith(
        "settings",
        "backups"
      );
    });

    it("deletes old backups from vault storage", async () => {
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

  describe("getBackupStatus", () => {
    it("returns current backup status", () => {
      const status = service.getBackupStatus();

      expect(status).toEqual({
        enabled: true,
        lastBackup: 0,
        nextBackup: expect.any(Number),
        intervalHours: 24,
        retentionDays: 30,
      });
    });

    it("calculates next backup time correctly", () => {
      const lastBackup = Date.now() - 60 * 60 * 1000; // 1 hour ago
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({
          automaticBackupsEnabled: true,
          automaticBackupInterval: 24,
          automaticBackupRetentionDays: 30,
          lastAutomaticBackup: lastBackup,
        }),
        updateSettings: jest.fn(),
      });

      service = new AutomaticBackupService(mockPlugin);
      const status = service.getBackupStatus();

      // Next backup should be lastBackup + 24 hours
      expect(status.nextBackup).toBe(lastBackup + 24 * 60 * 60 * 1000);
    });

    it("reflects disabled state", () => {
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({
          automaticBackupsEnabled: false,
          automaticBackupInterval: 24,
          automaticBackupRetentionDays: 30,
          lastAutomaticBackup: 0,
        }),
        updateSettings: jest.fn(),
      });

      service = new AutomaticBackupService(mockPlugin);
      const status = service.getBackupStatus();

      expect(status.enabled).toBe(false);
    });

    it("returns custom interval hours", () => {
      mockPlugin.getSettingsManager = () => ({
        getSettings: () => ({
          automaticBackupsEnabled: true,
          automaticBackupInterval: 12,
          automaticBackupRetentionDays: 7,
          lastAutomaticBackup: 0,
        }),
        updateSettings: jest.fn(),
      });

      service = new AutomaticBackupService(mockPlugin);
      const status = service.getBackupStatus();

      expect(status.intervalHours).toBe(12);
      expect(status.retentionDays).toBe(7);
    });
  });

  describe("timer behavior", () => {
    it("calls checkAndCreateBackup periodically", async () => {
      service.start();

      // Allow initial check to complete
      await Promise.resolve();
      await Promise.resolve();

      // Clear write calls from initial check
      mockPlugin.app.vault.adapter.write.mockClear();

      // Advance time by 1 hour (use advanceTimersByTime, not async version)
      jest.advanceTimersByTime(60 * 60 * 1000);

      // Allow the async callback to complete
      await Promise.resolve();
      await Promise.resolve();

      // Should have been called again after 1 hour
      expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalled();
    });

    it("continues running after errors", async () => {
      mockPlugin.getSettingsManager = () => {
        throw new Error("Settings error");
      };

      service = new AutomaticBackupService(mockPlugin);
      service.start();

      // The timer should still be set even if checkAndCreateBackup fails
      expect(setIntervalSpy).toHaveBeenCalled();
    });
  });
});
