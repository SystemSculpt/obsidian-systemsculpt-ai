/** @jest-environment jsdom */

import { App, TFile, WorkspaceLeaf } from "obsidian";
import { CommandManager } from "../commands";
import { tryCopyToClipboard } from "../../../utils/clipboard";

jest.mock("../../../utils/clipboard", () => ({
  tryCopyToClipboard: jest.fn(),
}));

describe("CommandManager copy-current-file-path command", () => {
  const mockedTryCopyToClipboard = tryCopyToClipboard as jest.MockedFunction<typeof tryCopyToClipboard>;

  beforeEach(() => {
    mockedTryCopyToClipboard.mockReset();
  });

  function registerCopyPathCommand(options?: {
    activeFile?: TFile | null;
    activeLeafViewFile?: string | null;
    activeLeafStateFile?: string | null;
    activeChatViewFile?: string | null;
    knownVaultFiles?: string[];
    getFullPath?: (vaultPath: string) => string;
    basePath?: string;
  }) {
    const app = new App();
    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(options?.activeFile ?? null);
    (app.workspace.getActiveViewOfType as jest.Mock).mockImplementation((viewType: unknown) => {
      const viewName =
        typeof viewType === "function" && typeof viewType.name === "string"
          ? viewType.name
          : String(viewType);
      if (options?.activeChatViewFile && viewName.includes("ChatView")) {
        return {
          getChatHistoryFilePath: jest.fn(() => options.activeChatViewFile),
        };
      }
      return null;
    });

    if (options?.activeLeafViewFile || options?.activeLeafStateFile) {
      const activeLeaf = new WorkspaceLeaf(app);
      if (options.activeLeafViewFile) {
        (activeLeaf as any).view = {
          file: new TFile({
            path: options.activeLeafViewFile,
            extension: options.activeLeafViewFile.split(".").pop() || "",
          }),
        };
      }
      if (options.activeLeafStateFile) {
        (activeLeaf as any)._viewState = {
          type: "custom-view",
          state: { file: options.activeLeafStateFile },
        };
      }
      (app.workspace as any).activeLeaf = activeLeaf;
    }

    const hasExplicitKnownVaultFiles = Array.isArray(options?.knownVaultFiles);
    const knownVaultFiles = new Set<string>(options?.knownVaultFiles ?? []);
    if (!hasExplicitKnownVaultFiles) {
      if (options?.activeFile?.path) {
        knownVaultFiles.add(options.activeFile.path);
      }
      if (options?.activeLeafViewFile) {
        knownVaultFiles.add(options.activeLeafViewFile);
      }
      if (options?.activeLeafStateFile) {
        knownVaultFiles.add(options.activeLeafStateFile);
      }
      if (options?.activeChatViewFile) {
        knownVaultFiles.add(options.activeChatViewFile);
      }
    }
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) =>
      knownVaultFiles.has(path) ? new TFile({ path, extension: path.split(".").pop() || "" }) : null
    );

    if (options?.getFullPath) {
      (app.vault.adapter as any).getFullPath = jest.fn(options.getFullPath);
    }
    if (options?.basePath) {
      (app.vault.adapter as any).basePath = options.basePath;
    }

    const addCommand = jest.fn();
    const plugin = {
      addCommand,
    } as any;

    const manager = new CommandManager(plugin, app);
    (manager as any).registerSystemSculptStudioCommands();

    const copyCommand = addCommand.mock.calls
      .map((entry) => entry[0])
      .find((command) => command.id === "copy-current-file-path");

    return { copyCommand };
  }

  it("registers copy-current-file-path with Mod+Shift+C", () => {
    const { copyCommand } = registerCopyPathCommand();

    expect(copyCommand).toEqual(
      expect.objectContaining({
        id: "copy-current-file-path",
        name: "Copy Current File Path",
        checkCallback: expect.any(Function),
        hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
      })
    );
  });

  it("copies the active file absolute path and shows a success notice", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedTryCopyToClipboard.mockResolvedValue(true);

    const { copyCommand } = registerCopyPathCommand({
      activeFile: new TFile({ path: "Notes/Inbox.md", extension: "md" }),
      getFullPath: (vaultPath) => `/vault/${vaultPath}`,
    });

    expect(copyCommand.checkCallback(true)).toBe(true);
    expect(mockedTryCopyToClipboard).not.toHaveBeenCalled();

    expect(copyCommand.checkCallback(false)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTryCopyToClipboard).toHaveBeenCalledWith("/vault/Notes/Inbox.md");
    expect(consoleLogSpy).toHaveBeenCalledWith("Notice: File path copied to clipboard.");
    consoleLogSpy.mockRestore();
  });

  it("copies path from active leaf view.file when getActiveFile() is null", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedTryCopyToClipboard.mockResolvedValue(true);

    const { copyCommand } = registerCopyPathCommand({
      activeFile: null,
      activeLeafViewFile: "SystemSculpt/Canvas/Map.canvas",
      getFullPath: (vaultPath) => `/vault/${vaultPath}`,
    });

    expect(copyCommand.checkCallback(true)).toBe(true);
    expect(copyCommand.checkCallback(false)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTryCopyToClipboard).toHaveBeenCalledWith("/vault/SystemSculpt/Canvas/Map.canvas");
    expect(consoleLogSpy).toHaveBeenCalledWith("Notice: File path copied to clipboard.");
    consoleLogSpy.mockRestore();
  });

  it("copies path from active leaf state.file when getActiveFile() is null", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedTryCopyToClipboard.mockResolvedValue(true);

    const { copyCommand } = registerCopyPathCommand({
      activeFile: null,
      activeLeafStateFile: "Research/Papers/SystemSculpt.pdf",
      getFullPath: (vaultPath) => `/vault/${vaultPath}`,
    });

    expect(copyCommand.checkCallback(true)).toBe(true);
    expect(copyCommand.checkCallback(false)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTryCopyToClipboard).toHaveBeenCalledWith("/vault/Research/Papers/SystemSculpt.pdf");
    expect(consoleLogSpy).toHaveBeenCalledWith("Notice: File path copied to clipboard.");
    consoleLogSpy.mockRestore();
  });

  it("copies path from the active chat view history file when the chat view is focused", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedTryCopyToClipboard.mockResolvedValue(true);

    const { copyCommand } = registerCopyPathCommand({
      activeFile: null,
      activeChatViewFile: "SystemSculpt/Chats/2026-03-06 12-42-10.md",
      getFullPath: (vaultPath) => `/vault/${vaultPath}`,
    });

    expect(copyCommand.checkCallback(true)).toBe(true);
    expect(copyCommand.checkCallback(false)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTryCopyToClipboard).toHaveBeenCalledWith("/vault/SystemSculpt/Chats/2026-03-06 12-42-10.md");
    expect(consoleLogSpy).toHaveBeenCalledWith("Notice: File path copied to clipboard.");
    consoleLogSpy.mockRestore();
  });

  it("is unavailable when no current file can be resolved", () => {
    const { copyCommand } = registerCopyPathCommand({ activeFile: null });
    expect(copyCommand.checkCallback(true)).toBe(false);
  });

  it("is unavailable when active leaf references a non-file path", () => {
    const { copyCommand } = registerCopyPathCommand({
      activeFile: null,
      activeLeafStateFile: "SystemSculpt/DoesNotExist.base",
      knownVaultFiles: [],
    });

    expect(copyCommand.checkCallback(true)).toBe(false);
  });
});
