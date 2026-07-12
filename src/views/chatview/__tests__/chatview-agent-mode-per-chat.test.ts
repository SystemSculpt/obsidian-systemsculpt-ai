/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";

jest.mock("../../../core/ui/", () => ({ showPopup: jest.fn() }));
jest.mock("../../../utils/externalUrl", () => ({ openExternalUrl: jest.fn() }));
jest.mock("../uiSetup", () => ({
  uiSetup: {
    showLicenseBanner: jest.fn(),
    hideLicenseBanner: jest.fn(),
  },
}));

// Per-chat agent mode (#210 → #149/#185). Agent mode must be a per-chat decision
// that persists in the chat (mirroring the hideSystemMessages toggle), NOT a write
// to the global setting. isAgentModeActive() is the resolver the send path consults;
// toggleAgentMode() is the composer toggle's behavioral contract.
const makeView = (opts: { perChat?: boolean; global?: boolean }): any =>
  Object.assign(Object.create(ChatView.prototype), {
    agentModeEnabled: opts.perChat,
    plugin: {
      settings: { agentModeEnabled: opts.global },
      saveSettings: jest.fn(),
    },
    inputHandler: { syncAgentModeButton: jest.fn() },
    saveChat: jest.fn().mockResolvedValue(undefined),
  });

describe("ChatView per-chat agent mode (#210, #149, #185)", () => {
  it("isAgentModeActive uses the per-chat value when set", () => {
    expect(makeView({ perChat: false, global: true }).isAgentModeActive()).toBe(false);
    expect(makeView({ perChat: true, global: false }).isAgentModeActive()).toBe(true);
  });

  it("isAgentModeActive falls back to the global setting when no per-chat value is set", () => {
    expect(makeView({ perChat: undefined, global: false }).isAgentModeActive()).toBe(false);
    expect(makeView({ perChat: undefined, global: true }).isAgentModeActive()).toBe(true);
  });

  it("isAgentModeActive defaults to enabled when neither per-chat nor global is set", () => {
    expect(makeView({ perChat: undefined, global: undefined }).isAgentModeActive()).toBe(true);
  });

  it("toggleAgentMode flips the per-chat value WITHOUT mutating the global setting", () => {
    const view = makeView({ perChat: undefined, global: true });
    view.toggleAgentMode(); // active (true via global) -> false, recorded per-chat
    expect(view.agentModeEnabled).toBe(false);
    expect(view.plugin.settings.agentModeEnabled).toBe(true); // global default untouched
    expect(view.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("toggleAgentMode persists the chat and syncs the composer button", () => {
    const view = makeView({ perChat: false, global: false });
    view.toggleAgentMode(); // false -> true
    expect(view.agentModeEnabled).toBe(true);
    expect(view.saveChat).toHaveBeenCalledTimes(1);
    expect(view.inputHandler.syncAgentModeButton).toHaveBeenCalledTimes(1);
  });
});
