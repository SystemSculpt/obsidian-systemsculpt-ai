/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

describe("CommandManager SystemSculpt-only chat contract", () => {
  it("does not register legacy model, template, or daily-note commands", () => {
    const addCommand = jest.fn();
    const plugin = {
      addCommand,
      settings: {},
      getLogger: jest.fn(() => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      })),
    } as any;

    const manager = new CommandManager(plugin, new App());
    manager.registerCommands();

    const registeredIds = addCommand.mock.calls.map((call) => call[0]?.id);

    expect(registeredIds).toContain("open-systemsculpt-chat");
    expect(registeredIds).not.toContain("change-chat-model");
    expect(registeredIds).not.toContain("set-default-chat-model");
    expect(registeredIds).not.toContain("open-template-modal");
    expect(registeredIds).not.toContain("daily-vault-open-today");
    expect(registeredIds).not.toContain("daily-vault-create-note");
    expect(registeredIds).not.toContain("daily-vault-open-settings");
  });
});
