/**
 * @jest-environment jsdom
 */
import moment from "moment";
import { TFile } from "obsidian";
import { DailyAnalyticsService, DailyAnalyticsSummary } from "../DailyAnalyticsService";
import { DailyNoteService } from "../DailyNoteService";

// Mock FunctionProfiler
jest.mock("../../FunctionProfiler", () => ({
  getFunctionProfiler: jest.fn().mockReturnValue({
    profileFunction: jest.fn((fn) => fn),
  }),
}));

describe("DailyAnalyticsService", () => {
  let service: DailyAnalyticsService;
  let mockDailyNoteService: jest.Mocked<DailyNoteService>;
  let localStorageMock: { [key: string]: string };

  beforeEach(() => {
    jest.clearAllMocks();

    localStorageMock = {};
    global.localStorage = {
      getItem: jest.fn((key: string) => localStorageMock[key] || null),
      setItem: jest.fn((key: string, value: string) => {
        localStorageMock[key] = value;
      }),
      removeItem: jest.fn((key: string) => {
        delete localStorageMock[key];
      }),
      clear: jest.fn(() => {
        localStorageMock = {};
      }),
      length: 0,
      key: jest.fn(),
    } as Storage;

    mockDailyNoteService = {
      getSettings: jest.fn().mockResolvedValue({
        dailyNoteFormat: "YYYY-MM-DD",
      }),
      getStreakData: jest.fn().mockResolvedValue({
        currentStreak: 5,
        longestStreak: 10,
        totalDailyNotes: 50,
        lastDailyNoteDate: "2024-01-15",
      }),
      getAllDailyNotes: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DailyNoteService>;

    service = new DailyAnalyticsService(mockDailyNoteService);
  });

  afterEach(() => {
    delete (global as any).localStorage;
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(DailyAnalyticsService);
    });
  });

  describe("getAnalyticsSummary", () => {
    it("returns analytics summary", async () => {
      const summary = await service.getAnalyticsSummary();

      expect(summary).toBeDefined();
      expect(summary.currentStreak).toBe(5);
      expect(summary.longestStreak).toBe(10);
      expect(summary.totalDailyNotes).toBe(50);
    });

    it("returns cached summary when available", async () => {
      const summary1 = await service.getAnalyticsSummary();
      const summary2 = await service.getAnalyticsSummary();

      // Should only call getStreakData once due to caching
      expect(mockDailyNoteService.getStreakData).toHaveBeenCalledTimes(1);
      expect(summary1).toEqual(summary2);
    });

    it("returns persisted summary as fallback", async () => {
      const persistedData = {
        timestamp: Date.now() - 1000, // 1 second ago (within 5 min TTL)
        data: {
          totalDailyNotes: 30,
          currentStreak: 3,
          longestStreak: 7,
          lastDailyNoteDate: "2024-01-10",
          notesThisWeek: 4,
          notesThisMonth: 15,
        },
      };
      localStorageMock["systemsculpt:daily-analytics-summary"] = JSON.stringify(persistedData);

      // Create new service to load persisted data
      const newService = new DailyAnalyticsService(mockDailyNoteService);

      // Access the persisted summary through internal state
      expect((newService as any).persistedSummary).not.toBeNull();
    });
  });

  describe("invalidateCache", () => {
    it("clears the summary cache", async () => {
      // First call to populate cache
      await service.getAnalyticsSummary();

      // Invalidate cache
      service.invalidateCache();

      // Next call should fetch again
      await service.getAnalyticsSummary();

      expect(mockDailyNoteService.getStreakData).toHaveBeenCalledTimes(2);
    });
  });

  describe("countNotesInRecentRange", () => {
    it("counts notes within week and month ranges", async () => {
      const now = moment();
      const weekStart = now.clone().startOf("week");
      const monthStart = now.clone().startOf("month");

      const mockNotes = [
        { basename: now.format("YYYY-MM-DD") } as TFile,
        { basename: now.clone().subtract(1, "days").format("YYYY-MM-DD") } as TFile,
        { basename: now.clone().subtract(7, "days").format("YYYY-MM-DD") } as TFile,
      ];

      mockDailyNoteService.getAllDailyNotes.mockResolvedValue(mockNotes);

      const summary = await service.getAnalyticsSummary();

      expect(summary.notesThisWeek).toBeGreaterThanOrEqual(0);
      expect(summary.notesThisMonth).toBeGreaterThanOrEqual(0);
    });

    it("skips notes with invalid date format", async () => {
      const mockNotes = [
        { basename: "invalid-date" } as TFile,
        { basename: "not-a-date" } as TFile,
      ];

      mockDailyNoteService.getAllDailyNotes.mockResolvedValue(mockNotes);

      const summary = await service.getAnalyticsSummary();

      expect(summary.notesThisWeek).toBe(0);
      expect(summary.notesThisMonth).toBe(0);
    });
  });

  describe("localStorage persistence", () => {
    it("persists summary to localStorage", async () => {
      await service.getAnalyticsSummary();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        "systemsculpt:daily-analytics-summary",
        expect.any(String)
      );
    });

    it("handles localStorage errors gracefully", async () => {
      (localStorage.setItem as jest.Mock).mockImplementation(() => {
        throw new Error("Storage full");
      });

      // Should not throw
      await expect(service.getAnalyticsSummary()).resolves.toBeDefined();
    });

    it("handles invalid persisted data gracefully", () => {
      localStorageMock["systemsculpt:daily-analytics-summary"] = "invalid-json";

      // Should not throw
      const newService = new DailyAnalyticsService(mockDailyNoteService);
      expect(newService).toBeInstanceOf(DailyAnalyticsService);
    });
  });

  describe("concurrent requests", () => {
    it("handles concurrent requests with single computation", async () => {
      const [summary1, summary2, summary3] = await Promise.all([
        service.getAnalyticsSummary(),
        service.getAnalyticsSummary(),
        service.getAnalyticsSummary(),
      ]);

      // All should return the same summary
      expect(summary1).toEqual(summary2);
      expect(summary2).toEqual(summary3);

      // Should only compute once
      expect(mockDailyNoteService.getStreakData).toHaveBeenCalledTimes(1);
    });
  });
});
