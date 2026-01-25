/**
 * @jest-environment jsdom
 */
import { DailyWorkflowService } from "../DailyWorkflowService";
import { DailyNoteService } from "../DailyNoteService";
import { DailySettingsService } from "../DailySettingsService";
import moment from "moment";

// Mock Notice
jest.mock("obsidian", () => ({
  Notice: jest.fn(),
}));

// Mock getFunctionProfiler
jest.mock("../../FunctionProfiler", () => ({
  getFunctionProfiler: () => ({
    profileFunction: (fn: Function) => fn,
  }),
}));

describe("DailyWorkflowService", () => {
  let service: DailyWorkflowService;
  let mockDailyNoteService: jest.Mocked<DailyNoteService>;
  let mockSettingsService: jest.Mocked<DailySettingsService>;
  let settingsChangeCallback: (() => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset callback tracker
    settingsChangeCallback = null;

    mockDailyNoteService = {
      getDailyNote: jest.fn().mockResolvedValue(null),
      createDailyNote: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<DailyNoteService>;

    mockSettingsService = {
      getSettings: jest.fn().mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: null,
      }),
      shouldTriggerDailyReminder: jest.fn().mockReturnValue(false),
      shouldTriggerWeeklyReview: jest.fn().mockReturnValue(false),
      onSettingsChange: jest.fn((callback) => {
        settingsChangeCallback = callback;
      }),
    } as unknown as jest.Mocked<DailySettingsService>;

    service = new DailyWorkflowService(mockDailyNoteService, mockSettingsService);
  });

  afterEach(() => {
    service.cleanup();
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(DailyWorkflowService);
    });

    it("initializes profiled functions", () => {
      expect((service as any).profiledRunTick).toBeDefined();
      expect((service as any).profiledDailyReminder).toBeDefined();
      expect((service as any).profiledWeeklyReminder).toBeDefined();
    });

    it("sets up idle scheduler", () => {
      expect((service as any).idleScheduler).toBeDefined();
    });
  });

  describe("initialize", () => {
    it("calls refreshScheduler", async () => {
      await service.initialize();

      expect(mockSettingsService.getSettings).toHaveBeenCalled();
    });

    it("registers settings change listener", async () => {
      await service.initialize();

      expect(mockSettingsService.onSettingsChange).toHaveBeenCalled();
    });

    it("refreshes scheduler on settings change", async () => {
      await service.initialize();

      // Simulate settings change
      if (settingsChangeCallback) {
        settingsChangeCallback();
      }

      // Should call getSettings again
      expect(mockSettingsService.getSettings).toHaveBeenCalledTimes(2);
    });
  });

  describe("scheduler management", () => {
    it("does not start scheduler when no features enabled", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: null,
      });

      await service.initialize();

      expect((service as any).reminderInterval).toBeNull();
    });

    it("starts scheduler when autoCreateDailyNote is enabled", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: true,
        dailyReminderTime: null,
        weeklyReviewTemplate: null,
      });

      await service.initialize();

      expect((service as any).reminderInterval).not.toBeNull();
    });

    it("starts scheduler when dailyReminderTime is set", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: "09:00",
        weeklyReviewTemplate: null,
      });

      await service.initialize();

      expect((service as any).reminderInterval).not.toBeNull();
    });

    it("starts scheduler when weeklyReviewTemplate is set", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: "weekly-review",
      });

      await service.initialize();

      expect((service as any).reminderInterval).not.toBeNull();
    });
  });

  describe("handleDailyReminder", () => {
    it("does not trigger if already triggered today", async () => {
      const today = moment().format("YYYY-MM-DD");
      (service as any).lastReminderDate = today;
      mockSettingsService.shouldTriggerDailyReminder.mockReturnValue(true);

      await (service as any).handleDailyReminder();

      expect(mockDailyNoteService.getDailyNote).not.toHaveBeenCalled();
    });

    it("does not trigger if shouldTriggerDailyReminder returns false", async () => {
      mockSettingsService.shouldTriggerDailyReminder.mockReturnValue(false);

      await (service as any).handleDailyReminder();

      expect(mockDailyNoteService.getDailyNote).not.toHaveBeenCalled();
    });

    it("creates daily note automatically when autoCreateDailyNote is enabled", async () => {
      mockSettingsService.shouldTriggerDailyReminder.mockReturnValue(true);
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: true,
        dailyReminderTime: "09:00",
        weeklyReviewTemplate: null,
      });
      mockDailyNoteService.getDailyNote.mockResolvedValue(null);

      await (service as any).handleDailyReminder();

      expect(mockDailyNoteService.createDailyNote).toHaveBeenCalled();
    });

    it("does not create daily note if one already exists", async () => {
      mockSettingsService.shouldTriggerDailyReminder.mockReturnValue(true);
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: true,
        dailyReminderTime: "09:00",
        weeklyReviewTemplate: null,
      });
      mockDailyNoteService.getDailyNote.mockResolvedValue({} as any);

      await (service as any).handleDailyReminder();

      expect(mockDailyNoteService.createDailyNote).not.toHaveBeenCalled();
    });

    it("shows reminder notice when autoCreateDailyNote is disabled", async () => {
      const { Notice } = require("obsidian");
      mockSettingsService.shouldTriggerDailyReminder.mockReturnValue(true);
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: "09:00",
        weeklyReviewTemplate: null,
      });

      await (service as any).handleDailyReminder();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Reminder"),
        5000
      );
    });

    it("updates lastReminderDate after triggering", async () => {
      mockSettingsService.shouldTriggerDailyReminder.mockReturnValue(true);
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: "09:00",
        weeklyReviewTemplate: null,
      });

      await (service as any).handleDailyReminder();

      const today = moment().format("YYYY-MM-DD");
      expect((service as any).lastReminderDate).toBe(today);
    });
  });

  describe("handleWeeklyReviewReminder", () => {
    it("does nothing when weeklyReviewTemplate is not set", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: null,
      });

      await (service as any).handleWeeklyReviewReminder();

      expect(mockSettingsService.shouldTriggerWeeklyReview).not.toHaveBeenCalled();
    });

    it("does not trigger if already triggered today", async () => {
      const today = moment().format("YYYY-MM-DD");
      (service as any).lastWeeklyReviewDate = today;
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: "weekly-review",
      });

      await (service as any).handleWeeklyReviewReminder();

      expect(mockSettingsService.shouldTriggerWeeklyReview).not.toHaveBeenCalled();
    });

    it("does not trigger if shouldTriggerWeeklyReview returns false", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: "weekly-review",
      });
      mockSettingsService.shouldTriggerWeeklyReview.mockReturnValue(false);

      await (service as any).handleWeeklyReviewReminder();

      const { Notice } = require("obsidian");
      expect(Notice).not.toHaveBeenCalled();
    });

    it("shows notice when weekly review should trigger", async () => {
      const { Notice } = require("obsidian");
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: "weekly-review",
      });
      mockSettingsService.shouldTriggerWeeklyReview.mockReturnValue(true);

      await (service as any).handleWeeklyReviewReminder();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Weekly review"),
        6000
      );
    });

    it("updates lastWeeklyReviewDate after triggering", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: false,
        dailyReminderTime: null,
        weeklyReviewTemplate: "weekly-review",
      });
      mockSettingsService.shouldTriggerWeeklyReview.mockReturnValue(true);

      await (service as any).handleWeeklyReviewReminder();

      const today = moment().format("YYYY-MM-DD");
      expect((service as any).lastWeeklyReviewDate).toBe(today);
    });
  });

  describe("runTick", () => {
    it("calls both daily and weekly reminders", async () => {
      const dailySpy = jest.spyOn(service as any, "profiledDailyReminder");
      const weeklySpy = jest.spyOn(service as any, "profiledWeeklyReminder");

      await (service as any).runTick();

      expect(dailySpy).toHaveBeenCalled();
      expect(weeklySpy).toHaveBeenCalled();
    });

    it("handles errors gracefully", async () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      (service as any).profiledDailyReminder = jest.fn().mockRejectedValue(new Error("Test error"));

      await (service as any).runTick();

      expect(consoleSpy).toHaveBeenCalledWith(
        "Daily workflow tick failed",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe("scheduleTickExecution", () => {
    it("uses idle scheduler", () => {
      const idleSchedulerSpy = jest.fn();
      (service as any).idleScheduler = idleSchedulerSpy;

      (service as any).scheduleTickExecution();

      expect(idleSchedulerSpy).toHaveBeenCalled();
    });

    it("arms watchdog timer", () => {
      (service as any).scheduleTickExecution();

      expect((service as any).pendingTickWatchdog).not.toBeNull();
    });
  });

  describe("armTickWatchdog", () => {
    it("sets watchdog timeout", () => {
      const callback = jest.fn();

      (service as any).armTickWatchdog(callback);

      expect((service as any).pendingTickWatchdog).not.toBeNull();
    });

    it("clears existing watchdog before setting new one", () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      (service as any).armTickWatchdog(callback1);
      const firstWatchdog = (service as any).pendingTickWatchdog;

      (service as any).armTickWatchdog(callback2);
      const secondWatchdog = (service as any).pendingTickWatchdog;

      expect(firstWatchdog).not.toBe(secondWatchdog);
    });

    it("calls callback after timeout", () => {
      const callback = jest.fn();

      (service as any).armTickWatchdog(callback);

      jest.advanceTimersByTime(5001);

      expect(callback).toHaveBeenCalled();
    });

    it("clears pendingTickWatchdog after firing", () => {
      const callback = jest.fn();

      (service as any).armTickWatchdog(callback);

      jest.advanceTimersByTime(5001);

      expect((service as any).pendingTickWatchdog).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("stops scheduler", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: true,
        dailyReminderTime: null,
        weeklyReviewTemplate: null,
      });

      await service.initialize();
      expect((service as any).reminderInterval).not.toBeNull();

      service.cleanup();

      expect((service as any).reminderInterval).toBeNull();
    });
  });

  describe("scheduler interval", () => {
    it("runs tick every minute", async () => {
      mockSettingsService.getSettings.mockResolvedValue({
        autoCreateDailyNote: true,
        dailyReminderTime: null,
        weeklyReviewTemplate: null,
      });

      const scheduleSpy = jest.spyOn(service as any, "scheduleTickExecution");

      await service.initialize();

      // Initial call
      expect(scheduleSpy).toHaveBeenCalledTimes(1);

      // Advance 1 minute
      jest.advanceTimersByTime(60 * 1000);

      expect(scheduleSpy).toHaveBeenCalledTimes(2);

      // Advance another minute
      jest.advanceTimersByTime(60 * 1000);

      expect(scheduleSpy).toHaveBeenCalledTimes(3);
    });
  });
});
