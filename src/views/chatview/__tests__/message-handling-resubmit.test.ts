/**
 * @jest-environment jsdom
 */

jest.mock("obsidian", () => ({
  ButtonComponent: class {},
  Notice: jest.fn(),
}));

import { Notice } from "obsidian";
import { messageHandling } from "../messageHandling";

describe("messageHandling resubmit behavior", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  it("skips rendering hidden system-role messages", async () => {
    const chatContainer = document.createElement("div");
    const renderMessage = jest.fn();
    const chatView: any = {
      shouldRenderMessageRole: jest.fn(() => false),
      messageRenderer: { renderMessage },
      chatContainer,
      isGenerating: false,
      manageDomSize: jest.fn(),
      register: jest.fn(),
    };

    await messageHandling.addMessage(chatView, "system", "Hidden system turn", "system_1");

    expect(chatView.shouldRenderMessageRole).toHaveBeenCalledWith("system");
    expect(renderMessage).not.toHaveBeenCalled();
    expect(chatContainer.childElementCount).toBe(0);
  });

  it("branches managed-session chats and restores the resent prompt into the composer", async () => {
    const chatView: any = {
      messages: [{ message_id: "user_pi_1", role: "user", content: "Hello Pi" }],
      isLegacyReadOnlyChat: jest.fn(() => false),
      getPiSessionFile: jest.fn(() => undefined),
      getPiSessionId: jest.fn(() => "remote-session-1"),
      forkPiSessionFromMessage: jest.fn(async () => ({ text: "Hello Pi", cancelled: false })),
      inputHandler: {
        setValue: jest.fn(),
        focus: jest.fn(),
      },
    };

    const result = await messageHandling.runResendAction(chatView, {
      messageId: "user_pi_1",
      content: "Hello Pi",
    });

    expect(chatView.forkPiSessionFromMessage).toHaveBeenCalledWith("user_pi_1");
    expect(chatView.inputHandler.setValue).toHaveBeenCalledWith("Hello Pi");
    expect(chatView.inputHandler.focus).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "success" });
    expect(Notice).toHaveBeenCalledWith("Branched chat to that message and restored it to the composer.");
  });

  it("installs resend intent without changing the accepted transcript", async () => {
    const messages = [{ message_id: "user-1", role: "user", content: "First" }, { message_id: "assistant-1", role: "assistant", content: "Reply" }];
    const setPendingResendIntent = jest.fn();
    const chatView: any = {
      messages, chatId: "chat-original", isLegacyReadOnlyChat: jest.fn(() => false),
      getPiSessionFile: jest.fn(() => ""), getPiSessionId: jest.fn(() => undefined),
      getPendingResendIdentity: jest.fn(() => ({ targetMessageId: "user-1", expectedIndex: 0, expectedVersion: 1 })),
      inputHandler: { setPendingResendIntent, setValue: jest.fn(), focus: jest.fn() },
    };
    await expect(messageHandling.runResendAction(chatView, { messageId: "user-1", content: "First" })).resolves.toEqual({ status: "success" });
    expect(setPendingResendIntent).toHaveBeenCalledWith({ targetMessageId: "user-1", expectedIndex: 0, expectedVersion: 1 });
    expect(chatView.messages).toBe(messages);
  });

  it("never reaches interrupted durable-branch recovery from the active resend action", async () => {
    const retryPendingResend = jest.fn();
    const chatView: any = { messages: [], retryPendingResend, inputHandler: { setValue: jest.fn(), focus: jest.fn() } };
    await expect(messageHandling.runResendAction(chatView, { messageId: "user-first", content: "Retry" })).resolves.toEqual({ status: "error" });
    expect(retryPendingResend).not.toHaveBeenCalled();
  });

  it("queues standard resend without eagerly truncating durable messages", async () => {
    const messages = [
      { message_id: "user_1", role: "user", content: "First" },
      { message_id: "assistant_1", role: "assistant", content: "Reply" },
      { message_id: "user_2", role: "user", content: "Legacy resend target" },
      { message_id: "assistant_2", role: "assistant", content: "Latest reply" },
    ];
    const chatView: any = {
      messages, isLegacyReadOnlyChat: jest.fn(() => false), getPiSessionFile: jest.fn(() => ""), getPiSessionId: jest.fn(() => undefined),
      getPendingResendIdentity: jest.fn(() => ({ targetMessageId: "user_2", expectedIndex: 2, expectedVersion: 1 })),
      inputHandler: { setPendingResendIntent: jest.fn(), setValue: jest.fn(), focus: jest.fn() },
    };
    const result = await messageHandling.runResendAction(chatView, { messageId: "user_2", content: "Legacy resend target" });
    expect(chatView.messages).toBe(messages);
    expect(chatView.inputHandler.setPendingResendIntent).toHaveBeenCalledWith({ targetMessageId: "user_2", expectedIndex: 2, expectedVersion: 1 });
    expect(result).toEqual({ status: "success" });
  });
});
