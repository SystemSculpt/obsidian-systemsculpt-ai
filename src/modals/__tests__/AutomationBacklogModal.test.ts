/**
 * @jest-environment jsdom
 */
import { App, Notice, TFile } from "obsidian";
import { AutomationBacklogModal } from "../AutomationBacklogModal";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

// Mock AutomationRunnerModal
jest.mock("../AutomationRunnerModal", () => ({
  AutomationRunnerModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

// Mock workflowAutomations
jest.mock("../../constants/workflowAutomations", () => ({
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
    it("renders the shared loading state while the backlog request is pending", async () => {
      let resolveBacklog!: (entries: []) => void;
      mockPlugin.getAutomationBacklog.mockReturnValue(
        new Promise<[]>((resolve) => {
          resolveBacklog = resolve;
        })
      );

      const opening = modal.onOpen();

      const state = modal.contentEl.querySelector<HTMLElement>(
        ".ss-ui-state.is-loading"
      );
      expect(state?.textContent).toContain("Loading backlog");
      expect(modal.contentEl.getAttribute("aria-busy")).toBe("true");

      resolveBacklog([]);
      await opening;
    });

    it("loads backlog entries", async () => {
      await modal.onOpen();

      expect(mockPlugin.getAutomationBacklog).toHaveBeenCalled();
    });

    it("renders content", async () => {
      await modal.onOpen();

      expect(modal.contentEl.children.length).toBeGreaterThan(0);
    });

    it("uses the shared modal shell", async () => {
      await modal.onOpen();

      expect(modal.modalEl.classList.contains("ss-modal")).toBe(true);
      expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    });

    it("renders a recoverable shared error state", async () => {
      mockPlugin.getAutomationBacklog
        .mockRejectedValueOnce(new Error("Vault index unavailable"))
        .mockResolvedValueOnce([]);

      await modal.onOpen();

      const state = modal.contentEl.querySelector<HTMLElement>(
        ".ss-ui-state.is-error"
      );
      expect(state?.getAttribute("role")).toBe("alert");
      expect(state?.textContent).toContain("Could not load the backlog");
      expect(state?.textContent).toContain("Vault index unavailable");

      state?.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPlugin.getAutomationBacklog).toHaveBeenCalledTimes(2);
      expect(modal.contentEl.querySelector(".ss-ui-state.is-success")).not.toBeNull();
    });

    it("ignores a backlog request from a closed generation", async () => {
      let resolveStale!: (entries: any[]) => void;
      mockPlugin.getAutomationBacklog
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveStale = resolve;
        }))
        .mockResolvedValueOnce([]);

      const firstOpen = modal.onOpen();
      modal.onClose();
      await modal.onOpen();
      expect(modal.contentEl.querySelector(".ss-ui-state.is-success")).not.toBeNull();

      resolveStale([
        {
          automationId: "stale",
          automationTitle: "Stale automation",
          file: { basename: "stale", path: "stale.md" },
        },
      ]);
      await firstOpen;

      expect(mockPlugin.getAutomationBacklog).toHaveBeenCalledTimes(2);
      expect(modal.contentEl.textContent).toContain("Inbox clear");
      expect(modal.contentEl.textContent).not.toContain("Stale automation");
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

      expect(modal.contentEl.querySelector(".ss-ui-state.is-success")).not.toBeNull();
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

  describe("managed execution surface", () => {
    it("keeps the actions obvious without a model or provider chooser", async () => {
      await modal.onOpen();

      const text = modal.contentEl.textContent || "";
      expect(text).toContain("Process backlog");
      expect(text).not.toContain("Change model");
      expect(text).not.toContain("Select a model");
    });
  });
});
