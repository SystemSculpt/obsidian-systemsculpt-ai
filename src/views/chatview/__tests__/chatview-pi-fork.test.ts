/**
 * @jest-environment jsdom
 */

jest.mock("../../../services/SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({})),
  },
}));

jest.mock("../../../services/pi/PiRpcProcessClient", () => ({
  PiRpcProcessClient: jest.fn(),
}));

jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
  };
});

import { existsSync } from "node:fs";
import { Platform } from "obsidian";
import { PiRpcProcessClient } from "../../../services/pi/PiRpcProcessClient";
import { ChatView } from "../ChatView";

describe("ChatView Pi fork state", () => {
  const originalIsDesktopApp = Platform.isDesktopApp;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.isDesktopApp = true;
  });

  afterAll(() => {
    Platform.isDesktopApp = originalIsDesktopApp;
  });

  it("collapses the visible transcript locally when Pi switches to an unflushed fork session", async () => {
    const oldSessionFile = "/tmp/pi-session-old.jsonl";
    const newSessionFile = "/tmp/pi-session-new.jsonl";

    (existsSync as jest.Mock).mockImplementation((path: any) => {
      const normalized = String(path || "");
      return normalized === oldSessionFile;
    });

    const client = {
      start: jest.fn(async () => {}),
      fork: jest.fn(async () => ({ text: "Retry me", cancelled: false })),
      getState: jest.fn(async () => ({
        sessionFile: newSessionFile,
        sessionId: "sess_new",
        sessionName: "Forked Pi",
      })),
      stop: jest.fn(async () => {}),
    };

    (PiRpcProcessClient as jest.Mock).mockImplementation(() => client);

    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = {};
    chatView.messages = [
      { role: "user", content: "First", message_id: "user_1", pi_entry_id: "entry_user_1" },
      { role: "assistant", content: "Reply", message_id: "assistant_1", pi_entry_id: "entry_assistant_1" },
      { role: "user", content: "Retry me", message_id: "user_2", pi_entry_id: "entry_user_2" },
      { role: "assistant", content: "Later reply", message_id: "assistant_2", pi_entry_id: "entry_assistant_2" },
    ];
    chatView.getPiSessionFile = jest.fn(() => oldSessionFile);
    chatView.renderMessagesInChunks = jest.fn(async () => {});
    chatView.saveChat = jest.fn(async () => {});
    chatView.updateViewState = jest.fn();
    chatView.setTitle = jest.fn();
    chatView.chatId = "chat_1";
    chatView.isFullyLoaded = true;
    chatView.piSessionFile = oldSessionFile;
    chatView.piSessionId = "sess_old";
    chatView.piLastEntryId = "entry_assistant_2";

    const result = await chatView.forkPiSessionFromMessage("user_2");

    expect(result).toEqual({ text: "Retry me", cancelled: false });
    expect(chatView.messages).toEqual([
      { role: "user", content: "First", message_id: "user_1", pi_entry_id: "entry_user_1" },
      { role: "assistant", content: "Reply", message_id: "assistant_1", pi_entry_id: "entry_assistant_1" },
    ]);
    expect(chatView.piSessionFile).toBe(newSessionFile);
    expect(chatView.piSessionId).toBe("sess_new");
    expect(chatView.piLastEntryId).toBe("entry_assistant_1");
    expect(chatView.setTitle).toHaveBeenCalledWith("Forked Pi", false);
    expect(chatView.updateViewState).toHaveBeenCalled();
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(1);
    expect(chatView.saveChat).toHaveBeenCalledTimes(1);
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("truncates the visible transcript locally when only a session id is present", async () => {
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = {};
    chatView.chatBackend = "systemsculpt";
    chatView.messages = [
      { role: "user", content: "First", message_id: "user_1", pi_entry_id: "entry_user_1" },
      { role: "assistant", content: "Reply", message_id: "assistant_1", pi_entry_id: "entry_assistant_1" },
      { role: "user", content: "Retry me", message_id: "user_2", pi_entry_id: "entry_user_2" },
      { role: "assistant", content: "Later reply", message_id: "assistant_2", pi_entry_id: "entry_assistant_2" },
    ];
    chatView.getPiSessionFile = jest.fn(() => undefined);
    chatView.getPiSessionId = jest.fn(() => "sess_remote_old");
    chatView.renderMessagesInChunks = jest.fn(async () => {});
    chatView.saveChat = jest.fn(async () => {});
    chatView.updateViewState = jest.fn();
    chatView.setTitle = jest.fn();
    chatView.chatId = "chat_remote";
    chatView.isFullyLoaded = true;
    chatView.piSessionId = "sess_remote_old";
    chatView.piLastEntryId = "entry_assistant_2";

    const result = await chatView.forkPiSessionFromMessage("user_2");

    expect(result).toEqual({ text: "Retry me", cancelled: false });
    expect(chatView.messages).toEqual([
      { role: "user", content: "First", message_id: "user_1", pi_entry_id: "entry_user_1" },
      { role: "assistant", content: "Reply", message_id: "assistant_1", pi_entry_id: "entry_assistant_1" },
    ]);
    expect(chatView.piSessionFile).toBeUndefined();
    expect(chatView.piSessionId).toBeUndefined();
    expect(chatView.piLastEntryId).toBe("entry_assistant_1");
    expect(chatView.updateViewState).toHaveBeenCalled();
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(1);
    expect(chatView.saveChat).toHaveBeenCalledTimes(1);
  });
});
