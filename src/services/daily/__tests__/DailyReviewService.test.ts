/**
 * @jest-environment jsdom
 */
import { App, TFile, MarkdownView, normalizePath, Notice } from "obsidian";
import moment from "moment";
import { DailyReviewService } from "../DailyReviewService";
import { DailyNoteService } from "../DailyNoteService";
import { DailySettingsService } from "../DailySettingsService";

// Mock obsidian with TFile class defined inside
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");

  // Define MockTFile inside the mock factory
  class MockTFile {
    path: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(".md", "") || "";
    }
  }

  return {
    ...actual,
    Notice: jest.fn(),
    normalizePath: jest.fn((path: string) => path),
    MarkdownView: jest.fn(),
    TFile: MockTFile,
  };
});

// Get the mocked TFile class for use in tests
const { TFile: MockTFile } = jest.requireMock("obsidian");

describe("DailyReviewService", () => {
  let service: DailyReviewService;
  let mockApp: App;
  let mockDailyNoteService: jest.Mocked<DailyNoteService>;
  let mockSettingsService: jest.Mocked<DailySettingsService>;
  let mockVault: any;
  let mockWorkspace: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockVault = {
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      read: jest.fn().mockResolvedValue("# Test Content"),
      create: jest.fn().mockImplementation((path) =>
        Promise.resolve({ path, basename: path.split("/").pop() } as TFile)
      ),
      createFolder: jest.fn().mockResolvedValue(undefined),
    };

    mockWorkspace = {
      getLeaf: jest.fn().mockReturnValue({
        openFile: jest.fn().mockResolvedValue(undefined),
      }),
      getActiveViewOfType: jest.fn().mockReturnValue(null),
    };

    mockApp = {
      vault: mockVault,
      workspace: mockWorkspace,
    } as unknown as App;

    mockDailyNoteService = {
      getDailyNote: jest.fn().mockResolvedValue(null),
      createDailyNote: jest.fn().mockResolvedValue({
        path: "Daily/2024-01-15.md",
        basename: "2024-01-15",
      } as TFile),
      openDailyNote: jest.fn().mockResolvedValue(undefined),
      getStreakData: jest.fn().mockResolvedValue({
        currentStreak: 5,
        longestStreak: 10,
        totalDailyNotes: 50,
        lastDailyNoteDate: "2024-01-15",
      }),
      renderTemplate: jest.fn().mockImplementation((template) => Promise.resolve(template)),
    } as unknown as jest.Mocked<DailyNoteService>;

    mockSettingsService = {
      getSettings: jest.fn().mockResolvedValue({
        dailyDirectoryPath: "Daily",
        weeklyReviewDay: 0, // Sunday
        weeklyReviewTemplate: "",
      }),
    } as unknown as jest.Mocked<DailySettingsService>;

    service = new DailyReviewService(mockApp, mockDailyNoteService, mockSettingsService);
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(DailyReviewService);
    });
  });

  describe("startDailyReview", () => {
    it("creates daily note if not exists", async () => {
      await service.startDailyReview();

      expect(mockDailyNoteService.createDailyNote).toHaveBeenCalled();
    });

    it("opens existing daily note", async () => {
      const existingNote = { path: "Daily/2024-01-15.md", basename: "2024-01-15" } as TFile;
      mockDailyNoteService.getDailyNote.mockResolvedValue(existingNote);

      await service.startDailyReview();

      expect(mockDailyNoteService.createDailyNote).not.toHaveBeenCalled();
      expect(mockDailyNoteService.openDailyNote).toHaveBeenCalled();
    });

    it("shows notice about daily review sections", async () => {
      await service.startDailyReview();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Daily review ready"),
        expect.any(Number)
      );
    });
  });

  describe("startWeeklyReview", () => {
    it("creates weekly review note if not exists", async () => {
      await service.startWeeklyReview();

      expect(mockVault.create).toHaveBeenCalledWith(
        expect.stringContaining("Weekly Review"),
        expect.any(String)
      );
    });

    it("opens existing weekly review note", async () => {
      const existingFile = new MockTFile("Daily/Weekly Reviews/2024-01-14 Weekly Review.md");
      // Return existing file for any path containing "Weekly Review"
      mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
        if (path.includes("Weekly Review")) return existingFile;
        return {}; // Return truthy for directory checks
      });

      await service.startWeeklyReview();

      expect(mockVault.create).not.toHaveBeenCalled();
    });

    it("shows notice about weekly review", async () => {
      await service.startWeeklyReview();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Weekly review loaded"),
        expect.any(Number)
      );
    });

    it("uses custom template when configured", async () => {
      const templateFile = new MockTFile("templates/weekly.md");
      mockSettingsService.getSettings.mockResolvedValue({
        dailyDirectoryPath: "Daily",
        weeklyReviewDay: 0,
        weeklyReviewTemplate: "templates/weekly.md",
      });
      mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
        if (path === "templates/weekly.md") return templateFile;
        if (path.includes("Daily") || path.includes("Weekly")) return {}; // Directory exists
        return null;
      });
      mockVault.read.mockResolvedValue("# Custom Weekly Template");

      await service.startWeeklyReview();

      // Verify template was read
      expect(mockVault.read).toHaveBeenCalledWith(templateFile);
    });
  });

  describe("showDailyStreakSummary", () => {
    it("shows streak summary notice", async () => {
      await service.showDailyStreakSummary();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Daily streak: 5"),
        expect.any(Number)
      );
    });

    it("handles singular day correctly", async () => {
      mockDailyNoteService.getStreakData.mockResolvedValue({
        currentStreak: 1,
        longestStreak: 1,
        totalDailyNotes: 1,
        lastDailyNoteDate: "2024-01-15",
      });

      await service.showDailyStreakSummary();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("1 day"),
        expect.any(Number)
      );
    });

    it("handles no entries gracefully", async () => {
      mockDailyNoteService.getStreakData.mockResolvedValue({
        currentStreak: 0,
        longestStreak: 0,
        totalDailyNotes: 0,
        lastDailyNoteDate: null,
      });

      await service.showDailyStreakSummary();

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("No entries yet"),
        expect.any(Number)
      );
    });
  });

  describe("ensureDirectory", () => {
    it("creates nested directories", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await service.startWeeklyReview();

      expect(mockVault.createFolder).toHaveBeenCalled();
    });

    it("skips existing directories", async () => {
      mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
        if (path === "Daily" || path === "Daily/Weekly Reviews") return {};
        return null;
      });

      await service.startWeeklyReview();

      // Should not try to create directories that exist
      expect(mockVault.createFolder).not.toHaveBeenCalledWith("Daily");
    });
  });

  describe("highlightSections", () => {
    it("handles missing markdown view gracefully", async () => {
      mockWorkspace.getActiveViewOfType.mockReturnValue(null);

      // Should not throw
      await expect(service.startDailyReview()).resolves.not.toThrow();
    });

    it("scrolls to first found heading", async () => {
      const mockEditor = {
        setCursor: jest.fn(),
        scrollIntoView: jest.fn(),
        lineCount: jest.fn().mockReturnValue(100),
      };
      const mockView = {
        file: { path: "Daily/2024-01-15.md" },
        editor: mockEditor,
      };
      mockWorkspace.getActiveViewOfType.mockReturnValue(mockView);

      const existingNote = { path: "Daily/2024-01-15.md", basename: "2024-01-15" } as TFile;
      mockDailyNoteService.getDailyNote.mockResolvedValue(existingNote);
      mockVault.read.mockResolvedValue(`# Daily Note\n\n## 🤔 Reflections\n\nContent here`);

      await service.startDailyReview();

      expect(mockEditor.setCursor).toHaveBeenCalled();
    });
  });
});
