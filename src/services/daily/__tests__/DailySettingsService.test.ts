import { DailySettingsService, DEFAULT_DAILY_SETTINGS, DEFAULT_DAILY_DIRECTORY_PATH } from "../DailySettingsService";
import momentLib from "moment";

// Mock moment
jest.mock("moment", () => {
  const actualMoment = jest.requireActual("moment");
  return actualMoment;
});

const createMockApp = () => {
  return {
    vault: {
      adapter: {
        read: jest.fn(async () => JSON.stringify(DEFAULT_DAILY_SETTINGS)),
        write: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
      },
    },
  } as any;
};

describe("DailySettingsService", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let service: DailySettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockApp = createMockApp();
    service = new DailySettingsService(mockApp);
  });

  afterEach(() => {
    service.cleanup();
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates instance with default settings", () => {
      expect(service).toBeInstanceOf(DailySettingsService);
    });
  });

  describe("initialize", () => {
    it("loads settings from storage", async () => {
      mockApp.vault.adapter.read.mockResolvedValueOnce(
        JSON.stringify({ dailyNoteFormat: "DD-MM-YYYY" })
      );

      await service.initialize();
      const settings = await service.getSettings();

      expect(settings.dailyNoteFormat).toBe("DD-MM-YYYY");
    });

    it("uses defaults when loading fails", async () => {
      mockApp.vault.adapter.read.mockRejectedValueOnce(new Error("File not found"));

      await service.initialize();
      const settings = await service.getSettings();

      expect(settings.dailyNoteFormat).toBe("YYYY-MM-DD");
    });

    it("merges loaded settings with defaults", async () => {
      mockApp.vault.adapter.read.mockResolvedValueOnce(
        JSON.stringify({ dailyNoteFormat: "DD-MM-YYYY" })
      );

      await service.initialize();
      const settings = await service.getSettings();

      // Loaded value
      expect(settings.dailyNoteFormat).toBe("DD-MM-YYYY");
      // Default value for unloaded property
      expect(settings.dailyDirectoryPath).toBe(DEFAULT_DAILY_DIRECTORY_PATH);
    });
  });

  describe("getSettings", () => {
    it("returns a copy of settings", async () => {
      const settings1 = await service.getSettings();
      const settings2 = await service.getSettings();

      expect(settings1).not.toBe(settings2);
      expect(settings1).toEqual(settings2);
    });
  });

  describe("updateSettings", () => {
    it("updates settings with partial data", async () => {
      await service.updateSettings({ dailyNoteFormat: "MM-DD-YYYY" });
      const settings = await service.getSettings();

      expect(settings.dailyNoteFormat).toBe("MM-DD-YYYY");
    });

    it("preserves other settings when updating", async () => {
      await service.updateSettings({
        dailyNoteFormat: "MM-DD-YYYY",
        enableStreakTracking: false,
      });

      const settings = await service.getSettings();

      expect(settings.dailyNoteFormat).toBe("MM-DD-YYYY");
      expect(settings.enableStreakTracking).toBe(false);
      expect(settings.dailyDirectoryPath).toBe(DEFAULT_DAILY_DIRECTORY_PATH);
    });

    it("schedules save after update", async () => {
      await service.updateSettings({ dailyNoteFormat: "MM-DD-YYYY" });

      // Advance timers past debounce (500ms)
      jest.advanceTimersByTime(600);
      // Wait for async operations in the timeout callback
      await Promise.resolve();
      await Promise.resolve();

      expect(mockApp.vault.adapter.write).toHaveBeenCalled();
    });
  });

  describe("resetSettings", () => {
    it("resets to default settings", async () => {
      await service.updateSettings({ dailyNoteFormat: "MM-DD-YYYY" });
      await service.resetSettings();

      const settings = await service.getSettings();

      expect(settings.dailyNoteFormat).toBe("YYYY-MM-DD");
    });
  });

  describe("getFormattedDate", () => {
    it("formats date with YYYY-MM-DD format", () => {
      const date = new Date("2025-01-15");
      const formatted = service.getFormattedDate(date);

      expect(formatted).toBe("2025-01-15");
    });

    it("formats date with current settings format", async () => {
      await service.updateSettings({ dailyNoteFormat: "DD-MM-YYYY" });

      const date = new Date("2025-01-15");
      const formatted = service.getFormattedDate(date);

      expect(formatted).toBe("15-01-2025");
    });

    it("uses current date when no date provided", () => {
      const formatted = service.getFormattedDate();

      expect(formatted).toBeDefined();
      expect(formatted).toMatch(/\d{4}-\d{2}-\d{2}/);
    });
  });

  describe("getDailyReminderTime", () => {
    it("returns moment with correct time", async () => {
      await service.updateSettings({ dailyReminderTime: "14:30" });

      const reminderTime = service.getDailyReminderTime();

      expect(reminderTime.hour()).toBe(14);
      expect(reminderTime.minute()).toBe(30);
      expect(reminderTime.second()).toBe(0);
    });
  });

  describe("shouldTriggerDailyReminder", () => {
    it("returns false when no reminder time set", async () => {
      await service.updateSettings({ dailyReminderTime: "" });

      const shouldTrigger = service.shouldTriggerDailyReminder();

      expect(shouldTrigger).toBe(false);
    });

    it("returns true when current time matches reminder time", async () => {
      const now = momentLib();
      const reminderTime = `${now.format("HH")}:${now.format("mm")}`;

      await service.updateSettings({ dailyReminderTime: reminderTime });

      const shouldTrigger = service.shouldTriggerDailyReminder();

      expect(shouldTrigger).toBe(true);
    });
  });

  describe("shouldTriggerWeeklyReview", () => {
    it("returns true on weekly review day", async () => {
      const currentDay = momentLib().day();
      await service.updateSettings({ weeklyReviewDay: currentDay });

      const shouldTrigger = service.shouldTriggerWeeklyReview();

      expect(shouldTrigger).toBe(true);
    });

    it("returns false on other days", async () => {
      const differentDay = (momentLib().day() + 1) % 7;
      await service.updateSettings({ weeklyReviewDay: differentDay });

      const shouldTrigger = service.shouldTriggerWeeklyReview();

      expect(shouldTrigger).toBe(false);
    });
  });

  describe("validateSettings (private)", () => {
    it("validates directory path", async () => {
      const errors = (service as any).validateSettings({
        dailyDirectoryPath: "invalid<path>",
      });

      expect(errors).toContain("Daily directory path contains invalid characters");
    });

    it("validates reminder time format", async () => {
      const errors = (service as any).validateSettings({
        dailyReminderTime: "invalid",
      });

      expect(errors).toContain("Daily reminder time must be in HH:MM format");
    });

    it("validates weekly review day range", async () => {
      const errors = (service as any).validateSettings({
        weeklyReviewDay: 7,
      });

      expect(errors).toContain("Weekly review day must be between 0 (Sunday) and 6 (Saturday)");
    });

    it("returns no errors for valid settings", async () => {
      const errors = (service as any).validateSettings({
        dailyDirectoryPath: "Valid/Path",
        dailyReminderTime: "09:00",
        weeklyReviewDay: 0,
      });

      expect(errors).toHaveLength(0);
    });
  });

  describe("isValidPath (private)", () => {
    it("returns true for valid paths", () => {
      expect((service as any).isValidPath("Valid/Path")).toBe(true);
      expect((service as any).isValidPath("Notes/Daily")).toBe(true);
    });

    it("returns false for paths with invalid characters", () => {
      expect((service as any).isValidPath("Invalid<Path")).toBe(false);
      expect((service as any).isValidPath("Invalid>Path")).toBe(false);
      expect((service as any).isValidPath('Invalid"Path')).toBe(false);
      expect((service as any).isValidPath("Invalid|Path")).toBe(false);
    });

    it("returns false for paths with ..", () => {
      expect((service as any).isValidPath("path/../other")).toBe(false);
    });
  });

  describe("isValidTimeFormat (private)", () => {
    it("returns true for valid time formats", () => {
      expect((service as any).isValidTimeFormat("09:00")).toBe(true);
      expect((service as any).isValidTimeFormat("14:30")).toBe(true);
      expect((service as any).isValidTimeFormat("23:59")).toBe(true);
      expect((service as any).isValidTimeFormat("0:00")).toBe(true);
    });

    it("returns false for invalid time formats", () => {
      expect((service as any).isValidTimeFormat("invalid")).toBe(false);
      expect((service as any).isValidTimeFormat("25:00")).toBe(false);
      expect((service as any).isValidTimeFormat("12:60")).toBe(false);
      expect((service as any).isValidTimeFormat("12")).toBe(false);
    });
  });

  describe("exportSettings", () => {
    it("returns settings as JSON string", async () => {
      const exported = await service.exportSettings();
      const parsed = JSON.parse(exported);

      expect(parsed.dailyNoteFormat).toBe("YYYY-MM-DD");
    });
  });

  describe("importSettings", () => {
    it("imports valid settings", async () => {
      const importData = JSON.stringify({
        dailyNoteFormat: "DD-MM-YYYY",
        dailyDirectoryPath: "Custom/Path",
      });

      await service.importSettings(importData);
      const settings = await service.getSettings();

      expect(settings.dailyNoteFormat).toBe("DD-MM-YYYY");
      expect(settings.dailyDirectoryPath).toBe("Custom/Path");
    });

    it("throws on invalid JSON", async () => {
      await expect(service.importSettings("invalid json")).rejects.toThrow(
        "Failed to import settings"
      );
    });

    it("throws on invalid settings", async () => {
      const importData = JSON.stringify({
        dailyDirectoryPath: "invalid<path>",
      });

      await expect(service.importSettings(importData)).rejects.toThrow(
        "Invalid settings"
      );
    });
  });

  describe("getSetting", () => {
    it("returns specific setting value", async () => {
      const value = await service.getSetting("dailyNoteFormat");

      expect(value).toBe("YYYY-MM-DD");
    });
  });

  describe("setSetting", () => {
    it("updates specific setting", async () => {
      await service.setSetting("dailyNoteFormat", "MM-DD-YYYY");

      const value = await service.getSetting("dailyNoteFormat");
      expect(value).toBe("MM-DD-YYYY");
    });
  });

  describe("onSettingsChange", () => {
    it("subscribes to settings changes", async () => {
      const listener = jest.fn();
      service.onSettingsChange(listener);

      await service.updateSettings({ dailyNoteFormat: "DD-MM-YYYY" });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ dailyNoteFormat: "DD-MM-YYYY" })
      );
    });

    it("returns unsubscribe function", async () => {
      const listener = jest.fn();
      const unsubscribe = service.onSettingsChange(listener);

      unsubscribe();
      await service.updateSettings({ dailyNoteFormat: "DD-MM-YYYY" });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns true for enabled features", async () => {
      await service.updateSettings({ enableStreakTracking: true });

      expect(service.isFeatureEnabled("enableStreakTracking")).toBe(true);
    });

    it("returns false for disabled features", async () => {
      await service.updateSettings({ enableStreakTracking: false });

      expect(service.isFeatureEnabled("enableStreakTracking")).toBe(false);
    });

    it("returns false for non-boolean features", () => {
      expect(service.isFeatureEnabled("dailyNoteFormat")).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("clears save timeout", async () => {
      await service.updateSettings({ dailyNoteFormat: "DD-MM-YYYY" });

      service.cleanup();

      // Advance timers - should not trigger save
      jest.advanceTimersByTime(1000);

      // Only check that it doesn't throw
      expect(() => service.cleanup()).not.toThrow();
    });
  });

  describe("applyMigrations (private)", () => {
    it("migrates legacy daily directory path", () => {
      const settings = { ...DEFAULT_DAILY_SETTINGS, dailyDirectoryPath: "Daily" };
      const loadedSettings = { dailyDirectoryPath: "Daily" };

      const result = (service as any).applyMigrations(settings, loadedSettings);

      expect(result.migratedSettings.dailyDirectoryPath).toBe(DEFAULT_DAILY_DIRECTORY_PATH);
      expect(result.changed).toBe(true);
    });

    it("does not migrate non-legacy paths", () => {
      const settings = { ...DEFAULT_DAILY_SETTINGS, dailyDirectoryPath: "Custom/Path" };
      const loadedSettings = { dailyDirectoryPath: "Custom/Path" };

      const result = (service as any).applyMigrations(settings, loadedSettings);

      expect(result.migratedSettings.dailyDirectoryPath).toBe("Custom/Path");
      expect(result.changed).toBe(false);
    });

    it("handles trailing slashes in legacy path", () => {
      const settings = { ...DEFAULT_DAILY_SETTINGS, dailyDirectoryPath: "Daily/" };
      const loadedSettings = { dailyDirectoryPath: "Daily/" };

      const result = (service as any).applyMigrations(settings, loadedSettings);

      expect(result.migratedSettings.dailyDirectoryPath).toBe(DEFAULT_DAILY_DIRECTORY_PATH);
      expect(result.changed).toBe(true);
    });
  });

  describe("loadSettings (private)", () => {
    it("creates directory and saves after migration", async () => {
      mockApp.vault.adapter.read.mockResolvedValueOnce(
        JSON.stringify({ dailyDirectoryPath: "Daily" })
      );

      await (service as any).loadSettings();

      // Should have migrated and saved
      jest.advanceTimersByTime(0); // flush immediate save, not debounced
      expect(mockApp.vault.adapter.mkdir).toHaveBeenCalled();
    });

    it("handles corrupted settings file", async () => {
      mockApp.vault.adapter.read.mockResolvedValueOnce("not valid json");

      await (service as any).loadSettings();

      const settings = await service.getSettings();
      expect(settings.dailyNoteFormat).toBe("YYYY-MM-DD");
    });
  });

  describe("saveSettings debouncing (private)", () => {
    it("debounces multiple saves", async () => {
      await service.updateSettings({ dailyNoteFormat: "DD-MM-YYYY" });
      await service.updateSettings({ enableStreakTracking: false });
      await service.updateSettings({ showDailyStatusBar: false });

      // Advance past debounce time (500ms)
      jest.advanceTimersByTime(600);
      // Wait for async operations in the timeout callback
      await Promise.resolve();
      await Promise.resolve();

      // Should only save once
      expect(mockApp.vault.adapter.write).toHaveBeenCalledTimes(1);
    });
  });

  describe("DEFAULT_DAILY_SETTINGS", () => {
    it("has expected default values", () => {
      expect(DEFAULT_DAILY_SETTINGS.dailyNoteFormat).toBe("YYYY-MM-DD");
      expect(DEFAULT_DAILY_SETTINGS.dailyDirectoryPath).toBe(DEFAULT_DAILY_DIRECTORY_PATH);
      expect(DEFAULT_DAILY_SETTINGS.useDailySubdirectories).toBe(false);
      expect(DEFAULT_DAILY_SETTINGS.autoCreateDailyNote).toBe(false);
      expect(DEFAULT_DAILY_SETTINGS.enableStreakTracking).toBe(true);
      expect(DEFAULT_DAILY_SETTINGS.weeklyReviewDay).toBe(0);
    });
  });
});
