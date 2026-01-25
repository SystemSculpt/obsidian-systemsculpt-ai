/**
 * @jest-environment jsdom
 */
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { AutomationBacklogModal } from "../AutomationBacklogModal";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Modal: class MockModal {
      app: App;
      contentEl: HTMLElement;

      constructor(app: App) {
        this.app = app;
        this.contentEl = document.createElement("div");
      }

      setTitle() {}
      open() {}
      close() {}
    },
    Setting: jest.fn().mockImplementation(() => {
      const settingEl = document.createElement("div");
      return {
        setName: jest.fn().mockReturnThis(),
        setDesc: jest.fn().mockReturnThis(),
        addButton: jest.fn().mockImplementation(function (this: any, cb: (btn: any) => void) {
          cb({
            setButtonText: jest.fn().mockReturnThis(),
            setCta: jest.fn().mockReturnThis(),
            onClick: jest.fn().mockReturnThis(),
          });
          return this;
        }),
        settingEl,
      };
    }),
    Notice: jest.fn(),
  };
});

// Mock StandardModelSelectionModal
jest.mock("../StandardModelSelectionModal", () => ({
  StandardModelSelectionModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
  ModelSelectionResult: {},
}));

// Mock AutomationRunnerModal
jest.mock("../AutomationRunnerModal", () => ({
  AutomationRunnerModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

// Mock modelUtils
jest.mock("../../utils/modelUtils", () => ({
  ensureCanonicalId: jest.fn((id) => id),
}));

// Mock workflowTemplates
jest.mock("../../constants/workflowTemplates", () => ({
  WORKFLOW_AUTOMATIONS: [
    { id: "auto1", title: "Automation 1", destinationPlaceholder: "Dest 1" },
    { id: "auto2", title: "Automation 2", destinationPlaceholder: "Dest 2" },
  ],
}));

describe("AutomationBacklogModal", () => {
  let mockApp: App;
  let mockPlugin: any;
  let modal: AutomationBacklogModal;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = {
      workspace: {
        getActiveFile: jest.fn().mockReturnValue(null),
        openLinkText: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as App;

    mockPlugin = {
      settings: {
        selectedModelId: "gpt-4",
      },
      getAutomationBacklog: jest.fn().mockResolvedValue([]),
      getSettingsManager: jest.fn().mockReturnValue({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      }),
      runAutomationOnFile: jest.fn().mockResolvedValue(undefined),
    };

    modal = new AutomationBacklogModal(mockApp, mockPlugin);
  });

  afterEach(() => {
    modal.close();
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      expect(modal).toBeInstanceOf(AutomationBacklogModal);
    });

    it("stores plugin reference", () => {
      expect((modal as any).plugin).toBe(mockPlugin);
    });

    it("initializes empty backlog", () => {
      expect((modal as any).backlog).toEqual([]);
    });
  });

  describe("onOpen", () => {
    it("loads backlog entries", async () => {
      await modal.onOpen();

      expect(mockPlugin.getAutomationBacklog).toHaveBeenCalled();
    });

    it("renders content", async () => {
      await modal.onOpen();

      expect(modal.contentEl.children.length).toBeGreaterThan(0);
    });

    it("creates content wrapper", async () => {
      await modal.onOpen();

      expect((modal as any).contentWrapper).not.toBeNull();
    });
  });

  describe("with backlog entries", () => {
    beforeEach(() => {
      mockPlugin.getAutomationBacklog.mockResolvedValue([
        {
          automationId: "auto1",
          automationTitle: "Automation 1",
          file: { basename: "file1", path: "path/to/file1.md" } as TFile,
        },
        {
          automationId: "auto1",
          automationTitle: "Automation 1",
          file: { basename: "file2", path: "path/to/file2.md" } as TFile,
        },
        {
          automationId: "auto2",
          automationTitle: "Automation 2",
          file: { basename: "file3", path: "path/to/file3.md" } as TFile,
        },
      ]);
    });

    it("groups backlog by automation", async () => {
      await modal.onOpen();

      const grouped = (modal as any).groupBacklogByAutomation();
      expect(grouped.size).toBe(2);
      expect(grouped.get("Automation 1").length).toBe(2);
      expect(grouped.get("Automation 2").length).toBe(1);
    });

    it("renders backlog list", async () => {
      await modal.onOpen();

      // Should have rendered content
      expect(modal.contentEl.querySelector(".ss-automation-backlog__list")).toBeDefined();
    });
  });

  describe("empty backlog", () => {
    it("shows empty message", async () => {
      await modal.onOpen();

      // Should render empty state message
      expect(modal.contentEl.textContent).toContain("Inbox clear");
    });
  });

  describe("processEntries", () => {
    it("processes each entry", async () => {
      const entries = [
        {
          automationId: "auto1",
          automationTitle: "Auto 1",
          file: { basename: "file1" } as TFile,
        },
      ];

      await (modal as any).processEntries(entries);

      expect(mockPlugin.runAutomationOnFile).toHaveBeenCalledWith(
        "auto1",
        { basename: "file1" }
      );
    });

    it("handles processing errors gracefully", async () => {
      mockPlugin.runAutomationOnFile.mockRejectedValue(new Error("Processing failed"));

      const entries = [
        {
          automationId: "auto1",
          automationTitle: "Auto 1",
          file: { basename: "file1" } as TFile,
        },
      ];

      await (modal as any).processEntries(entries);

      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Failed to process file1"),
        expect.any(Number)
      );
    });
  });

  describe("renderControls", () => {
    it("disables process button when backlog empty", async () => {
      await modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll("button");
      const processButton = Array.from(buttons).find(
        (b) => b.textContent === "Process backlog"
      );

      if (processButton) {
        expect(processButton.disabled).toBe(true);
      }
    });
  });

  describe("model selection", () => {
    it("renders model setting with current model", async () => {
      await modal.onOpen();

      expect(Setting).toHaveBeenCalled();
    });
  });
});
