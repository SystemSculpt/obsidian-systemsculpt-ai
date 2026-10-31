/** @jest-environment jsdom */

import { App, TFile, TFolder } from "obsidian";
import { DirectoryManager } from "../DirectoryManager";

// The two retired keys hold the values an older version saved.
const settings = () => ({
  chatsDirectory: "SystemSculpt/Chats",
  savedChatsDirectory: "SystemSculpt/Saved Chats",
  recordingsDirectory: "SystemSculpt/Recordings",
  attachmentsDirectory: "SystemSculpt/Attachments",
  extractionsDirectory: "SystemSculpt/Extractions",
});

const directorySettingKeys = [
  "chatsDirectory",
  "recordingsDirectory",
  "extractionsDirectory",
] as const;

describe("DirectoryManager", () => {
  let app: App;
  let plugin: { settings: ReturnType<typeof settings> };
  let manager: DirectoryManager;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    plugin = { settings: settings() };
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.createFolder as jest.Mock).mockResolvedValue(undefined);
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue(null);
    manager = new DirectoryManager(app, plugin as never);
  });

  it("initializes repeatedly without inspecting or creating any output directories", async () => {
    expect(manager.isInitialized()).toBe(false);
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("vault unavailable"));

    await Promise.all([manager.initialize(), manager.initialize()]);
    await manager.initialize();

    expect(manager.isInitialized()).toBe(true);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(app.vault.adapter.exists).not.toHaveBeenCalled();
    expect(app.vault.adapter.stat).not.toHaveBeenCalled();
  });

  it.each(directorySettingKeys)("defers %s setting changes until a writer ensures the current path", async (key) => {
    await manager.initialize();
    for (const value of ["", "  ", "Unused/Output", "  Current//Output/ "]) {
      // The settings manager persists the value before notifying DirectoryManager.
      plugin.settings[key] = value;
      await manager.handleDirectorySettingChange(key, value);
    }

    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(app.vault.adapter.exists).not.toHaveBeenCalled();
    expect(app.vault.adapter.stat).not.toHaveBeenCalled();

    await expect(manager.ensureDirectoryByKey(key)).resolves.toBe("Current/Output");
    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
    expect(app.vault.createFolder).toHaveBeenCalledWith("Current/Output");
  });

  it("never creates, checks or repairs the retired saved-chats and attachments folders", async () => {
    await manager.initialize();
    await expect(manager.repair()).resolves.toBe(true);
    await expect(manager.verifyDirectories()).resolves.toEqual({ valid: true, issues: [] });

    const touched = [
      ...(app.vault.createFolder as jest.Mock).mock.calls,
      ...(app.vault.getAbstractFileByPath as jest.Mock).mock.calls,
      ...(app.vault.adapter.exists as jest.Mock).mock.calls,
      ...(app.vault.adapter.stat as jest.Mock).mock.calls,
    ].map(([path]) => path);
    expect(touched).not.toContain("SystemSculpt/Saved Chats");
    expect(touched).not.toContain("SystemSculpt/Attachments");
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it("normalizes and deduplicates configured paths while skipping cleared settings", async () => {
    plugin.settings.chatsDirectory = "  SystemSculpt//Shared/ ";
    plugin.settings.recordingsDirectory = "SystemSculpt/Shared";
    plugin.settings.extractionsDirectory = "  ";
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(
      new TFolder({ path: "SystemSculpt/Shared" }),
    );

    await expect(manager.verifyDirectories()).resolves.toEqual({ valid: true, issues: [] });

    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledTimes(1);
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith("SystemSculpt/Shared");
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it("ensures an explicit path directly without initializing unrelated directories", async () => {
    await manager.ensureDirectoryByPath("  Projects//Alpha/ ");

    expect(manager.isInitialized()).toBe(false);
    expect(app.vault.createFolder).toHaveBeenCalledWith("Projects/Alpha");
    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
  });

  it("ensures only the requested configured directory after initialization", async () => {
    await manager.initialize();
    await expect(manager.ensureDirectoryByKey("recordingsDirectory")).resolves.toBe("SystemSculpt/Recordings");

    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
    expect(app.vault.createFolder).toHaveBeenCalledWith("SystemSculpt/Recordings");
  });

  it("does not recreate an existing indexed output folder", async () => {
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(
      new TFolder({ path: "SystemSculpt/Chats" }),
    );

    await expect(manager.ensureDirectoryByKey("chatsDirectory")).resolves.toBe("SystemSculpt/Chats");
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it("accepts an already-created concurrent folder race", async () => {
    const folder = new TFolder({ path: "Projects/Alpha" });
    (app.vault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(folder);
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("already exists"));

    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).resolves.toBeUndefined();
  });

  it("ensures folders that exist on disk before the vault tree resolves them (#326)", async () => {
    // Obsidian rejects createFolder for any path already on disk, even while
    // getAbstractFileByPath still returns null during onload.
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("Folder already exists."));
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "folder", ctime: 0, mtime: 0, size: 0 });

    await manager.initialize();
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    await expect(manager.ensureDirectoryByKey("chatsDirectory")).resolves.toBe("SystemSculpt/Chats");

    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
    expect(app.vault.adapter.stat).toHaveBeenCalledWith("SystemSculpt/Chats");
  });

  it("still rejects an already-exists error when the disk entry is a file", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("Folder already exists."));
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "file", ctime: 0, mtime: 0, size: 3 });

    await expect(manager.ensureDirectoryByKey("chatsDirectory")).rejects.toThrow("Folder already exists.");
  });

  it("does not swallow an already-exists error when no folder can be confirmed", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("Folder already exists."));

    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).rejects.toThrow("Folder already exists.");
  });

  it("propagates real create failures and indexed file collisions", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValueOnce(new Error("permission denied"));
    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).rejects.toThrow("permission denied");

    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(
      new TFile({ path: "Projects/Alpha", extension: "" }),
    );
    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).rejects.toThrow("a file already exists");
    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
  });

  it("ensures configured keys and rejects empty paths", async () => {
    plugin.settings.extractionsDirectory = " Output//Extracted/ ";
    await expect(manager.ensureDirectoryByKey("extractionsDirectory")).resolves.toBe("Output/Extracted");
    expect(app.vault.createFolder).toHaveBeenCalledWith("Output/Extracted");

    plugin.settings.extractionsDirectory = "";
    await expect(manager.ensureDirectoryByKey("extractionsDirectory")).rejects.toThrow(
      "No path configured for: extractionsDirectory",
    );
    await expect(manager.ensureDirectoryByPath(" / ")).rejects.toThrow("empty path");
    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
  });

  it("considers missing unused output paths valid without creating them during verify or repair", async () => {
    await expect(manager.verifyDirectories()).resolves.toEqual({ valid: true, issues: [] });
    await expect(manager.repair()).resolves.toBe(true);

    expect(manager.isInitialized()).toBe(true);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.vault.adapter.stat).not.toHaveBeenCalled();
  });

  it("accepts missing outputs underneath existing folders", async () => {
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => (
      path === "SystemSculpt" ? new TFolder({ path }) : null
    ));

    await expect(manager.verifyDirectories()).resolves.toEqual({ valid: true, issues: [] });
    await expect(manager.repair()).resolves.toBe(true);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it("reports an indexed file conflict and does not overwrite it during repair", async () => {
    const conflict = "SystemSculpt/Recordings";
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => (
      path === conflict ? new TFile({ path, extension: "" }) : null
    ));

    await expect(manager.verifyDirectories()).resolves.toEqual({
      valid: false,
      issues: [`Directory "${conflict}" is blocked by a file at "${conflict}"`],
    });
    await expect(manager.repair()).resolves.toBe(false);
    expect(manager.isInitialized()).toBe(false);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("reports folders the adapter confirms on disk as healthy, and a file as an issue", async () => {
    // Ensuring a write accepts these folders, so Verify must not flag them (#416).
    const onDisk = new Set(["SystemSculpt/Chats", "SystemSculpt/Recordings"]);
    (app.vault.adapter.exists as jest.Mock).mockImplementation(async (path: string) =>
      onDisk.has(path) || path === "SystemSculpt/Extractions");
    (app.vault.adapter.stat as jest.Mock).mockImplementation(async (path: string) => ({
      type: onDisk.has(path) ? "folder" : "file", ctime: 0, mtime: 0, size: 0,
    }));

    await expect(manager.verifyDirectories()).resolves.toEqual({
      valid: false,
      issues: ['Directory "SystemSculpt/Extractions" is blocked by a file at "SystemSculpt/Extractions"'],
    });
    await expect(manager.repair()).resolves.toBe(false);

    onDisk.add("SystemSculpt/Extractions");
    await expect(manager.verifyDirectories()).resolves.toEqual({ valid: true, issues: [] });
    await expect(manager.repair()).resolves.toBe(true);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it.each(["indexed", "on disk"])("reports a file ancestor %s even when the output path is missing", async (location) => {
    plugin.settings.chatsDirectory = "Blocked/Nested/Chats";
    plugin.settings.recordingsDirectory = "";
    plugin.settings.extractionsDirectory = "";
    if (location === "indexed") {
      (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => (
        path === "Blocked" ? new TFile({ path, extension: "" }) : null
      ));
    } else {
      (app.vault.adapter.exists as jest.Mock).mockImplementation(async (path: string) => path === "Blocked");
      (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "file", ctime: 0, mtime: 0, size: 3 });
    }

    await expect(manager.verifyDirectories()).resolves.toEqual({
      valid: false,
      issues: ['Directory "Blocked/Nested/Chats" is blocked by a file at "Blocked"'],
    });
    await expect(manager.repair()).resolves.toBe(false);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it.each(["exists failure", "stat failure", "missing stat"])("does not mistake %s for a valid missing directory", async (failure) => {
    plugin.settings.recordingsDirectory = "";
    plugin.settings.extractionsDirectory = "";
    if (failure === "exists failure") {
      (app.vault.adapter.exists as jest.Mock).mockRejectedValue(new Error("permission denied"));
    } else {
      (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      if (failure === "stat failure") {
        (app.vault.adapter.stat as jest.Mock).mockRejectedValue(new Error("permission denied"));
      }
    }

    await expect(manager.verifyDirectories()).resolves.toEqual({
      valid: false,
      issues: ['Directory "SystemSculpt/Chats" is not accessible at "SystemSculpt/Chats"'],
    });
    await expect(manager.repair()).resolves.toBe(false);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });
});
