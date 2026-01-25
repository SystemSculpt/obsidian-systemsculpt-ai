/**
 * @jest-environment jsdom
 */
import { App, setIcon, MarkdownRenderer, Component } from "obsidian";
import { ChangeLogModal, ChangeLogModalOptions } from "../ChangeLogModal";
import { ChangeLogService } from "../../services/ChangeLogService";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    setIcon: jest.fn(),
    MarkdownRenderer: {
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
    },
    Component: jest.fn().mockImplementation(() => ({
      unload: jest.fn(),
    })),
  };
});

// Mock StandardModal
jest.mock("../../core/ui/modals/standard", () => ({
  StandardModal: class MockStandardModal {
    app: App;
    modalEl: HTMLElement;
    contentEl: HTMLElement;
    headerEl: HTMLElement;
    footerEl: HTMLElement;

    constructor(app: App) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.contentEl = document.createElement("div");
      this.headerEl = document.createElement("div");
      this.footerEl = document.createElement("div");
      this.modalEl.addClass = jest.fn();
      this.modalEl.setAttr = jest.fn();
    }

    setSize() {}
    addTitle() {}
    addActionButton() {}
    onOpen() {}
    onClose() {}
    close() {}
    registerDomEvent() {}
  },
}));

// Mock ChangeLogService
jest.mock("../../services/ChangeLogService", () => ({
  ChangeLogService: {
    getReleases: jest.fn().mockResolvedValue([
      {
        version: "1.5.0",
        date: "2024-01-15",
        notes: "# Version 1.5.0\n\n- New feature 1\n- Bug fix 2",
        url: "https://github.com/user/repo/releases/tag/v1.5.0",
      },
      {
        version: "1.4.0",
        date: "2024-01-10",
        notes: "# Version 1.4.0\n\n- Feature improvements",
        url: "https://github.com/user/repo/releases/tag/v1.4.0",
      },
      {
        version: "1.3.0",
        date: "2024-01-05",
        notes: "# Version 1.3.0\n\n- Initial release",
        url: "https://github.com/user/repo/releases/tag/v1.3.0",
      },
    ]),
    findIndexByVersion: jest.fn().mockReturnValue(0),
    getReleasesPageUrl: jest.fn().mockReturnValue("https://github.com/user/repo/releases"),
  },
}));

describe("ChangeLogModal", () => {
  let mockApp: App;
  let modal: ChangeLogModal;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = new App();

    modal = new ChangeLogModal(mockApp);
  });

  afterEach(() => {
    modal.close();
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      expect(modal).toBeInstanceOf(ChangeLogModal);
    });

    it("accepts options with startVersion", () => {
      const options: ChangeLogModalOptions = { startVersion: "1.4.0" };
      const modalWithOptions = new ChangeLogModal(mockApp, options);

      expect(modalWithOptions).toBeInstanceOf(ChangeLogModal);
    });
  });

  describe("onOpen", () => {
    it("loads changelog entries", async () => {
      await modal.onOpen();

      expect(ChangeLogService.getReleases).toHaveBeenCalled();
    });

    it("creates version select dropdown", async () => {
      await modal.onOpen();

      expect((modal as any).versionSelectEl).toBeDefined();
    });

    it("creates navigation buttons", async () => {
      await modal.onOpen();

      expect((modal as any).prevButton).toBeDefined();
      expect((modal as any).nextButton).toBeDefined();
    });

    it("creates GitHub button", async () => {
      await modal.onOpen();

      expect((modal as any).viewOnGitHubButton).toBeDefined();
    });

    it("renders current entry", async () => {
      await modal.onOpen();

      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });

    it("finds startVersion in entries", async () => {
      (ChangeLogService.findIndexByVersion as jest.Mock).mockReturnValue(1);

      const modalWithVersion = new ChangeLogModal(mockApp, { startVersion: "1.4.0" });
      await modalWithVersion.onOpen();

      expect(ChangeLogService.findIndexByVersion).toHaveBeenCalledWith(
        expect.any(Array),
        "1.4.0"
      );
    });
  });

  describe("navigation", () => {
    it("goes to previous entry", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 1;

      (modal as any).goPrevious();

      expect((modal as any).currentIndex).toBe(0);
    });

    it("does not go before first entry", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 0;

      (modal as any).goPrevious();

      expect((modal as any).currentIndex).toBe(0);
    });

    it("goes to next entry", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 0;

      (modal as any).goNext();

      expect((modal as any).currentIndex).toBe(1);
    });

    it("does not go past last entry", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 2; // Last entry

      (modal as any).goNext();

      expect((modal as any).currentIndex).toBe(2);
    });
  });

  describe("updateControls", () => {
    it("disables prev button at start", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 0;

      (modal as any).updateControls();

      expect((modal as any).prevButton.disabled).toBe(true);
    });

    it("disables next button at end", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 2;

      (modal as any).updateControls();

      expect((modal as any).nextButton.disabled).toBe(true);
    });

    it("enables both buttons in middle", async () => {
      await modal.onOpen();
      (modal as any).currentIndex = 1;

      (modal as any).updateControls();

      expect((modal as any).prevButton.disabled).toBe(false);
      expect((modal as any).nextButton.disabled).toBe(false);
    });
  });

  describe("openOnGitHub", () => {
    it("opens entry URL in new tab", async () => {
      // Ensure we have the right entries
      (ChangeLogService.getReleases as jest.Mock).mockResolvedValue([
        { version: "1.5.0", date: "2024-01-15", notes: "Notes", url: "https://github.com/user/repo/releases/tag/v1.5.0" },
        { version: "1.4.0", date: "2024-01-10", notes: "Notes", url: "https://github.com/user/repo/releases/tag/v1.4.0" },
      ]);
      (ChangeLogService.findIndexByVersion as jest.Mock).mockReturnValue(0);

      const windowOpenSpy = jest.spyOn(window, "open").mockImplementation(() => null);

      const testModal = new ChangeLogModal(mockApp);
      await testModal.onOpen();
      (testModal as any).openOnGitHub();

      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://github.com/user/repo/releases/tag/v1.5.0",
        "_blank"
      );

      windowOpenSpy.mockRestore();
    });

    it("opens releases page if no entry URL", async () => {
      const windowOpenSpy = jest.spyOn(window, "open").mockImplementation(() => null);
      (ChangeLogService.getReleases as jest.Mock).mockResolvedValue([
        { version: "1.0.0", date: "2024-01-01", notes: "Notes", url: null },
      ]);

      const modalNoUrl = new ChangeLogModal(mockApp);
      await modalNoUrl.onOpen();
      (modalNoUrl as any).openOnGitHub();

      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://github.com/user/repo/releases",
        "_blank"
      );

      windowOpenSpy.mockRestore();
    });
  });

  describe("populateVersionSelect", () => {
    it("populates dropdown with all versions", async () => {
      // Reset to default mock
      (ChangeLogService.getReleases as jest.Mock).mockResolvedValue([
        { version: "1.5.0", date: "2024-01-15", notes: "Notes", url: "url" },
        { version: "1.4.0", date: "2024-01-10", notes: "Notes", url: "url" },
        { version: "1.3.0", date: "2024-01-05", notes: "Notes", url: "url" },
      ]);

      const testModal = new ChangeLogModal(mockApp);
      await testModal.onOpen();

      const select = (testModal as any).versionSelectEl as HTMLSelectElement;
      expect(select.options.length).toBe(3);
    });

    it("formats version options correctly", async () => {
      // Reset to default mock
      (ChangeLogService.getReleases as jest.Mock).mockResolvedValue([
        { version: "1.5.0", date: "2024-01-15", notes: "Notes", url: "url" },
        { version: "1.4.0", date: "2024-01-10", notes: "Notes", url: "url" },
        { version: "1.3.0", date: "2024-01-05", notes: "Notes", url: "url" },
      ]);

      const testModal = new ChangeLogModal(mockApp);
      await testModal.onOpen();

      const select = (testModal as any).versionSelectEl as HTMLSelectElement;
      expect(select.options[0].text).toContain("1.5.0");
      expect(select.options[0].text).toContain("2024-01-15");
    });
  });

  describe("renderCurrent", () => {
    it("handles empty entries gracefully", async () => {
      (ChangeLogService.getReleases as jest.Mock).mockResolvedValue([]);

      const emptyModal = new ChangeLogModal(mockApp);
      await emptyModal.onOpen();

      // Should not throw
      expect((emptyModal as any).entries.length).toBe(0);
    });

    it("renders markdown notes", async () => {
      await modal.onOpen();

      // Verify markdown was rendered (content comes from ChangeLogService mock)
      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });

    it("shows fallback message for missing notes", async () => {
      (ChangeLogService.getReleases as jest.Mock).mockResolvedValue([
        { version: "1.0.0", date: "2024-01-01", notes: null, url: null },
      ]);

      const modalNoNotes = new ChangeLogModal(mockApp);
      await modalNoNotes.onOpen();

      // Verify markdown was rendered with fallback
      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });
  });

  describe("onClose", () => {
    it("unloads component", async () => {
      await modal.onOpen();

      modal.onClose();

      expect((modal as any).component.unload).toHaveBeenCalled();
    });
  });

  describe("keyboard navigation", () => {
    it("has keyboard event registration", async () => {
      await modal.onOpen();

      // Verify modal has tabindex for keyboard focus
      expect(modal.modalEl.setAttr).toHaveBeenCalledWith("tabindex", "-1");
    });
  });
});
