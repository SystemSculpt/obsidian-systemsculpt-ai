/**
 * @jest-environment jsdom
 */

import { InputHandler } from "../InputHandler";

// A chat that follows the global default (per-chat toggle unset) must refresh
// its composer toggle buttons when the global settings change — otherwise the
// button shows a stale active state until the next toggle or chat reload. The
// workspace "systemsculpt:settings-updated" listener delegates to
// handleSettingsUpdated(); this guards that it re-syncs BOTH global-fallback
// toggles (agent mode #210/#149/#185, hide-system #213/#174/#167) in addition
// to the generating-state UI and model options.
const makeHandler = (): any =>
  Object.assign(Object.create(InputHandler.prototype), {
    updateGeneratingState: jest.fn(),
    onModelChange: jest.fn(),
    syncAgentModeButton: jest.fn(),
    syncHideSystemMessagesButton: jest.fn(),
  });

describe("InputHandler.handleSettingsUpdated (#210, #213)", () => {
  it("re-syncs both per-chat toggle buttons on a global settings change", () => {
    const handler = makeHandler();
    handler.handleSettingsUpdated();
    expect(handler.syncAgentModeButton).toHaveBeenCalledTimes(1);
    expect(handler.syncHideSystemMessagesButton).toHaveBeenCalledTimes(1);
  });

  it("still refreshes generating state and model options", () => {
    const handler = makeHandler();
    handler.handleSettingsUpdated();
    expect(handler.updateGeneratingState).toHaveBeenCalledTimes(1);
    expect(handler.onModelChange).toHaveBeenCalledWith({ refreshOptions: true });
  });
});
