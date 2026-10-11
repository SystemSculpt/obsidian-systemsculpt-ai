/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

describe("account commands", () => {
  it("starts sign-in from the command palette with Account settings open", () => {
    const commands = new Map<string, { callback: () => void }>();
    const begin = jest.fn().mockResolvedValue(true);
    const plugin = {
      addCommand: (command: { id: string; callback: () => void }) => commands.set(command.id, command),
      openSettingsTab: jest.fn(),
      getAccountConnectService: () => ({ begin }),
    };
    const manager = new CommandManager(plugin as any, new App());
    (manager as any).registerAccountCommands();
    commands.get("sign-in")!.callback();
    expect(plugin.openSettingsTab).toHaveBeenCalledWith("account");
    expect(begin).toHaveBeenCalledWith("sign-in", expect.anything());
    expect(commands.has("view-plans")).toBe(true);
  });
});
