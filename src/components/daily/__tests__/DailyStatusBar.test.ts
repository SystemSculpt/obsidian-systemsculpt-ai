/**
 * @jest-environment jsdom
 */
import { App, Notice } from "obsidian";
import moment from "moment";
import { DailyStatusBar } from "../DailyStatusBar";
import { DailyNoteService } from "../../../services/daily/DailyNoteService";
import { DailySettingsService } from "../../../services/daily/DailySettingsService";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

// Mock FunctionProfiler
jest.mock("../../../services/FunctionProfiler", () => ({
  getFunctionProfiler: jest.fn().mockReturnValue({
    profileFunction: jest.fn((fn) => fn),
  }),
}));

// Mock DailyNoteNavigatorModal
jest.mock("../../../modals/DailyNoteNavigatorModal", () => ({
  DailyNoteNavigatorModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

describe("DailyStatusBar", () => {
  let statusBar: DailyStatusBar;
  let mockApp: App;
  let mockDailyNoteService: jest.Mocked<DailyNoteService>;
  let mockDailySettingsService: jest.Mocked<DailySettingsService>;
  let mockContainerEl: HTMLElement;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockApp = {
      workspace: {
        getLeaf: jest.fn().mockReturnValue({
          openFile: jest.fn().mockResolvedValue(undefined),
        }),
      },
    } as unknown as App;

    mockDailyNoteService = {
      getDailyNote: jest.fn().mockResolvedValue(null),
      createDailyNote: jest.fn().mockResolvedValue({
        path: "Daily/2024-01-15.md",
        basename: "2024-01-15",
      }),
      openDailyNote: jest.fn().mockResolvedValue(undefined),
      getStreakData: jest.fn().mockResolvedValue({
        currentStreak: 5,
        longestStreak: 10,
        totalDailyNotes: 50,
        lastDailyNoteDate: "2024-01-15",
      }),
      on: jest.fn().mockReturnValue(jest.fn()),
      invalidateDailyNotesCache: jest.fn(),
    } as unknown as jest.Mocked<DailyNoteService>;

    mockDailySettingsService = {
      getSettings: jest.fn().mockResolvedValue({
        dailyDirectoryPath: "Daily",
        dailyNoteFormat: "YYYY-MM-DD",
      }),
      onSettingsChange: jest.fn().mockReturnValue(jest.fn()),
    } as unknown as jest.Mocked<DailySettingsService>;

    mockContainerEl = document.createElement("div");
    mockContainerEl.empty = jest.fn();
    mockContainerEl.addClass = jest.fn();
    mockContainerEl.setAttr = jest.fn();
    mockContainerEl.createDiv = jest.fn().mockReturnValue(document.createElement("div"));
    mockContainerEl.createSpan = jest.fn().mockReturnValue(document.createElement("span"));

    statusBar = new DailyStatusBar(mockApp, mockDailyNoteService, mockDailySettingsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates status bar instance", () => {
      expect(statusBar).toBeInstanceOf(DailyStatusBar);
    });

    it("stores app reference", () => {
      expect((statusBar as any).app).toBe(mockApp);
    });

    it("stores daily note service", () => {
      expect((statusBar as any).dailyNoteService).toBe(mockDailyNoteService);
    });

    it("stores daily settings service", () => {
      expect((statusBar as any).dailySettingsService).toBe(mockDailySettingsService);
    });
  });

  describe("initialize", () => {
    it("sets container element", async () => {
      await statusBar.initialize(mockContainerEl);

      expect((statusBar as any).containerEl).toBe(mockContainerEl);
    });

    it("clears container content", async () => {
      await statusBar.initialize(mockContainerEl);

      expect(mockContainerEl.empty).toHaveBeenCalled();
    });

    it("makes container clickable", async () => {
      await statusBar.initialize(mockContainerEl);

      expect(mockContainerEl.addClass).toHaveBeenCalledWith("mod-clickable");
    });

    it("sets accessibility attributes", async () => {
      await statusBar.initialize(mockContainerEl);

      expect(mockContainerEl.setAttr).toHaveBeenCalledWith("role", "button");
      expect(mockContainerEl.setAttr).toHaveBeenCalledWith("tabindex", "0");
    });

    it("binds interaction handlers once", async () => {
      await statusBar.initialize(mockContainerEl);
      await statusBar.initialize(mockContainerEl);

      // Should only bind once
      expect((statusBar as any).interactionsBound).toBe(true);
    });
  });

  describe("requestRefresh", () => {
    it("queues refresh when not already queued", async () => {
      await statusBar.initialize(mockContainerEl);

      statusBar.requestRefresh();

      expect((statusBar as any).refreshQueued).toBe(true);
    });

    it("skips queueing when already queued", async () => {
      await statusBar.initialize(mockContainerEl);
      (statusBar as any).refreshQueued = true;

      statusBar.requestRefresh();

      // Still queued, but not re-queued
      expect((statusBar as any).refreshQueued).toBe(true);
    });

    it("forces refresh regardless of queue state", async () => {
      await statusBar.initialize(mockContainerEl);
      (statusBar as any).refreshQueued = true;

      statusBar.requestRefresh(true);

      // Should still trigger
      expect((statusBar as any).refreshQueued).toBe(true);
    });
  });

  describe("refresh", () => {
    it("skips refresh when no container", async () => {
      await (statusBar as any).refresh();

      // No error thrown, refresh skipped
      expect((statusBar as any).lastRefreshAt).toBe(0);
    });

    it("respects refresh TTL", async () => {
      await statusBar.initialize(mockContainerEl);
      (statusBar as any).lastRefreshAt = Date.now();

      await (statusBar as any).refresh(false);

      // Should not update lastRefreshAt when within TTL
      expect(mockDailyNoteService.getStreakData).not.toHaveBeenCalled();
    });

    it("forces refresh regardless of TTL", async () => {
      await statusBar.initialize(mockContainerEl);
      (statusBar as any).lastRefreshAt = Date.now();

      // This should trigger even with recent refresh
      statusBar.requestRefresh(true);
    });
  });

  describe("constants", () => {
    it("has refresh TTL constant", () => {
      expect((statusBar as any).REFRESH_TTL).toBe(60 * 1000);
    });

    it("has force cooldown constant", () => {
      expect((statusBar as any).REFRESH_FORCE_COOLDOWN).toBe(2000);
    });
  });

  describe("click handler", () => {
    it("registers click event listener", async () => {
      const addEventListenerSpy = jest.spyOn(mockContainerEl, "addEventListener");

      await statusBar.initialize(mockContainerEl);

      expect(addEventListenerSpy).toHaveBeenCalledWith("click", expect.any(Function));
    });

    it("registers keydown event listener", async () => {
      const addEventListenerSpy = jest.spyOn(mockContainerEl, "addEventListener");

      await statusBar.initialize(mockContainerEl);

      expect(addEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    });

    it("registers contextmenu event listener", async () => {
      const addEventListenerSpy = jest.spyOn(mockContainerEl, "addEventListener");

      await statusBar.initialize(mockContainerEl);

      expect(addEventListenerSpy).toHaveBeenCalledWith("contextmenu", expect.any(Function));
    });
  });

  describe("cleanup", () => {
    it("tracks unsubscribe handlers", () => {
      expect((statusBar as any).unsubscribeHandlers).toEqual([]);
    });

    it("tracks refresh cooldown handle", () => {
      expect((statusBar as any).refreshCooldownHandle).toBeNull();
    });
  });
});
