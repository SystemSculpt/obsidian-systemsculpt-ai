/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { CommandManager } from "../commands";
import { tryCopyToClipboard } from "../../../utils/clipboard";

jest.mock("../../../utils/clipboard", () => ({
  tryCopyToClipboard: jest.fn(),
}));

describe("CommandManager copy-systemsculpt-studio-file-path command", () => {
  const mockedTryCopyToClipboard = tryCopyToClipboard as jest.MockedFunction<typeof tryCopyToClipboard>;

  beforeEach(() => {
    mockedTryCopyToClipboard.mockReset();
  });

  function registerCopyStudioPathCommand(options?: {
    activeFile?: TFile | null;
    activeStudioStateFile?: string | null;
    getFullPath?: (vaultPath: string) => string;
    basePath?: string;
  }) {
    const app = new App();
    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(options?.activeFile ?? null);
    if (options?.activeStudioStateFile) {
      (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({
        getState: () => ({ file: options.activeStudioStateFile }),
      });
    }

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
      .find((command) => command.id === "copy-systemsculpt-studio-file-path");

    return { copyCommand };
  }

  it("registers copy-systemsculpt-studio-file-path with Mod+Shift+C", () => {
    const { copyCommand } = registerCopyStudioPathCommand();

    expect(copyCommand).toEqual(
      expect.objectContaining({
        id: "copy-systemsculpt-studio-file-path",
        name: "Copy Current SystemSculpt Studio File Path",
        checkCallback: expect.any(Function),
        hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
      })
    );
  });

  it("copies the active studio file absolute path and shows a success notice", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedTryCopyToClipboard.mockResolvedValue(true);

    const { copyCommand } = registerCopyStudioPathCommand({
      activeFile: new TFile({ path: "SystemSculpt/Studio/Test.systemsculpt", extension: "systemsculpt" }),
      getFullPath: (vaultPath) => `/vault/${vaultPath}`,
    });

    expect(copyCommand.checkCallback(true)).toBe(true);
    expect(mockedTryCopyToClipboard).not.toHaveBeenCalled();

    expect(copyCommand.checkCallback(false)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTryCopyToClipboard).toHaveBeenCalledWith("/vault/SystemSculpt/Studio/Test.systemsculpt");
    expect(consoleLogSpy).toHaveBeenCalledWith("Notice: Studio file path copied to clipboard.");
  });

  it("copies path when Studio view is active even if getActiveFile() is null", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedTryCopyToClipboard.mockResolvedValue(true);

    const { copyCommand } = registerCopyStudioPathCommand({
      activeFile: null,
      activeStudioStateFile: "SystemSculpt/Studio/Graph.systemsculpt",
      getFullPath: (vaultPath) => `/vault/${vaultPath}`,
    });

    expect(copyCommand.checkCallback(true)).toBe(true);
    expect(copyCommand.checkCallback(false)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTryCopyToClipboard).toHaveBeenCalledWith("/vault/SystemSculpt/Studio/Graph.systemsculpt");
    expect(consoleLogSpy).toHaveBeenCalledWith("Notice: Studio file path copied to clipboard.");
  });

  it("is unavailable when no current studio file can be resolved", () => {
    const { copyCommand } = registerCopyStudioPathCommand({
      activeFile: null,
    });

    expect(copyCommand.checkCallback(true)).toBe(false);
  });
});
