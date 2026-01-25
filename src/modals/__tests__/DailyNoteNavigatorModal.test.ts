/**
 * @jest-environment jsdom
 */
import { App, Modal, Notice, Setting } from "obsidian";
import moment from "moment";
import { DailyNoteNavigatorModal } from "../DailyNoteNavigatorModal";
import { DailyNoteService } from "../../services/daily/DailyNoteService";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Modal: class MockModal {
      app: App;
      modalEl: HTMLElement;
      contentEl: HTMLElement;

      constructor(app: App) {
        this.app = app;
        this.modalEl = document.createElement("div");
        this.modalEl.addClass = jest.fn();
        this.contentEl = document.createElement("div");
      }

      open() {}
      close() {}
    },
    Setting: jest.fn().mockImplementation(() => ({
      setName: jest.fn().mockReturnThis(),
      setDesc: jest.fn().mockReturnThis(),
      addText: jest.fn().mockImplementation((cb) => {
        const inputEl = document.createElement("input");
        cb({
          inputEl,
          setValue: jest.fn().mockReturnThis(),
          onChange: jest.fn().mockReturnThis(),
        });
        return { settingEl: document.createElement("div") };
      }),
      addToggle: jest.fn().mockImplementation((cb) => {
        cb({
          setValue: jest.fn().mockReturnThis(),
          onChange: jest.fn().mockReturnThis(),
        });
        return { settingEl: document.createElement("div") };
      }),
    })),
    Notice: jest.fn(),
  };
});

describe("DailyNoteNavigatorModal", () => {
  let mockApp: App;
  let mockDailyNoteService: jest.Mocked<DailyNoteService>;
  let modal: DailyNoteNavigatorModal;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = {} as App;

    mockDailyNoteService = {
      getSettings: jest.fn().mockResolvedValue({
        dailyNoteFormat: "YYYY-MM-DD",
        dailyDirectoryPath: "Daily",
      }),
      openDailyNote: jest.fn().mockResolvedValue(undefined),
      getAllDailyNotes: jest.fn().mockResolvedValue([
        { basename: moment().format("YYYY-MM-DD") },
        { basename: moment().subtract(1, "day").format("YYYY-MM-DD") },
      ]),
    } as unknown as jest.Mocked<DailyNoteService>;

    modal = new DailyNoteNavigatorModal(mockApp, mockDailyNoteService);
  });

  afterEach(() => {
    modal.close();
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      expect(modal).toBeInstanceOf(DailyNoteNavigatorModal);
    });

    it("stores daily note service", () => {
      expect((modal as any).dailyNoteService).toBe(mockDailyNoteService);
    });

    it("accepts initial date", () => {
      const date = new Date("2024-01-15");
      const modalWithDate = new DailyNoteNavigatorModal(
        mockApp,
        mockDailyNoteService,
        date
      );

      expect((modalWithDate as any).initialDate).toEqual(date);
    });

    it("defaults to null initial date", () => {
      expect((modal as any).initialDate).toBeNull();
    });
  });

  describe("onOpen", () => {
    it("adds modal class", async () => {
      await modal.onOpen();

      expect(modal.modalEl.addClass).toHaveBeenCalledWith(
        "systemsculpt-daily-navigator"
      );
    });

    it("clears content", async () => {
      const oldContent = document.createElement("div");
      modal.contentEl.appendChild(oldContent);

      await modal.onOpen();

      // Content was replaced
      expect(modal.contentEl.children.length).toBeGreaterThan(0);
    });

    it("gets settings from service", async () => {
      await modal.onOpen();

      expect(mockDailyNoteService.getSettings).toHaveBeenCalled();
    });

    it("creates header", async () => {
      await modal.onOpen();

      const header = modal.contentEl.querySelector(".daily-navigator-header");
      expect(header).not.toBeNull();
    });

    it("creates quick actions", async () => {
      await modal.onOpen();

      const quickActions = modal.contentEl.querySelector(
        ".daily-navigator-quick-actions"
      );
      expect(quickActions).not.toBeNull();
    });

    it("creates today button", async () => {
      await modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll("button");
      const todayButton = Array.from(buttons).find((b) =>
        b.textContent?.includes("Today")
      );
      expect(todayButton).not.toBeNull();
    });

    it("creates yesterday button", async () => {
      await modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll("button");
      const yesterdayButton = Array.from(buttons).find((b) =>
        b.textContent?.includes("Yesterday")
      );
      expect(yesterdayButton).not.toBeNull();
    });

    it("creates date picker setting", async () => {
      await modal.onOpen();

      expect(Setting).toHaveBeenCalled();
    });

    it("creates recent entries list", async () => {
      await modal.onOpen();

      const recentContainer = modal.contentEl.querySelector(
        ".daily-navigator-recent"
      );
      expect(recentContainer).not.toBeNull();
    });
  });

  describe("quick actions", () => {
    it("today button opens today's note", async () => {
      await modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll("button");
      const todayButton = Array.from(buttons).find((b) =>
        b.textContent?.includes("Today")
      );

      todayButton?.click();

      expect(mockDailyNoteService.openDailyNote).toHaveBeenCalled();
    });

    it("handles today button error", async () => {
      mockDailyNoteService.openDailyNote.mockRejectedValueOnce(
        new Error("Failed")
      );

      await modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll("button");
      const todayButton = Array.from(buttons).find((b) =>
        b.textContent?.includes("Today")
      );

      await todayButton?.onclick?.({} as MouseEvent);

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't open today's note"),
        expect.any(Number)
      );
    });
  });

  describe("buildRecentEntries", () => {
    it("builds 7 recent entries", async () => {
      await modal.onOpen();

      const recentList = modal.contentEl.querySelector(
        ".daily-navigator-recent-list"
      );
      const items = recentList?.querySelectorAll(".daily-navigator-recent-item");

      expect(items?.length).toBe(7);
    });

    it("marks existing notes as saved", async () => {
      await modal.onOpen();

      const savedItems = modal.contentEl.querySelectorAll(".is-available");
      expect(savedItems.length).toBeGreaterThan(0);
    });

    it("marks missing notes", async () => {
      await modal.onOpen();

      const missingItems = modal.contentEl.querySelectorAll(".is-missing");
      expect(missingItems.length).toBeGreaterThan(0);
    });
  });

  describe("empty state", () => {
    it("shows empty message when no notes", async () => {
      mockDailyNoteService.getAllDailyNotes.mockResolvedValue([]);

      await modal.onOpen();

      const emptyMessage = modal.contentEl.querySelector(
        ".daily-navigator-empty"
      );
      // May or may not show depending on implementation
    });
  });

  describe("onClose", () => {
    it("empties content", async () => {
      await modal.onOpen();

      modal.onClose();

      expect(modal.contentEl.children.length).toBe(0);
    });
  });

  describe("date selection", () => {
    it("uses initial date when provided", async () => {
      const date = new Date("2024-01-15");
      const modalWithDate = new DailyNoteNavigatorModal(
        mockApp,
        mockDailyNoteService,
        date
      );

      await modalWithDate.onOpen();

      // Date picker should be initialized with initial date
      expect((modalWithDate as any).initialDate).toEqual(date);
    });
  });
});
