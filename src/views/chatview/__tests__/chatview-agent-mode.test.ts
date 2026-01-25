/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";

describe("ChatView.setAgentMode", () => {
  it("updates state and triggers persistence + UI updates", async () => {
    const updateViewState = jest.fn();
    const saveChat = jest.fn().mockResolvedValue(undefined);
    const updateAgentModeIndicator = jest.fn().mockResolvedValue(undefined);
    const updateSystemPromptIndicator = jest.fn().mockResolvedValue(undefined);
    const updateToolCompatibilityWarning = jest.fn().mockResolvedValue(undefined);
    const displayChatStatus = jest.fn();
    const notifySettingsChanged = jest.fn();

    const ctx = {
      agentMode: true,
      messages: [],
      updateViewState,
      saveChat,
      updateAgentModeIndicator,
      updateSystemPromptIndicator,
      updateToolCompatibilityWarning,
      displayChatStatus,
      notifySettingsChanged,
    } as any;

    await ChatView.prototype.setAgentMode.call(ctx, false, { showNotice: false });

    expect(ctx.agentMode).toBe(false);
    expect(updateViewState).toHaveBeenCalled();
    expect(saveChat).toHaveBeenCalled();
    expect(updateAgentModeIndicator).toHaveBeenCalled();
    expect(updateSystemPromptIndicator).toHaveBeenCalled();
    expect(updateToolCompatibilityWarning).toHaveBeenCalled();
    expect(displayChatStatus).toHaveBeenCalled();
    expect(notifySettingsChanged).toHaveBeenCalled();
  });

  it("no-ops when value is unchanged", async () => {
    const saveChat = jest.fn();
    const ctx = {
      agentMode: true,
      updateViewState: jest.fn(),
      saveChat,
      updateAgentModeIndicator: jest.fn(),
      updateSystemPromptIndicator: jest.fn(),
      updateToolCompatibilityWarning: jest.fn(),
      displayChatStatus: jest.fn(),
      notifySettingsChanged: jest.fn(),
      messages: [],
    } as any;

    await ChatView.prototype.setAgentMode.call(ctx, true, { showNotice: false });

    expect(saveChat).not.toHaveBeenCalled();
  });
});
