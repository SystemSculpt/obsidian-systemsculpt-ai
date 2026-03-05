/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

describe("CommandManager studio fit-selection command", () => {
  function registerFitSelectionCommand(activeStudioView: unknown = null) {
    const app = new App();
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(activeStudioView);

    const addCommand = jest.fn();
    const plugin = {
      addCommand,
    } as any;

    const manager = new CommandManager(plugin, app);
    (manager as any).registerSystemSculptStudioCommands();

    const fitCommand = addCommand.mock.calls
      .map((entry) => entry[0])
      .find((command) => command.id === "fit-systemsculpt-studio-selection-in-viewport");

    return { fitCommand };
  }

  it("registers fit-selection with Mod+Shift+1", () => {
    const { fitCommand } = registerFitSelectionCommand();

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
    const { fitCommand } = registerFitSelectionCommand({
      fitSelectionInViewportFromCommand,
    });

    expect(fitCommand.checkCallback(true)).toBe(true);
    expect(fitSelectionInViewportFromCommand).not.toHaveBeenCalled();

    expect(fitCommand.checkCallback(false)).toBe(true);
    expect(fitSelectionInViewportFromCommand).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when no studio view is active", () => {
    const { fitCommand } = registerFitSelectionCommand(null);
    expect(fitCommand.checkCallback(true)).toBe(false);
  });
});
