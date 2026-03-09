/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

describe("CommandManager studio fit-selection command", () => {
  function registerStudioViewportCommands(activeStudioView: unknown = null) {
    const app = new App();
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(activeStudioView);

    const addCommand = jest.fn();
    const plugin = {
      addCommand,
    } as any;

    const manager = new CommandManager(plugin, app);
    (manager as any).registerSystemSculptStudioCommands();

    const commands = addCommand.mock.calls
      .map((entry) => entry[0])
      .filter((command) =>
        [
          "fit-systemsculpt-studio-selection-in-viewport",
          "overview-systemsculpt-studio-graph-in-viewport",
        ].includes(command.id)
      );

    const fitCommand = commands.find(
      (command) => command.id === "fit-systemsculpt-studio-selection-in-viewport"
    );
    const overviewCommand = commands.find(
      (command) => command.id === "overview-systemsculpt-studio-graph-in-viewport"
    );

    return { fitCommand, overviewCommand };
  }

  it("registers fit-selection with Mod+Shift+1", () => {
    const { fitCommand } = registerStudioViewportCommands();

    expect(fitCommand).toEqual(
      expect.objectContaining({
        id: "fit-systemsculpt-studio-selection-in-viewport",
        name: "SystemSculpt Studio: Fit Selection in Viewport",
        checkCallback: expect.any(Function),
        hotkeys: [{ modifiers: ["Mod", "Shift"], key: "1" }],
      })
    );
  });

  it("runs fit-selection on the active studio view", () => {
    const fitSelectionInViewportFromCommand = jest.fn();
    const { fitCommand } = registerStudioViewportCommands({
      fitSelectionInViewportFromCommand,
    });

    expect(fitCommand.checkCallback(true)).toBe(true);
    expect(fitSelectionInViewportFromCommand).not.toHaveBeenCalled();

    expect(fitCommand.checkCallback(false)).toBe(true);
    expect(fitSelectionInViewportFromCommand).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when no studio view is active", () => {
    const { fitCommand } = registerStudioViewportCommands(null);
    expect(fitCommand.checkCallback(true)).toBe(false);
  });

  it("runs overview on the active studio view", () => {
    const showGraphOverviewFromCommand = jest.fn();
    const { overviewCommand } = registerStudioViewportCommands({
      showGraphOverviewFromCommand,
    });

    expect(overviewCommand.checkCallback(true)).toBe(true);
    expect(showGraphOverviewFromCommand).not.toHaveBeenCalled();

    expect(overviewCommand.checkCallback(false)).toBe(true);
    expect(showGraphOverviewFromCommand).toHaveBeenCalledTimes(1);
  });
});
