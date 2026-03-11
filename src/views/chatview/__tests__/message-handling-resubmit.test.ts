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

  it("keeps legacy resubmit behavior by truncating later messages and restoring editable text", async () => {
    const chatView: any = {
      messages: [
        { message_id: "user_1", role: "user", content: "First" },
        { message_id: "assistant_1", role: "assistant", content: "Reply" },
        { message_id: "user_2", role: "user", content: "Legacy resend target" },
        { message_id: "assistant_2", role: "assistant", content: "Latest reply" },
      ],
      isLegacyReadOnlyChat: jest.fn(() => false),
      getPiSessionFile: jest.fn(() => ""),
      getPiSessionId: jest.fn(() => undefined),
      clearPiSessionState: jest.fn(),
      saveChat: jest.fn(async () => {}),
      renderMessagesInChunks: jest.fn(async () => {}),
      chatId: "chat_1",
      chatVersion: 1,
      isFullyLoaded: true,
      inputHandler: {
        setValue: jest.fn(),
        focus: jest.fn(),
      },
    };

    const result = await messageHandling.runResendAction(chatView, {
      messageId: "user_2",
      content: "\n\nLegacy resend target\n\n",
    });

    expect(chatView.messages).toEqual([
      { message_id: "user_1", role: "user", content: "First" },
      { message_id: "assistant_1", role: "assistant", content: "Reply" },
    ]);
    expect(chatView.clearPiSessionState).toHaveBeenCalledWith({ save: false });
    expect(chatView.saveChat).toHaveBeenCalledTimes(1);
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(1);
    expect(chatView.inputHandler.setValue).toHaveBeenCalledWith("Legacy resend target");
    expect(chatView.inputHandler.focus).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "success" });
  });
});
