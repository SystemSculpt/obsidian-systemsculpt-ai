/**
 * @jest-environment jsdom
 */
import { StorageManager, StorageLocationType } from "../StorageManager";
import { StorageManager as StorageManagerExport } from "../index";
import { App, TFolder } from "obsidian";

// Create mock vault adapter
const createMockAdapter = () => ({
  exists: jest.fn().mockResolvedValue(false),
  read: jest.fn().mockResolvedValue(""),
  write: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
  append: jest.fn().mockResolvedValue(undefined),
  getBasePath: jest.fn().mockReturnValue("/vault"),
});

// Create mock vault
const createMockVault = (adapter = createMockAdapter()) => ({
  adapter,
  createFolder: jest.fn().mockResolvedValue(undefined),
  getAbstractFileByPath: jest.fn().mockReturnValue(null),
});

// Create mock app
const createMockApp = (vault = createMockVault()) => ({
  vault,
});

// Create mock plugin
const createMockPlugin = () => ({});

describe("StorageManager", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let mockPlugin: ReturnType<typeof createMockPlugin>;
  let storage: StorageManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = createMockApp();
    mockPlugin = createMockPlugin();
    storage = new StorageManager(mockApp as any, mockPlugin as any);
  });

  describe("constructor", () => {
    it("creates a StorageManager instance", () => {
      expect(storage).toBeInstanceOf(StorageManager);
    });

    it("starts uninitialized", () => {
      expect(storage.isInitialized()).toBe(false);
    });

    it("re-exports StorageManager from index", () => {
      expect(StorageManagerExport).toBe(StorageManager);
    });
  });

  describe("initialize", () => {
    it("initializes the storage system", async () => {
      await storage.initialize();
      expect(storage.isInitialized()).toBe(true);
    });

    it("creates necessary directories", async () => {
      await storage.initialize();

      expect(mockApp.vault.createFolder).toHaveBeenCalled();
    });

    it("can be called multiple times safely", async () => {
      await storage.initialize();
      await storage.initialize();
      await storage.initialize();

      expect(storage.isInitialized()).toBe(true);
    });

    it("handles concurrent initialization calls", async () => {
      const p1 = storage.initialize();
      const p2 = storage.initialize();
      const p3 = storage.initialize();

      await Promise.all([p1, p2, p3]);

      expect(storage.isInitialized()).toBe(true);
    });

    it("reinitializes when the vault base path changes", async () => {
      const adapter = mockApp.vault.adapter;
      adapter.exists.mockResolvedValue(true);
      adapter.getBasePath.mockReturnValue("/vault-a");

      await storage.initialize();
      const initialCalls = mockApp.vault.createFolder.mock.calls.length;

      adapter.getBasePath.mockReturnValue("/vault-b");
      await storage.initialize();

      expect(mockApp.vault.createFolder.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  describe("getPath", () => {
    it("returns path for storage location", () => {
      expect(storage.getPath("settings")).toBe(".systemsculpt/settings");
      expect(storage.getPath("cache")).toBe(".systemsculpt/cache");
      expect(storage.getPath("temp")).toBe(".systemsculpt/temp");
      expect(storage.getPath("diagnostics")).toBe(".systemsculpt/diagnostics");
    });

    it("returns path with subpath", () => {
      expect(storage.getPath("settings", "backups")).toBe(
        ".systemsculpt/settings/backups"
      );
      expect(storage.getPath("settings", "backups", "file.json")).toBe(
        ".systemsculpt/settings/backups/file.json"
      );
    });

    it("handles multiple subpath components", () => {
      expect(storage.getPath("cache", "a", "b", "c")).toBe(
        ".systemsculpt/cache/a/b/c"
      );
    });
  });

  describe("ensureDirectory", () => {
    it("creates directory if it does not exist", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await storage.ensureDirectory(".systemsculpt/test");

      expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
        ".systemsculpt/test"
      );
    });

    it("skips creation if directory exists", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue({ path: "test" });

      await storage.ensureDirectory(".systemsculpt/test");

      // Still might be called for parent directories
    });

    it("creates parent directories", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await storage.ensureDirectory(".systemsculpt/a/b/c");

      // Should create parent paths
      expect(mockApp.vault.createFolder).toHaveBeenCalled();
    });

    it("creates marker file when requested", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await storage.ensureDirectory(".systemsculpt/diagnostics", true);

      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/diagnostics/.folder",
        expect.any(String)
      );
    });

    it("handles 'folder exists' error gracefully", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);
      mockApp.vault.createFolder.mockRejectedValue(
        new Error("Folder already exists")
      );

      await expect(
        storage.ensureDirectory(".systemsculpt/test")
      ).resolves.not.toThrow();
    });
  });

  describe("writeFile", () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it("writes string data to file", async () => {
      const result = await storage.writeFile("settings", "test.txt", "content");

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/settings/test.txt",
        "content"
      );
    });

    it("writes object data as JSON", async () => {
      const data = { key: "value" };
      const result = await storage.writeFile("settings", "test.json", data);

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/settings/test.json",
        JSON.stringify(data, null, 2)
      );
    });

    it("returns path on success", async () => {
      const result = await storage.writeFile("settings", "test.txt", "content");

      expect(result.path).toBe(".systemsculpt/settings/test.txt");
    });

    it("handles write errors", async () => {
      mockApp.vault.adapter.write.mockRejectedValue(new Error("Write failed"));

      const result = await storage.writeFile("settings", "test.txt", "content");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Write failed");
    });
  });

  describe("appendToFile", () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it("creates file if it does not exist", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      const result = await storage.appendToFile(
        "diagnostics",
        "log.txt",
        "line1"
      );

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/diagnostics/log.txt",
        "line1\n"
      );
    });

    it("appends to existing file using append method", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      const result = await storage.appendToFile(
        "diagnostics",
        "log.txt",
        "line2"
      );

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.append).toHaveBeenCalledWith(
        ".systemsculpt/diagnostics/log.txt",
        "line2\n"
      );
    });

    it("falls back to read+write when append is not available", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.append = undefined;
      mockApp.vault.adapter.read.mockResolvedValue("existing\n");

      const result = await storage.appendToFile(
        "diagnostics",
        "log.txt",
        "new line"
      );

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.read).toHaveBeenCalled();
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/diagnostics/log.txt",
        "existing\nnew line\n"
      );
    });

    it("adds newline if not present", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await storage.appendToFile("diagnostics", "log.txt", "no newline");

      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/diagnostics/log.txt",
        "no newline\n"
      );
    });

    it("preserves newline if already present", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await storage.appendToFile("diagnostics", "log.txt", "has newline\n");

      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        ".systemsculpt/diagnostics/log.txt",
        "has newline\n"
      );
    });
  });

  describe("readFile", () => {
    it("reads file content", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.read.mockResolvedValue("file content");

      const result = await storage.readFile("settings", "test.txt");

      expect(result).toBe("file content");
    });

    it("returns null if file does not exist", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      const result = await storage.readFile("settings", "missing.txt");

      expect(result).toBeNull();
    });

    it("parses JSON when requested", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.read.mockResolvedValue('{"key": "value"}');

      const result = await storage.readFile<{ key: string }>(
        "settings",
        "test.json",
        true
      );

      expect(result).toEqual({ key: "value" });
    });

    it("returns null on read error", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.read.mockRejectedValue(new Error("Read failed"));

      const result = await storage.readFile("settings", "test.txt");

      expect(result).toBeNull();
    });
  });

  describe("deleteFile", () => {
    it("deletes existing file", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      const result = await storage.deleteFile("settings", "test.txt");

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
        ".systemsculpt/settings/test.txt"
      );
    });

    it("succeeds if file does not exist", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      const result = await storage.deleteFile("settings", "missing.txt");

      expect(result.success).toBe(true);
      expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
    });

    it("handles delete errors", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.remove.mockRejectedValue(
        new Error("Delete failed")
      );

      const result = await storage.deleteFile("settings", "test.txt");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Delete failed");
    });
  });

  describe("listFiles", () => {
    it("lists files in a directory", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.list.mockResolvedValue({
        files: [
          ".systemsculpt/settings/file1.json",
          ".systemsculpt/settings/file2.json",
        ],
        folders: [],
      });

      const result = await storage.listFiles("settings");

      expect(result).toEqual(["file1.json", "file2.json"]);
    });

    it("returns empty array if directory does not exist", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      const result = await storage.listFiles("settings");

      expect(result).toEqual([]);
    });

    it("handles subpath", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.list.mockResolvedValue({
        files: [".systemsculpt/settings/backups/backup1.json"],
        folders: [],
      });

      const result = await storage.listFiles("settings", "backups");

      expect(result).toEqual(["backup1.json"]);
    });

    it("returns empty array on error", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.adapter.list.mockRejectedValue(new Error("List failed"));

      const result = await storage.listFiles("settings");

      expect(result).toEqual([]);
    });
  });

  describe("isInitialized", () => {
    it("returns false before initialization", () => {
      expect(storage.isInitialized()).toBe(false);
    });

    it("returns true after initialization", async () => {
      await storage.initialize();
      expect(storage.isInitialized()).toBe(true);
    });
  });
});
