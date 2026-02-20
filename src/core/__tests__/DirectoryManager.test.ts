/**
 * @jest-environment jsdom
 */
import { App, TFolder } from "obsidian";
import { DirectoryManager } from "../DirectoryManager";

describe("DirectoryManager", () => {
  let app: App;
  let plugin: any;
  let manager: DirectoryManager;

  beforeEach(() => {
    jest.clearAllMocks();

    app = new App();
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.createFolder as jest.Mock).mockResolvedValue(undefined);
    (app.vault.adapter.write as jest.Mock).mockResolvedValue(undefined);

    plugin = {
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        savedChatsDirectory: "SystemSculpt/SavedChats",
        recordingsDirectory: "SystemSculpt/Recordings",
        videoRecordingsDirectory: "SystemSculpt/Video Recordings",
        systemPromptsDirectory: "SystemSculpt/Prompts",
        attachmentsDirectory: "SystemSculpt/Attachments",
        extractionsDirectory: "SystemSculpt/Extractions",
        verifiedDirectories: [],
      },
      emitter: {
        emit: jest.fn(),
      },
      getSettingsManager: jest.fn().mockReturnValue({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      }),
    };

    manager = new DirectoryManager(app, plugin);
  });

  describe("constructor", () => {
    it("creates instance with app and plugin", () => {
      expect(manager).toBeDefined();
    });

    it("initializes as not initialized", () => {
      expect(manager.isInitialized()).toBe(false);
    });

    it("loads verified directories from settings", () => {
      plugin.settings.verifiedDirectories = ["SystemSculpt", "SystemSculpt/Chats"];
      const mgr = new DirectoryManager(app, plugin);
      expect(mgr).toBeDefined();
    });

    it("handles null verifiedDirectories", () => {
      plugin.settings.verifiedDirectories = null;
      const mgr = new DirectoryManager(app, plugin);
      expect(mgr).toBeDefined();
    });

    it("handles undefined verifiedDirectories", () => {
      delete plugin.settings.verifiedDirectories;
      const mgr = new DirectoryManager(app, plugin);
      expect(mgr).toBeDefined();
    });
  });

  describe("isInitialized", () => {
    it("returns false before initialization", () => {
      expect(manager.isInitialized()).toBe(false);
    });
  });

  describe("getDirectory", () => {
    it("throws if not initialized", () => {
      expect(() => manager.getDirectory("chatsDirectory")).toThrow(
        "Directory manager not initialized"
      );
    });
  });

  describe("normalizePath (private)", () => {
    const normalize = (path: string) => (manager as any).normalizePath(path);

    it("trims whitespace", () => {
      expect(normalize("  folder  ")).toBe("folder");
    });

    it("removes leading slashes", () => {
      expect(normalize("/folder")).toBe("folder");
      expect(normalize("///folder")).toBe("folder");
    });

    it("removes trailing slashes", () => {
      expect(normalize("folder/")).toBe("folder");
      expect(normalize("folder///")).toBe("folder");
    });

    it("collapses multiple slashes", () => {
      expect(normalize("folder//subfolder")).toBe("folder/subfolder");
      expect(normalize("a///b///c")).toBe("a/b/c");
    });

    it("handles empty path", () => {
      expect(normalize("")).toBe("/");
    });

    it("handles just slashes", () => {
      expect(normalize("///")).toBe("/");
    });

    it("preserves single segment paths", () => {
      expect(normalize("folder")).toBe("folder");
    });

    it("handles multi-segment paths", () => {
      expect(normalize("a/b/c")).toBe("a/b/c");
    });
  });

  describe("verifyDirectories", () => {
    it("returns valid when all directories exist", async () => {
      (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      const mockFolder = new TFolder({ path: "SystemSculpt" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFolder);

      const result = await manager.verifyDirectories();

      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("returns issues when main directory is missing", async () => {
      (app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await manager.verifyDirectories();

      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toContain("does not exist");
    });

    it("handles errors during verification", async () => {
      (app.vault.adapter.exists as jest.Mock).mockRejectedValue(
        new Error("Access denied")
      );

      const result = await manager.verifyDirectories();

      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(
        expect.stringContaining("Error verifying")
      );
    });

    it("checks all configured directories", async () => {
      (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      const mockFolder = new TFolder({ path: "folder" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFolder);

      await manager.verifyDirectories();

      // Should have checked existence multiple times
      expect((app.vault.adapter.exists as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    });

    it("skips empty directory paths", async () => {
      plugin.settings.chatsDirectory = "";
      (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      const mockFolder = new TFolder({ path: "folder" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFolder);

      const result = await manager.verifyDirectories();

      // Should still return valid even with empty path
      expect(result.valid).toBe(true);
    });
  });

  describe("createDirectoryOptimized (private)", () => {
    it("throws on empty path", async () => {
      await expect(
        (manager as any).createDirectoryOptimized("")
      ).rejects.toThrow("empty or invalid path");
    });

    it("throws on whitespace-only path", async () => {
      await expect(
        (manager as any).createDirectoryOptimized("   ")
      ).rejects.toThrow("empty or invalid path");
    });
  });

  describe("createDirectory (private)", () => {
    it("calls createDirectoryOptimized", async () => {
      const spy = jest.spyOn(manager as any, "createDirectoryOptimized");
      spy.mockResolvedValue(undefined);

      await (manager as any).createDirectory("test", false, 1000, 0);

      expect(spy).toHaveBeenCalledWith("test", false);
    });
  });

  describe("repair", () => {
    it("calls initialize after clearing cache", async () => {
      // Add something to the cache
      (manager as any).directories.set("test", true);
      expect((manager as any).directories.size).toBe(1);

      // Mock successful initialization
      const initSpy = jest.spyOn(manager, "initialize").mockResolvedValue(undefined);

      const result = await manager.repair();

      // Should have called initialize
      expect(initSpy).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("resets initialization state", async () => {
      (manager as any).initialized = true;
      (manager as any).initializationPromise = Promise.resolve();

      jest.spyOn(manager, "initialize").mockImplementation(async () => {
        (manager as any).initialized = true;
      });

      await manager.repair();

      // Verify initialized is reset to false initially, then back to true after init
      expect(manager.isInitialized()).toBe(true);
    });

    it("returns false on failure", async () => {
      jest.spyOn(manager, "initialize").mockRejectedValue(new Error("Failed"));

      const result = await manager.repair();

      expect(result).toBe(false);
    });
  });

  describe("ensureDirectoryByKey", () => {
    it("throws for empty path", async () => {
      plugin.settings.emptyPath = "";
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;

      await expect(
        manager.ensureDirectoryByKey("emptyPath" as any)
      ).rejects.toThrow("No path configured");
    });

    it("throws for undefined path", async () => {
      delete plugin.settings.undefinedPath;
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;

      await expect(
        manager.ensureDirectoryByKey("undefinedPath" as any)
      ).rejects.toThrow("No path configured");
    });
  });

  describe("ensureDirectoryByPath", () => {
    it("throws for empty path", async () => {
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;

      await expect(manager.ensureDirectoryByPath("")).rejects.toThrow(
        "empty path"
      );
    });

    it("throws for whitespace-only path", async () => {
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;

      await expect(manager.ensureDirectoryByPath("   ")).rejects.toThrow(
        "empty path"
      );
    });
  });

  describe("handleDirectorySettingChange", () => {
    it("does nothing for empty path", async () => {
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;
      const createSpy = jest.spyOn(manager as any, "createDirectory");

      await manager.handleDirectorySettingChange("chatsDirectory", "");

      expect(createSpy).not.toHaveBeenCalled();
    });

    it("does nothing for whitespace-only path", async () => {
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;
      const createSpy = jest.spyOn(manager as any, "createDirectory");

      await manager.handleDirectorySettingChange("chatsDirectory", "   ");

      expect(createSpy).not.toHaveBeenCalled();
    });

    it("creates directory for valid path", async () => {
      jest.spyOn(manager, "initialize").mockResolvedValue(undefined);
      (manager as any).initialized = true;
      const createSpy = jest.spyOn(manager as any, "createDirectory").mockResolvedValue(undefined);

      await manager.handleDirectorySettingChange("chatsDirectory", "NewPath");

      expect(createSpy).toHaveBeenCalledWith("NewPath");
    });
  });

  describe("initialize", () => {
    it("sets initialized to true on completion", async () => {
      // Mock _initialize to succeed immediately
      jest.spyOn(manager as any, "_initialize").mockResolvedValue(undefined);

      await manager.initialize(1000);

      expect(manager.isInitialized()).toBe(true);
    });

    it("reuses initialization promise for concurrent calls", async () => {
      let resolveInit: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      jest.spyOn(manager as any, "_initialize").mockReturnValue(initPromise);

      // Start two initializations
      const promise1 = manager.initialize(10000);
      const promise2 = manager.initialize(10000);

      // They should reference the same underlying initialization
      resolveInit!();
      await promise1;
      await promise2;

      // _initialize should only be called once
      expect((manager as any)._initialize).toHaveBeenCalledTimes(1);
    });

    it("returns immediately if already initialized", async () => {
      (manager as any).initialized = true;

      await manager.initialize(1000);

      // Should not have called _initialize
      const spy = jest.spyOn(manager as any, "_initialize");
      await manager.initialize(1000);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("notifyDirectoriesReady (private)", () => {
    it("sets window global flag", () => {
      (manager as any).notifyDirectoriesReady();

      expect((window as any).__systemsculptDirectoriesReady).toBe(true);
    });

    it("emits event through plugin emitter", () => {
      (manager as any).notifyDirectoriesReady();

      expect(plugin.emitter.emit).toHaveBeenCalledWith("directory-structure-ready");
    });

    it("dispatches window event when emitter unavailable", () => {
      plugin.emitter = null;
      manager = new DirectoryManager(app, plugin);

      const dispatchSpy = jest.spyOn(window, "dispatchEvent");

      (manager as any).notifyDirectoriesReady();

      expect(dispatchSpy).toHaveBeenCalled();
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe("systemsculpt:directory-structure-ready");
      dispatchSpy.mockRestore();
    });

    it("only notifies once", () => {
      (manager as any).notifyDirectoriesReady();
      (manager as any).notifyDirectoriesReady();

      expect(plugin.emitter.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe("markDirectoryVerified (private)", () => {
    it("adds directory to verified set", () => {
      (manager as any).markDirectoryVerified("test/path");

      expect((manager as any).verifiedDirectories.has("test/path")).toBe(true);
    });

    it("does nothing if already verified", () => {
      (manager as any).verifiedDirectories.add("test/path");
      const scheduleSpy = jest.spyOn(manager as any, "scheduleVerifiedDirectoriesPersist");

      (manager as any).markDirectoryVerified("test/path");

      expect(scheduleSpy).not.toHaveBeenCalled();
    });
  });
});
