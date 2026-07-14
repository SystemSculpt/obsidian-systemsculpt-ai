/**
 * @jest-environment node
 */

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
  TFile: jest.fn(),
  TFolder: jest.fn(),
  normalizePath: jest.fn((path: string) => path),
}));

// Mock the plugin
jest.mock("../../../main", () => ({}));

// Mock toolDefinitions
jest.mock("../toolDefinitions", () => ({
  toolDefinitions: [
    { name: "read", description: "Read files" },
    { name: "write", description: "Write file" },
    { name: "edit", description: "Edit file" },
    { name: "multi_edit", description: "Edit multiple files" },
    { name: "create_folders", description: "Create folders" },
    { name: "list_items", description: "List items" },
    { name: "move", description: "Move items" },
    { name: "trash", description: "Trash files" },
    { name: "find", description: "Find files" },
    { name: "search", description: "Search files" },
    { name: "open", description: "Open files" },
    { name: "context", description: "Manage context" },
  ],
}));

// Mock operation classes
const mockReadFiles = jest.fn();
const mockWriteFile = jest.fn();
const mockEditFile = jest.fn();
const mockMultiEditFiles = jest.fn();
const mockCreateDirectories = jest.fn();
const mockListDirectories = jest.fn();
const mockMoveItems = jest.fn();
const mockTrashFiles = jest.fn();
const mockFindFiles = jest.fn();
const mockGrepVault = jest.fn();
const mockManageWorkspace = jest.fn();
const mockManageContext = jest.fn();

jest.mock("../tools/FileOperations", () => ({
  FileOperations: jest.fn().mockImplementation(() => ({
    readFiles: mockReadFiles,
    writeFile: mockWriteFile,
    editFile: mockEditFile,
    multiEditFiles: mockMultiEditFiles,
  })),
}));

jest.mock("../tools/DirectoryOperations", () => ({
  DirectoryOperations: jest.fn().mockImplementation(() => ({
    createDirectories: mockCreateDirectories,
    listDirectories: mockListDirectories,
    moveItems: mockMoveItems,
    trashFiles: mockTrashFiles,
  })),
}));

jest.mock("../tools/SearchOperations", () => ({
  SearchOperations: jest.fn().mockImplementation(() => ({
    findFiles: mockFindFiles,
    grepVault: mockGrepVault,
  })),
}));

jest.mock("../tools/ManagementOperations", () => ({
  ManagementOperations: jest.fn().mockImplementation(() => ({
    manageWorkspace: mockManageWorkspace,
    manageContext: mockManageContext,
  })),
}));

import { VaultToolModule } from "../VaultToolModule";
import { FileOperations } from "../tools/FileOperations";
import { DirectoryOperations } from "../tools/DirectoryOperations";
import { SearchOperations } from "../tools/SearchOperations";
import { ManagementOperations } from "../tools/ManagementOperations";

describe("VaultToolModule", () => {
  let server: VaultToolModule;
  let mockApp: any;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
      },
    };

    mockPlugin = {
      settings: {},
    };

    server = new VaultToolModule(mockPlugin, mockApp);
  });

  describe("constructor", () => {
    it("creates instance with plugin and app", () => {
      expect(server).toBeInstanceOf(VaultToolModule);
    });

    it("initializes all operation classes", () => {
      expect(FileOperations).toHaveBeenCalledWith(mockApp, ["/"]);
      expect(DirectoryOperations).toHaveBeenCalledWith(mockApp, ["/"], mockPlugin);
      expect(SearchOperations).toHaveBeenCalledWith(mockApp, ["/"], mockPlugin);
      expect(ManagementOperations).toHaveBeenCalledWith(mockApp, mockPlugin);
    });

    it("sets default allowed paths to root", () => {
      // Verify by checking the constructor calls
      expect(FileOperations).toHaveBeenCalledWith(mockApp, ["/"]);
    });
  });

  describe("getTools", () => {
    it("returns all tool definitions", async () => {
      const tools = await server.getTools();

      expect(tools).toHaveLength(12);
      expect(tools.map((t) => t.name)).toEqual([
        "read",
        "write",
        "edit",
        "multi_edit",
        "create_folders",
        "list_items",
        "move",
        "trash",
        "find",
        "search",
        "open",
        "context",
      ]);
    });
  });

  describe("executeTool", () => {
    describe("read tool", () => {
      it("calls readFiles with correct params", async () => {
        const params = { paths: ["test.md"], encoding: "utf-8" };
        mockReadFiles.mockResolvedValue({ content: "test content" });

        const result = await server.executeTool("read", params);

        expect(mockReadFiles).toHaveBeenCalledWith(params);
        expect(result).toEqual({ content: "test content" });
      });
    });

    describe("write tool", () => {
      it("calls writeFile with correct params", async () => {
        const params = { path: "test.md", content: "new content" };
        mockWriteFile.mockResolvedValue({ success: true });

        const result = await server.executeTool("write", params);

        expect(mockWriteFile).toHaveBeenCalledWith(params);
        expect(result).toEqual({ success: true });
      });
    });

    describe("edit tool", () => {
      it("reports success with applied/skipped counts when edits land", async () => {
        const params = { path: "test.md", edits: [{ oldText: "old", newText: "new" }] };
        mockEditFile.mockResolvedValue({
          diff: "@@ -1 +1 @@\n-old\n+new",
          appliedCount: 1,
          requestedCount: 1,
          skipped: [],
        });

        const result = await server.executeTool("edit", params);

        expect(mockEditFile).toHaveBeenCalledWith(params);
        expect(result).toEqual({
          path: "test.md",
          success: true,
          diff: "@@ -1 +1 @@\n-old\n+new",
          appliedCount: 1,
          requestedCount: 1,
          skipped: [],
        });
      });

      it("reports success:false when zero edits applied (BUG-02)", async () => {
        const params = {
          path: "test.md",
          edits: [{ oldText: "notfound", newText: "x" }],
          strict: false,
        };
        mockEditFile.mockResolvedValue({
          diff: "",
          appliedCount: 0,
          requestedCount: 1,
          skipped: [{ index: 0, reason: "Edit produced no changes" }],
        });

        const result = await server.executeTool("edit", params);

        // The model must not see a phantom success when nothing was applied.
        expect(result.success).toBe(false);
        expect(result.appliedCount).toBe(0);
        expect(result.requestedCount).toBe(1);
        expect(result.skipped).toEqual([{ index: 0, reason: "Edit produced no changes" }]);
      });
    });

    describe("multi_edit tool", () => {
      it("delegates the complete preflight plan", async () => {
        const params = {
          files: [
            { path: "one.md", edits: [{ oldText: "old", newText: "new" }] },
            { path: "two.md", edits: [{ oldText: "before", newText: "after" }] },
          ],
        };
        mockMultiEditFiles.mockResolvedValue({
          success: true,
          requestedFiles: 2,
          appliedFiles: 2,
          preflightFailed: false,
          results: [],
        });

        const result = await server.executeTool("multi_edit", params);

        expect(mockMultiEditFiles).toHaveBeenCalledWith(params);
        expect(result).toMatchObject({ success: true, appliedFiles: 2 });
      });
    });

    describe("create_folders tool", () => {
      it("calls createDirectories with correct params", async () => {
        const params = { paths: ["folder1", "folder2"] };
        mockCreateDirectories.mockResolvedValue({ created: ["folder1", "folder2"] });

        const result = await server.executeTool("create_folders", params);

        expect(mockCreateDirectories).toHaveBeenCalledWith(params);
        expect(result).toEqual({ created: ["folder1", "folder2"] });
      });
    });

    describe("list_items tool", () => {
      it("calls listDirectories with correct params", async () => {
        const params = { path: "/", recursive: false };
        mockListDirectories.mockResolvedValue({ items: ["file1.md", "folder1/"] });

        const result = await server.executeTool("list_items", params);

        expect(mockListDirectories).toHaveBeenCalledWith(params);
        expect(result).toEqual({ items: ["file1.md", "folder1/"] });
      });
    });

    describe("move tool", () => {
      it("calls moveItems with correct params", async () => {
        const params = { sources: ["old.md"], destination: "new/" };
        mockMoveItems.mockResolvedValue({ moved: ["new/old.md"] });

        const result = await server.executeTool("move", params);

        expect(mockMoveItems).toHaveBeenCalledWith(params);
        expect(result).toEqual({ moved: ["new/old.md"] });
      });
    });

    describe("trash tool", () => {
      it("calls trashFiles with correct params", async () => {
        const params = { paths: ["old.md"] };
        mockTrashFiles.mockResolvedValue({ trashed: ["old.md"] });

        const result = await server.executeTool("trash", params);

        expect(mockTrashFiles).toHaveBeenCalledWith(params);
        expect(result).toEqual({ trashed: ["old.md"] });
      });
    });

    describe("find tool", () => {
      it("calls findFiles with correct params", async () => {
        const params = { pattern: "*.md", path: "/" };
        mockFindFiles.mockResolvedValue({ files: ["test.md", "notes.md"] });

        const result = await server.executeTool("find", params);

        expect(mockFindFiles).toHaveBeenCalledWith(params);
        expect(result).toEqual({ files: ["test.md", "notes.md"] });
      });
    });

    describe("search tool", () => {
      it("calls grepVault with correct params", async () => {
        const params = { query: "test", path: "/" };
        mockGrepVault.mockResolvedValue({ matches: [{ file: "test.md", line: 1 }] });

        const result = await server.executeTool("search", params);

        expect(mockGrepVault).toHaveBeenCalledWith(params);
        expect(result).toEqual({ matches: [{ file: "test.md", line: 1 }] });
      });
    });

    describe("open tool", () => {
      it("calls manageWorkspace with correct params", async () => {
        const params = { path: "test.md", action: "open" };
        mockManageWorkspace.mockResolvedValue({ success: true });

        const result = await server.executeTool("open", params);

        expect(mockManageWorkspace).toHaveBeenCalledWith(params);
        expect(result).toEqual({ success: true });
      });
    });

    describe("context tool", () => {
      it("calls manageContext with the originating chat", async () => {
        const params = { action: "add", paths: ["test.md"] };
        const chatView = { contextManager: {} } as any;
        mockManageContext.mockResolvedValue({ context: {} });

        const result = await server.executeTool("context", params, chatView);

        expect(mockManageContext).toHaveBeenCalledWith(params, chatView);
        expect(result).toEqual({ context: {} });
      });
    });

    describe("unknown tool", () => {
      it("throws error for unknown tool", async () => {
        await expect(server.executeTool("unknown_tool", {})).rejects.toThrow(
          "Unknown tool: unknown_tool"
        );
      });
    });
  });

  describe("setAllowedPaths", () => {
    it("updates allowed paths", () => {
      const newPaths = ["/notes", "/documents"];

      server.setAllowedPaths(newPaths);

      // Verify by checking that operation classes are recreated with new paths
      expect(FileOperations).toHaveBeenLastCalledWith(mockApp, ["/notes", "/documents"]);
      expect(DirectoryOperations).toHaveBeenLastCalledWith(
        mockApp,
        ["/notes", "/documents"],
        mockPlugin
      );
      expect(SearchOperations).toHaveBeenLastCalledWith(
        mockApp,
        ["/notes", "/documents"],
        mockPlugin
      );
      expect(ManagementOperations).toHaveBeenLastCalledWith(
        mockApp,
        mockPlugin
      );
    });

    it("recreates all operation classes with new paths", () => {
      jest.clearAllMocks();

      server.setAllowedPaths(["/custom"]);

      expect(FileOperations).toHaveBeenCalledTimes(1);
      expect(DirectoryOperations).toHaveBeenCalledTimes(1);
      expect(SearchOperations).toHaveBeenCalledTimes(1);
      expect(ManagementOperations).toHaveBeenCalledTimes(1);
    });

    it("handles empty paths array", () => {
      server.setAllowedPaths([]);

      expect(FileOperations).toHaveBeenLastCalledWith(mockApp, []);
    });

    it("copies path values to prevent mutation", () => {
      const paths = ["/test"];
      server.setAllowedPaths(paths);

      // Modify original array
      paths.push("/modified");

      // Should still have original values
      expect(FileOperations).toHaveBeenLastCalledWith(mockApp, ["/test"]);
    });
  });

  describe("tool execution errors", () => {
    it("propagates errors from file operations", async () => {
      mockReadFiles.mockRejectedValue(new Error("File not found"));

      await expect(server.executeTool("read", { paths: ["missing.md"] })).rejects.toThrow(
        "File not found"
      );
    });

    it("propagates errors from directory operations", async () => {
      mockCreateDirectories.mockRejectedValue(new Error("Permission denied"));

      await expect(
        server.executeTool("create_folders", { paths: ["/protected"] })
      ).rejects.toThrow("Permission denied");
    });

    it("propagates errors from search operations", async () => {
      mockGrepVault.mockRejectedValue(new Error("Search failed"));

      await expect(server.executeTool("search", { query: "test" })).rejects.toThrow(
        "Search failed"
      );
    });

    it("propagates errors from management operations", async () => {
      mockManageWorkspace.mockRejectedValue(new Error("Workspace error"));

      await expect(server.executeTool("open", { path: "test.md" })).rejects.toThrow(
        "Workspace error"
      );
    });
  });

  describe("integration scenarios", () => {
    it("supports sequential tool operations", async () => {
      // Create folder, then write file
      mockCreateDirectories.mockResolvedValue({ created: ["notes/"] });
      mockWriteFile.mockResolvedValue({ success: true });

      const createResult = await server.executeTool("create_folders", { paths: ["notes/"] });
      expect(createResult).toEqual({ created: ["notes/"] });

      const writeResult = await server.executeTool("write", {
        path: "notes/test.md",
        content: "Hello",
      });
      expect(writeResult).toEqual({ success: true });
    });

    it("supports search then read workflow", async () => {
      mockFindFiles.mockResolvedValue({ files: ["notes/test.md"] });
      mockReadFiles.mockResolvedValue({ content: "Hello" });

      const findResult = await server.executeTool("find", { pattern: "*.md" });
      expect(findResult).toEqual({ files: ["notes/test.md"] });

      const readResult = await server.executeTool("read", { paths: ["notes/test.md"] });
      expect(readResult).toEqual({ content: "Hello" });
    });
  });
});
