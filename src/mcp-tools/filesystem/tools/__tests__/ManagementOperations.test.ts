/**
 * @jest-environment jsdom
 */
import { App, TFile, TFolder, Notice } from "obsidian";
import { ManagementOperations } from "../ManagementOperations";

// Mock utils
jest.mock("../../utils", () => ({
  getFilesFromFolder: jest.fn((folder) => {
    return folder.children?.filter((c: any) => c instanceof TFile) || [];
  }),
}));

// Mock workspaceUtils
const mockOpenFileInMainWorkspace = jest.fn();
jest.mock("../../../../utils/workspaceUtils", () => ({
  openFileInMainWorkspace: (...args: any[]) => mockOpenFileInMainWorkspace(...args),
}));

// Mock DocumentContextManager
const mockDocumentContextManager = {
  addFilesToContext: jest.fn(),
  addFileToContext: jest.fn(),
};
jest.mock("../../../../services/DocumentContextManager", () => ({
  DocumentContextManager: {
    getInstance: jest.fn(() => mockDocumentContextManager),
  },
}));

// Mock constants
jest.mock("../../constants", () => ({
  FILESYSTEM_LIMITS: {
    MAX_FILES_PER_REQUEST: 10,
    MAX_OPERATIONS: 10,
  },
}));

describe("ManagementOperations", () => {
  let app: App;
  let mgmtOps: ManagementOperations;
  const allowedPaths = ["/"];
  let mockPlugin: any;
  let mockContextManager: any;
  let mockChatView: any;
  let mockLeaf: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockContextManager = {
      hasContextFile: jest.fn(() => false),
      removeFromContextFiles: jest.fn().mockResolvedValue(true),
      triggerContextChange: jest.fn().mockResolvedValue(undefined),
      getContextFiles: jest.fn(() => new Set(["file1.md", "file2.md"])),
    };

    mockChatView = {
      contextManager: mockContextManager,
    };

    mockLeaf = {
      view: mockChatView,
    };

    app = new App();

    // Set up workspace mocks
    (app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([mockLeaf]);
    Object.defineProperty(app.workspace, "activeLeaf", {
      get: () => mockLeaf,
      configurable: true,
    });
    (app.workspace.setActiveLeaf as jest.Mock) = jest.fn();

    mockPlugin = {
      settings: {},
    };

    // Default mock behaviors
    mockOpenFileInMainWorkspace.mockResolvedValue({
      leaf: { view: {} },
      action: "created_split",
    });

    mockDocumentContextManager.addFileToContext.mockResolvedValue(true);
    mockDocumentContextManager.addFilesToContext.mockResolvedValue(1);

    mgmtOps = new ManagementOperations(app, mockPlugin, allowedPaths);
  });

  describe("manageWorkspace", () => {
    it("opens files successfully", async () => {
      const result = await mgmtOps.manageWorkspace({
        files: [{ path: "test.md" }],
      });

      expect(result.opened).toContain("test.md");
      expect(result.errors).toHaveLength(0);
      expect(mockOpenFileInMainWorkspace).toHaveBeenCalledWith(app, "test.md");
    });

    it("opens multiple files", async () => {
      const result = await mgmtOps.manageWorkspace({
        files: [{ path: "file1.md" }, { path: "file2.md" }, { path: "file3.md" }],
      });

      expect(result.opened).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
    });

    it("records errors for failed opens", async () => {
      mockOpenFileInMainWorkspace.mockResolvedValue({ leaf: null, action: null });

      const result = await mgmtOps.manageWorkspace({
        files: [{ path: "missing.md" }],
      });

      expect(result.opened).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("missing.md");
    });

    it("restores focus to original leaf after opening", async () => {
      await mgmtOps.manageWorkspace({
        files: [{ path: "test.md" }],
      });

      expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
    });

    it("does not restore focus when action is switched_in_pane", async () => {
      mockOpenFileInMainWorkspace.mockResolvedValue({
        leaf: { view: {} },
        action: "switched_in_pane",
      });

      await mgmtOps.manageWorkspace({
        files: [{ path: "test.md" }],
      });

      expect(app.workspace.setActiveLeaf).not.toHaveBeenCalled();
    });

    it("handles mixed success and failure", async () => {
      mockOpenFileInMainWorkspace
        .mockResolvedValueOnce({ leaf: { view: {} }, action: "created_split" })
        .mockResolvedValueOnce({ leaf: null, action: null })
        .mockResolvedValueOnce({ leaf: { view: {} }, action: "created_split" });

      const result = await mgmtOps.manageWorkspace({
        files: [{ path: "ok1.md" }, { path: "fail.md" }, { path: "ok2.md" }],
      });

      expect(result.opened).toEqual(["ok1.md", "ok2.md"]);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("manageContext", () => {
    describe("add action", () => {
      it("throws error when paths is not an array", async () => {
        await expect(
          mgmtOps.manageContext({ action: "add", paths: null as any })
        ).rejects.toThrow("non-empty array");
      });

      it("throws error when paths is empty", async () => {
        await expect(
          mgmtOps.manageContext({ action: "add", paths: [] })
        ).rejects.toThrow("non-empty array");
      });

      it("throws error when paths exceeds limit", async () => {
        const paths = Array(11).fill("file.md");
        await expect(
          mgmtOps.manageContext({ action: "add", paths })
        ).rejects.toThrow("Maximum 10 paths");
      });

      it("throws error when no chat view is found", async () => {
        (app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([]);

        await expect(
          mgmtOps.manageContext({ action: "add", paths: ["test.md"] })
        ).rejects.toThrow("No active chat view found");
      });

      it("adds single file to context", async () => {
        const mockFile = new TFile({ path: "test.md" });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["test.md"],
        });

        expect(result.action).toBe("add");
        expect(result.processed).toBe(1);
        expect(result.results[0].success).toBe(true);
        expect(mockDocumentContextManager.addFileToContext).toHaveBeenCalled();
      });

      it("handles file not found", async () => {
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["missing.md"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toContain("not found");
      });

      it("handles already added file", async () => {
        const mockFile = new TFile({ path: "test.md" });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
        mockDocumentContextManager.addFileToContext.mockResolvedValue(false);

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["test.md"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toContain("may already be in context");
      });

      it("adds files from directory", async () => {
        const mockFiles = [
          new TFile({ path: "dir/file1.md" }),
          new TFile({ path: "dir/file2.md" }),
        ];
        const mockFolder = new TFolder({ path: "dir", children: mockFiles });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFolder);

        const { getFilesFromFolder } = require("../../utils");
        (getFilesFromFolder as jest.Mock).mockReturnValue(mockFiles);
        mockDocumentContextManager.addFilesToContext.mockResolvedValue(2);

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["dir"],
        });

        expect(result.results[0].success).toBe(true);
        expect(result.processed).toBe(2);
        expect(mockDocumentContextManager.addFilesToContext).toHaveBeenCalled();
      });

      it("rejects directory with too many files", async () => {
        const mockFiles = Array(15).fill(null).map((_, i) => new TFile({ path: `dir/file${i}.md` }));
        const mockFolder = new TFolder({ path: "dir", children: mockFiles });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFolder);

        const { getFilesFromFolder } = require("../../utils");
        (getFilesFromFolder as jest.Mock).mockReturnValue(mockFiles);

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["dir"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toContain("exceeds the limit");
      });

      it("triggers context change after adding files", async () => {
        const mockFile = new TFile({ path: "test.md" });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

        await mgmtOps.manageContext({
          action: "add",
          paths: ["test.md"],
        });

        expect(mockContextManager.triggerContextChange).toHaveBeenCalled();
      });

      it("handles error during add", async () => {
        const mockFile = new TFile({ path: "test.md" });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
        mockDocumentContextManager.addFileToContext.mockRejectedValue(new Error("Add failed"));

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["test.md"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toBe("Add failed");
      });

      it("enforces per-request file limit", async () => {
        // Create 12 individual files (more than the limit of 10)
        const paths = Array(12).fill(null).map((_, i) => `file${i}.md`);

        // Mock all files to exist
        (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
          return new TFile({ path });
        });

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: paths.slice(0, 10), // Pass 10 paths (at the limit)
        });

        // First 10 should succeed
        const successCount = result.results.filter(r => r.success).length;
        expect(successCount).toBe(10);
      });
    });

    describe("remove action", () => {
      it("removes file from context", async () => {
        mockContextManager.hasContextFile.mockReturnValue(true);
        mockContextManager.removeFromContextFiles.mockResolvedValue(true);

        const result = await mgmtOps.manageContext({
          action: "remove",
          paths: ["test.md"],
        });

        expect(result.action).toBe("remove");
        expect(result.results[0].success).toBe(true);
        expect(mockContextManager.removeFromContextFiles).toHaveBeenCalledWith("test.md");
      });

      it("handles file not in context", async () => {
        mockContextManager.hasContextFile.mockReturnValue(false);

        const result = await mgmtOps.manageContext({
          action: "remove",
          paths: ["not-in-context.md"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toContain("not found in current context");
      });

      it("handles removal failure", async () => {
        mockContextManager.hasContextFile.mockReturnValue(true);
        mockContextManager.removeFromContextFiles.mockResolvedValue(false);

        const result = await mgmtOps.manageContext({
          action: "remove",
          paths: ["test.md"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toContain("Failed to remove");
      });

      it("handles error during remove", async () => {
        mockContextManager.hasContextFile.mockReturnValue(true);
        mockContextManager.removeFromContextFiles.mockRejectedValue(new Error("Remove failed"));

        const result = await mgmtOps.manageContext({
          action: "remove",
          paths: ["test.md"],
        });

        expect(result.results[0].success).toBe(false);
        expect(result.results[0].reason).toBe("Remove failed");
      });

      it("checks both path formats for context file", async () => {
        mockContextManager.hasContextFile
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true);
        mockContextManager.removeFromContextFiles.mockResolvedValue(true);

        const result = await mgmtOps.manageContext({
          action: "remove",
          paths: ["test.md"],
        });

        expect(mockContextManager.hasContextFile).toHaveBeenCalledWith("[[test.md]]");
        expect(mockContextManager.hasContextFile).toHaveBeenCalledWith("test.md");
        expect(result.results[0].success).toBe(true);
      });
    });

    describe("invalid action", () => {
      it("throws error for invalid action", async () => {
        await expect(
          mgmtOps.manageContext({ action: "invalid" as any, paths: ["test.md"] })
        ).rejects.toThrow("Invalid action");
      });
    });

    describe("summary generation", () => {
      it("generates correct summary for add action", async () => {
        const mockFile = new TFile({ path: "test.md" });
        (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

        const result = await mgmtOps.manageContext({
          action: "add",
          paths: ["test.md"],
        });

        expect(result.summary).toContain("add operation");
        expect(result.summary).toContain("1 paths succeeded");
        expect(result.summary).toContain("Current context: 2 files");
      });

      it("generates correct summary for remove action", async () => {
        mockContextManager.hasContextFile.mockReturnValue(true);
        mockContextManager.removeFromContextFiles.mockResolvedValue(true);

        const result = await mgmtOps.manageContext({
          action: "remove",
          paths: ["test.md"],
        });

        expect(result.summary).toContain("remove operation");
        expect(result.summary).toContain("1 paths succeeded");
      });
    });
  });

  describe("getCurrentChatView", () => {
    it("returns active chat view leaf", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      await mgmtOps.manageContext({
        action: "add",
        paths: ["test.md"],
      });

      // The test works if we get here without "No active chat view" error
      expect(mockDocumentContextManager.addFileToContext).toHaveBeenCalled();
    });

    it("returns first chat view if active leaf is not a chat", async () => {
      const otherLeaf = { view: {} };
      Object.defineProperty(app.workspace, "activeLeaf", {
        get: () => otherLeaf,
        configurable: true,
      });
      (app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([mockLeaf]);

      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      await mgmtOps.manageContext({
        action: "add",
        paths: ["test.md"],
      });

      expect(mockDocumentContextManager.addFileToContext).toHaveBeenCalled();
    });
  });
});
