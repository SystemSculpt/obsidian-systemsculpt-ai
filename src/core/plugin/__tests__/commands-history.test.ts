/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

describe("CommandManager history commands", () => {
  it("registers new history command and legacy alias", () => {
    const app = new App();
    const addCommand = jest.fn();
    const plugin = { addCommand } as any;

    const manager = new CommandManager(plugin, app) as any;
    manager.registerOpenSystemSculptHistory();

    const registered = addCommand.mock.calls.map((call) => call[0]);
    const primary = registered.find((command: any) => command.id === "open-systemsculpt-history");
    const legacy = registered.find((command: any) => command.id === "open-chat-history");

    expect(primary).toEqual(
      expect.objectContaining({
        id: "open-systemsculpt-history",
        name: "Open history",
        callback: expect.any(Function),
      })
    );

    expect(legacy).toEqual(
      expect.objectContaining({
        id: "open-chat-history",
        name: "Open chat history (legacy alias)",
        callback: expect.any(Function),
      })
    );
  });
});
