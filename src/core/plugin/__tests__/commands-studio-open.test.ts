/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { CommandManager } from "../commands";

jest.mock("../../../services/PlatformContext", () => ({
  PlatformContext: {
    get: () => ({
      supportsDesktopOnlyFeatures: () => true,
    }),
  },
}));

describe("CommandManager open-systemsculpt-studio command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function registerStudioOpenCommand(options?: {
    activeFile?: TFile | null;
    vaultFiles?: TFile[];
    projectName?: string;
    projectPath?: string | null;
  }) {
    const app = new App();
    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(options?.activeFile ?? null);
    (app.vault.getFiles as jest.Mock).mockReturnValue(options?.vaultFiles ?? []);

    const activateSystemSculptStudioView = jest.fn().mockResolvedValue(undefined);
    const createProject = jest.fn().mockResolvedValue({
      name: options?.projectName ?? "Untitled Studio",
    });
    const getCurrentProjectPath = jest
      .fn()
      .mockReturnValue(options?.projectPath ?? "SystemSculpt/Studio/Untitled Studio.systemsculpt");

    const addCommand = jest.fn();
    const plugin = {
      addCommand,
      getStudioService: jest.fn(() => ({
        createProject,
        getCurrentProjectPath,
      })),
      getViewManager: jest.fn(() => ({
        activateSystemSculptStudioView,
      })),
    } as any;

    const manager = new CommandManager(plugin, app);
    (manager as any).registerSystemSculptStudioCommands();

    const openCommand = addCommand.mock.calls
      .map((entry) => entry[0])
      .find((command) => command.id === "open-systemsculpt-studio");

    return {
      openCommand,
      createProject,
      getCurrentProjectPath,
      activateSystemSculptStudioView,
    };
  }

  it("opens the active Studio file when one is already focused", async () => {
    const activeFile = new TFile({
      path: "Projects/Current.systemsculpt",
      extension: "systemsculpt",
    });
    const { openCommand, createProject, activateSystemSculptStudioView } =
      registerStudioOpenCommand({ activeFile });

    await openCommand.callback();

    expect(createProject).not.toHaveBeenCalled();
    expect(activateSystemSculptStudioView).toHaveBeenCalledWith(activeFile.path);
  });

  it("creates and opens a Studio project when none exists yet", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const {
      openCommand,
      createProject,
      getCurrentProjectPath,
      activateSystemSculptStudioView,
    } = registerStudioOpenCommand({
      activeFile: null,
      vaultFiles: [],
      projectName: "Fresh Studio",
      projectPath: "SystemSculpt/Studio/Fresh Studio.systemsculpt",
    });

    await openCommand.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(getCurrentProjectPath).toHaveBeenCalledTimes(1);
    expect(activateSystemSculptStudioView).toHaveBeenCalledWith(
      "SystemSculpt/Studio/Fresh Studio.systemsculpt"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "Notice: No Studio project found. Created and opened: Fresh Studio"
    );
    consoleLogSpy.mockRestore();
  });
});
