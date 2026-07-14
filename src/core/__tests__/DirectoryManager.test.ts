/** @jest-environment jsdom */

import { App, TFile, TFolder } from "obsidian";
import { DirectoryManager } from "../DirectoryManager";

const settings = () => ({
  chatsDirectory: "SystemSculpt/Chats",
  savedChatsDirectory: "SystemSculpt/Saved Chats",
  recordingsDirectory: "SystemSculpt/Recordings",
  attachmentsDirectory: "SystemSculpt/Attachments",
  extractionsDirectory: "SystemSculpt/Extractions",
});

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
    manager = new DirectoryManager(app, plugin as never);
  });

  it("starts uninitialized and becomes ready only after every configured directory is created", async () => {
    expect(manager.isInitialized()).toBe(false);

    await manager.initialize();

    expect(manager.isInitialized()).toBe(true);
    expect(app.vault.createFolder).toHaveBeenCalledTimes(5);
    expect((app.vault.createFolder as jest.Mock).mock.calls.map(([path]) => path)).toEqual([
      "SystemSculpt/Chats",
      "SystemSculpt/Saved Chats",
      "SystemSculpt/Recordings",
      "SystemSculpt/Attachments",
      "SystemSculpt/Extractions",
    ]);
  });

  it("shares one in-flight initialization and does not repeat successful work", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    (app.vault.createFolder as jest.Mock).mockImplementation(() => pending);

    const first = manager.initialize();
    const second = manager.initialize();

    expect(second).toBe(first);
    expect(app.vault.createFolder).toHaveBeenCalledTimes(5);
    release();
    await first;
    await manager.initialize();
    expect(app.vault.createFolder).toHaveBeenCalledTimes(5);
  });

  it("propagates initialization failures and never reports fake readiness", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("vault unavailable"));

    await expect(manager.initialize()).rejects.toThrow("vault unavailable");

    expect(manager.isInitialized()).toBe(false);
  });

  it("normalizes and deduplicates configured paths while skipping existing folders", async () => {
    plugin.settings.chatsDirectory = "  SystemSculpt//Shared/ ";
    plugin.settings.savedChatsDirectory = "SystemSculpt/Shared";
    plugin.settings.recordingsDirectory = "";
    plugin.settings.attachmentsDirectory = "";
    plugin.settings.extractionsDirectory = "";
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(
      new TFolder({ path: "SystemSculpt/Shared" }),
    );

    await manager.initialize();

    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith("SystemSculpt/Shared");
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it("ensures an explicit path directly without initializing unrelated directories", async () => {
    await manager.ensureDirectoryByPath("  Projects//Alpha/ ");

    expect(manager.isInitialized()).toBe(false);
    expect(app.vault.createFolder).toHaveBeenCalledWith("Projects/Alpha");
    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
  });

  it("accepts an already-created concurrent folder race", async () => {
    const folder = new TFolder({ path: "Projects/Alpha" });
    (app.vault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(folder);
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("already exists"));

    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).resolves.toBeUndefined();
  });

  it("propagates real create failures and file collisions", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValueOnce(new Error("permission denied"));
    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).rejects.toThrow("permission denied");

    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(
      new TFile({ path: "Projects/Alpha", extension: "" }),
    );
    await expect(manager.ensureDirectoryByPath("Projects/Alpha")).rejects.toThrow("a file already exists");
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
  });

  it("creates non-empty directory-setting changes and ignores cleared values", async () => {
    await manager.handleDirectorySettingChange("recordingsDirectory", "");
    expect(app.vault.createFolder).not.toHaveBeenCalled();

    await manager.handleDirectorySettingChange("recordingsDirectory", "Media/Recordings");
    expect(app.vault.createFolder).toHaveBeenCalledWith("Media/Recordings");
  });

  it("reports configured folders from Obsidian's vault state", async () => {
    const missing = "SystemSculpt/Attachments";
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => (
      path === missing ? null : new TFolder({ path })
    ));

    await expect(manager.verifyDirectories()).resolves.toEqual({
      valid: false,
      issues: [`Directory "${missing}" does not exist or is not accessible`],
    });

    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
      (path: string) => new TFolder({ path }),
    );
    await expect(manager.verifyDirectories()).resolves.toEqual({ valid: true, issues: [] });
  });

  it("repairs through the same direct initialization path and returns false on failure", async () => {
    await expect(manager.repair()).resolves.toBe(true);
    expect(manager.isInitialized()).toBe(true);

    const failing = new DirectoryManager(app, plugin as never);
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("read only"));
    await expect(failing.repair()).resolves.toBe(false);
    expect(failing.isInitialized()).toBe(false);
  });
});
