/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { CommandManager } from "../commands";

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
    const createProjectFile = jest.fn().mockResolvedValue({
      path: options?.projectPath ?? "SystemSculpt/Studio/Untitled Studio.systemsculpt",
      project: {
        name: options?.projectName ?? "Untitled Studio",
      },
    });

    const addCommand = jest.fn();
    const plugin = {
      addCommand,
      getStudioService: jest.fn(() => ({
        createProjectFile,
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
      createProjectFile,
      activateSystemSculptStudioView,
    };
  }

  it("opens the active Studio file when one is already focused", async () => {
    const activeFile = new TFile({
      path: "Projects/Current.systemsculpt",
      extension: "systemsculpt",
    });
    const { openCommand, createProjectFile, activateSystemSculptStudioView } =
      registerStudioOpenCommand({ activeFile });

    await openCommand.callback();

    expect(createProjectFile).not.toHaveBeenCalled();
    expect(activateSystemSculptStudioView).toHaveBeenCalledWith(activeFile.path);
  });

  it("creates and opens a Studio project when none exists yet", async () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const {
      openCommand,
      createProjectFile,
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

    expect(createProjectFile).toHaveBeenCalledTimes(1);
    expect(activateSystemSculptStudioView).toHaveBeenCalledWith(
      "SystemSculpt/Studio/Fresh Studio.systemsculpt"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "Notice: Created Studio project: Fresh Studio"
    );
    consoleLogSpy.mockRestore();
  });
});
