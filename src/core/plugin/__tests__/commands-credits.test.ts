/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

describe("CommandManager credits command", () => {
  it("registers a command that opens credits modal", async () => {
    const addCommand = jest.fn();
    const openCreditsBalanceModal = jest.fn().mockResolvedValue(undefined);

    const plugin = {
      addCommand,
      openCreditsBalanceModal,
    } as any;

    const manager = new CommandManager(plugin, new App());
    (manager as any).registerOpenCreditsBalance();

    expect(addCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: "open-credits-balance",
      name: "Open Credits & Usage",
      callback: expect.any(Function),
    }));

    const registered = addCommand.mock.calls[0]?.[0];
    await registered.callback();

    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });
});
