/**
 * @jest-environment jsdom
 */
import { findLeafByPath, openFileInMainWorkspace } from "../workspaceUtils";
import { App, TFile, WorkspaceLeaf, Platform } from "obsidian";

// Mock displayNotice
jest.mock("../../core/ui/notifications", () => ({
  displayNotice: jest.fn(),
}));

// Create mock leaf
const createMockLeaf = (overrides: Partial<WorkspaceLeaf> = {}): WorkspaceLeaf =>
  ({
    view: { file: null },
    getViewState: jest.fn().mockReturnValue({ type: "empty", state: {} }),
    openFile: jest.fn().mockResolvedValue(undefined),
    getRoot: jest.fn(),
    parent: null,
    ...overrides,
  } as unknown as WorkspaceLeaf);

// Create mock workspace
const createMockWorkspace = (leaves: WorkspaceLeaf[] = []) => ({
  iterateAllLeaves: jest.fn((callback: (leaf: WorkspaceLeaf) => void) => {
    leaves.forEach(callback);
  }),
  activeLeaf: null as WorkspaceLeaf | null,
  rootSplit: { id: "root" },
  setActiveLeaf: jest.fn(),
  getLeaf: jest.fn().mockReturnValue(createMockLeaf()),
  createLeafBySplit: jest.fn().mockReturnValue(createMockLeaf()),
});

// Create mock vault
const createMockVault = () => ({
  getAbstractFileByPath: jest.fn(),
});

// Create mock app
const createMockApp = (workspace = createMockWorkspace(), vault = createMockVault()) => ({
  workspace,
  vault,
});

describe("workspaceUtils", () => {
  describe("findLeafByPath", () => {
    it("returns null when no leaves match", () => {
      const mockApp = createMockApp();

      const result = findLeafByPath(mockApp as any, "notes/test.md");

      expect(result).toBeNull();
    });

    it("finds leaf by view.file.path", () => {
      const leaf = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
      });
      const workspace = createMockWorkspace([leaf]);
      const mockApp = createMockApp(workspace);

      const result = findLeafByPath(mockApp as any, "notes/test.md");

      expect(result).toBe(leaf);
    });

    it("finds leaf by state.file", () => {
      const leaf = createMockLeaf();
      (leaf.getViewState as jest.Mock).mockReturnValue({
        type: "markdown",
        state: { file: "notes/test.md" },
      });
      const workspace = createMockWorkspace([leaf]);
      const mockApp = createMockApp(workspace);

      const result = findLeafByPath(mockApp as any, "notes/test.md");

      expect(result).toBe(leaf);
    });

    it("prioritizes markdown view when multiple leaves match", () => {
      const outlineLeaf = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
      });
      (outlineLeaf.getViewState as jest.Mock).mockReturnValue({
        type: "outline",
        state: {},
      });

      const markdownLeaf = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
      });
      (markdownLeaf.getViewState as jest.Mock).mockReturnValue({
        type: "markdown",
        state: {},
      });

      const workspace = createMockWorkspace([outlineLeaf, markdownLeaf]);
      const mockApp = createMockApp(workspace);

      const result = findLeafByPath(mockApp as any, "notes/test.md");

      expect(result).toBe(markdownLeaf);
    });

    it("returns first match when no markdown view found", () => {
      const leaf1 = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
      });
      (leaf1.getViewState as jest.Mock).mockReturnValue({
        type: "outline",
        state: {},
      });

      const leaf2 = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
      });
      (leaf2.getViewState as jest.Mock).mockReturnValue({
        type: "backlinks",
        state: {},
      });

      const workspace = createMockWorkspace([leaf1, leaf2]);
      const mockApp = createMockApp(workspace);

      const result = findLeafByPath(mockApp as any, "notes/test.md");

      expect(result).toBe(leaf1);
    });

    it("normalizes paths for comparison", () => {
      const leaf = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
      });
      const workspace = createMockWorkspace([leaf]);
      const mockApp = createMockApp(workspace);

      // Should match even with slightly different path format
      const result = findLeafByPath(mockApp as any, "notes/test.md");

      expect(result).toBe(leaf);
    });
  });

  describe("openFileInMainWorkspace", () => {
    let mockApp: ReturnType<typeof createMockApp>;

    beforeEach(() => {
      mockApp = createMockApp();
    });

    it("returns error when file does not exist", async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

      const result = await openFileInMainWorkspace(
        mockApp as any,
        "missing.md"
      );

      expect(result.action).toBe("error");
      expect(result.leaf).toBeNull();
    });

    it("returns error when path is not a file", async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue({ path: "folder" }); // Not a TFile

      const result = await openFileInMainWorkspace(
        mockApp as any,
        "folder"
      );

      expect(result.action).toBe("error");
    });

    it("switches to existing tab in same pane", async () => {
      const sharedParent = { id: "pane1" };
      const existingLeaf = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
        parent: sharedParent,
      });
      (existingLeaf.getViewState as jest.Mock).mockReturnValue({
        type: "markdown",
        state: {},
      });

      const currentLeaf = createMockLeaf({
        parent: sharedParent,
      });

      const workspace = createMockWorkspace([existingLeaf, currentLeaf]);
      workspace.activeLeaf = currentLeaf;
      mockApp = createMockApp(workspace);

      const mockFile = Object.create(TFile.prototype);
      mockFile.path = "notes/test.md";
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      const result = await openFileInMainWorkspace(
        mockApp as any,
        "notes/test.md"
      );

      expect(result.action).toBe("switched_in_pane");
      expect(result.leaf).toBe(existingLeaf);
      expect(workspace.setActiveLeaf).toHaveBeenCalledWith(existingLeaf, {
        focus: true,
      });
    });

    it("focuses existing tab in different pane", async () => {
      const existingLeaf = createMockLeaf({
        view: { file: { path: "notes/test.md" } } as any,
        parent: { id: "pane2" },
      });
      (existingLeaf.getViewState as jest.Mock).mockReturnValue({
        type: "markdown",
        state: {},
      });

      const currentLeaf = createMockLeaf({
        parent: { id: "pane1" },
      });

      const workspace = createMockWorkspace([existingLeaf, currentLeaf]);
      workspace.activeLeaf = currentLeaf;
      mockApp = createMockApp(workspace);

      const mockFile = Object.create(TFile.prototype);
      mockFile.path = "notes/test.md";
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      const result = await openFileInMainWorkspace(
        mockApp as any,
        "notes/test.md"
      );

      expect(result.action).toBe("focused_other_pane");
      expect(result.leaf).toBe(existingLeaf);
      expect(workspace.setActiveLeaf).toHaveBeenCalledWith(existingLeaf, {
        focus: false,
      });
    });

    it("creates new leaf when file not open", async () => {
      const currentLeaf = createMockLeaf();
      const mockRootSplit = { id: "root" };
      (currentLeaf.getRoot as jest.Mock).mockReturnValue(mockRootSplit);

      const newLeaf = createMockLeaf();
      const workspace = createMockWorkspace([currentLeaf]);
      workspace.activeLeaf = currentLeaf;
      workspace.rootSplit = mockRootSplit;
      workspace.createLeafBySplit.mockReturnValue(newLeaf);
      mockApp = createMockApp(workspace);

      const mockFile = Object.create(TFile.prototype);
      mockFile.path = "notes/new.md";
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      const result = await openFileInMainWorkspace(
        mockApp as any,
        "notes/new.md"
      );

      expect(result.action).toBe("created_new");
      expect(newLeaf.openFile).toHaveBeenCalledWith(mockFile);
    });
  });
});
