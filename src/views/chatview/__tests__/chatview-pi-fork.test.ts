/**
 * @jest-environment jsdom
 */

jest.mock("../../../services/SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({})),
  },
}));

jest.mock("../../../services/pi/PiSessionService", () => ({
  forkPiSession: jest.fn(),
  listPiForkMessages: jest.fn(),
  setPiSessionName: jest.fn(),
}));

jest.mock("../../../services/pi/PiSessionMirror", () => ({
  loadPiSessionMirrorWithRecovery: jest.fn(),
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
import { forkPiSession } from "../../../services/pi/PiSessionService";
import { loadPiSessionMirrorWithRecovery } from "../../../services/pi/PiSessionMirror";
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

  it("keeps Pi hydration transcript, metadata, title, identity, and UI unchanged on save failure, then retries atomically", async () => {
    (loadPiSessionMirrorWithRecovery as jest.Mock).mockResolvedValue({
      messages: [{ role: "assistant", content: "Hydrated", message_id: "pi_1", pi_entry_id: "entry_new" }],
      sessionFile: "/tmp/pi-hydrated.jsonl",
      sessionId: "sess_new",
      lastEntryId: "entry_new",
      sessionName: "Hydrated title",
    });
    const originalMessages = [{ role: "user", content: "Old", message_id: "old_1" }] as any[];
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = {
      saveChat: jest.fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce({ version: 2 }),
    };
    chatView.messages = originalMessages;
    chatView.chatId = "chat_1";
    chatView.chatVersion = 1;
    chatView.chatTitle = "Original title";
    chatView.chatBackend = "systemsculpt";
    chatView.isFullyLoaded = true;
    chatView.piSessionFile = "/tmp/pi-old.jsonl";
    chatView.piSessionId = "sess_old";
    chatView.piLastEntryId = "entry_old";
    chatView.isPiBackedChat = jest.fn(() => true);
    chatView.renderMessagesInChunks = jest.fn(async () => {});
    chatView.updateViewState = jest.fn();
    chatView.setTitle = jest.fn(function (this: any, title: string) { this.chatTitle = title; });

    await expect(chatView.hydrateFromPiSession({
      sessionFile: "/tmp/pi-hydrated.jsonl",
      sessionId: "sess_new",
      save: true,
    })).rejects.toThrow("disk full");

    expect(chatView.messages).toEqual(originalMessages);
    expect(chatView.chatId).toBe("chat_1");
    expect(chatView.chatVersion).toBe(1);
    expect(chatView.chatTitle).toBe("Original title");
    expect(chatView.piSessionFile).toBe("/tmp/pi-old.jsonl");
    expect(chatView.piSessionId).toBe("sess_old");
    expect(chatView.piLastEntryId).toBe("entry_old");
    expect(chatView.updateViewState).not.toHaveBeenCalled();
    expect(chatView.renderMessagesInChunks).not.toHaveBeenCalled();

    await expect(chatView.hydrateFromPiSession({
      sessionFile: "/tmp/pi-hydrated.jsonl",
      sessionId: "sess_new",
      save: true,
    })).resolves.toBeUndefined();

    expect(chatView.messages.map((message: any) => message.message_id)).toEqual(["pi_1"]);
    expect(chatView.piSessionFile).toBe("/tmp/pi-hydrated.jsonl");
    expect(chatView.piSessionId).toBe("sess_new");
    expect(chatView.piLastEntryId).toBe("entry_new");
    expect(chatView.chatTitle).toBe("Hydrated title");
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(2);
    expect(chatView.chatStorage.saveChat).toHaveBeenLastCalledWith(
      "chat_1",
      [expect.objectContaining({ message_id: "pi_1" })],
      expect.objectContaining({
        title: "Hydrated title",
        chatBackend: "systemsculpt",
        piSessionFile: "/tmp/pi-hydrated.jsonl",
        piSessionId: "sess_new",
        piLastEntryId: "entry_new",
        piLastSyncedAt: expect.any(String),
      }),
    );
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(1);
  });

  it("retries only the committed Pi hydration projection after projection and recovery-render failures", async () => {
    (loadPiSessionMirrorWithRecovery as jest.Mock).mockResolvedValue({
      messages: [{ role: "assistant", content: "Hydrated", message_id: "pi_retry", pi_entry_id: "entry_retry" }],
      sessionFile: "/tmp/pi-retry.jsonl",
      sessionId: "sess_retry",
      lastEntryId: "entry_retry",
    });
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = { saveChat: jest.fn(async () => ({ version: 2 })) };
    chatView.messages = [{ role: "user", content: "Old", message_id: "old" }];
    chatView.chatId = "chat_retry";
    chatView.chatVersion = 1;
    chatView.chatTitle = "Retry";
    chatView.chatBackend = "systemsculpt";
    chatView.isFullyLoaded = true;
    chatView.piSessionFile = "/tmp/pi-old.jsonl";
    chatView.piLastEntryId = "entry_old";
    chatView.isPiBackedChat = jest.fn(() => true);
    chatView.updateViewState = jest.fn();
    const realProject = (ChatView.prototype as any).projectTranscript;
    chatView.projectTranscript = jest.fn()
      .mockImplementationOnce(() => { throw new Error("projection failed"); })
      .mockImplementation(function (this: any) { return realProject.call(this); });
    chatView.renderMessagesInChunks = jest.fn()
      .mockRejectedValueOnce(new Error("recovery render failed"))
      .mockResolvedValue(undefined);

    await expect(chatView.hydrateFromPiSession({
      sessionFile: "/tmp/pi-retry.jsonl",
      save: true,
    })).rejects.toThrow("recovery render failed");

    await expect(chatView.hydrateFromPiSession({
      sessionFile: "/tmp/pi-retry.jsonl",
      save: true,
    })).resolves.toBeUndefined();

    expect(chatView.messages.map((message: any) => message.message_id)).toEqual(["pi_retry"]);
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(1);
    expect(loadPiSessionMirrorWithRecovery).toHaveBeenCalledTimes(1);
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(2);
  });

  it("collapses the visible transcript locally when Pi switches to an unflushed fork session", async () => {
    const oldSessionFile = "/tmp/pi-session-old.jsonl";
    const newSessionFile = "/tmp/pi-session-new.jsonl";

    (existsSync as jest.Mock).mockImplementation((path: any) => {
      const normalized = String(path || "");
      return normalized === oldSessionFile;
    });

    (forkPiSession as jest.Mock).mockResolvedValue({
      text: "Retry me",
      cancelled: false,
      sessionFile: newSessionFile,
      sessionId: "sess_new",
      sessionName: "Forked Pi",
    });

    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = { saveChat: jest.fn(async () => ({ version: 2 })) };
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
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(1);
    expect(forkPiSession).toHaveBeenCalledWith({
      plugin: chatView.plugin,
      sessionFile: oldSessionFile,
      entryId: "entry_user_2",
    });
  });

  it("keeps local Pi fork transcript, metadata, identity, and UI unchanged on save failure, then retries atomically", async () => {
    const originalMessages = [
      { role: "user", content: "First", message_id: "user_1", pi_entry_id: "entry_user_1" },
      { role: "assistant", content: "Reply", message_id: "assistant_1", pi_entry_id: "entry_assistant_1" },
      { role: "user", content: "Retry me", message_id: "user_2", pi_entry_id: "entry_user_2" },
      { role: "assistant", content: "Later reply", message_id: "assistant_2", pi_entry_id: "entry_assistant_2" },
    ] as any[];
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = {
      saveChat: jest.fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce({ version: 2 }),
    };
    chatView.chatBackend = "systemsculpt";
    chatView.messages = originalMessages;
    chatView.getPiSessionFile = jest.fn(() => undefined);
    chatView.getPiSessionId = jest.fn(() => "sess_remote_old");
    chatView.renderMessagesInChunks = jest.fn(async () => {});
    chatView.updateViewState = jest.fn();
    chatView.setTitle = jest.fn();
    chatView.chatId = "chat_remote";
    chatView.chatVersion = 1;
    chatView.chatTitle = "Original";
    chatView.isFullyLoaded = true;
    chatView.piSessionId = "sess_remote_old";
    chatView.piLastEntryId = "entry_assistant_2";

    await expect(chatView.forkPiSessionFromMessage("user_2")).rejects.toThrow("disk full");

    expect(chatView.messages).toEqual(originalMessages);
    expect(chatView.chatId).toBe("chat_remote");
    expect(chatView.chatVersion).toBe(1);
    expect(chatView.piSessionId).toBe("sess_remote_old");
    expect(chatView.piLastEntryId).toBe("entry_assistant_2");
    expect(chatView.updateViewState).not.toHaveBeenCalled();
    expect(chatView.renderMessagesInChunks).not.toHaveBeenCalled();

    await expect(chatView.forkPiSessionFromMessage("user_2")).resolves.toEqual({
      text: "Retry me",
      cancelled: false,
    });
    expect(chatView.messages.map((message: any) => message.message_id)).toEqual(["user_1", "assistant_1"]);
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(2);
    expect(chatView.chatStorage.saveChat).toHaveBeenLastCalledWith(
      "chat_remote",
      expect.arrayContaining([expect.objectContaining({ message_id: "assistant_1" })]),
      expect.objectContaining({
        chatBackend: "systemsculpt",
        piLastEntryId: "entry_assistant_1",
        piLastSyncedAt: expect.any(String),
      }),
    );
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(1);
  });

  it("retries only the committed Pi fork projection after projection and recovery-render failures", async () => {
    const originalMessages = [
      { role: "user", content: "First", message_id: "user_1", pi_entry_id: "entry_user_1" },
      { role: "assistant", content: "Reply", message_id: "assistant_1", pi_entry_id: "entry_assistant_1" },
      { role: "user", content: "Retry me", message_id: "user_2", pi_entry_id: "entry_user_2" },
      { role: "assistant", content: "Later reply", message_id: "assistant_2", pi_entry_id: "entry_assistant_2" },
    ] as any[];
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = { saveChat: jest.fn(async () => ({ version: 2 })) };
    chatView.chatBackend = "systemsculpt";
    chatView.messages = originalMessages;
    chatView.getPiSessionFile = jest.fn(() => undefined);
    chatView.getPiSessionId = jest.fn(() => "sess_remote_old");
    chatView.updateViewState = jest.fn();
    chatView.setTitle = jest.fn();
    chatView.chatId = "chat_remote";
    chatView.chatVersion = 1;
    chatView.chatTitle = "Original";
    chatView.isFullyLoaded = true;
    chatView.piSessionId = "sess_remote_old";
    chatView.piLastEntryId = "entry_assistant_2";
    const realProject = (ChatView.prototype as any).projectTranscript;
    chatView.projectTranscript = jest.fn()
      .mockImplementationOnce(() => { throw new Error("projection failed"); })
      .mockImplementation(function (this: any) { return realProject.call(this); });
    chatView.renderMessagesInChunks = jest.fn()
      .mockRejectedValueOnce(new Error("recovery render failed"))
      .mockResolvedValue(undefined);

    await expect(chatView.forkPiSessionFromMessage("user_2")).rejects.toThrow("recovery render failed");
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(1);

    await expect(chatView.forkPiSessionFromMessage("user_2")).resolves.toEqual({
      text: "Retry me",
      cancelled: false,
    });

    expect(chatView.messages.map((message: any) => message.message_id)).toEqual(["user_1", "assistant_1"]);
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(1);
    expect(chatView.renderMessagesInChunks).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite chat storage when history hydration marks Pi as the authoritative durable source", async () => {
    (loadPiSessionMirrorWithRecovery as jest.Mock).mockResolvedValue({
      messages: [{ role: "assistant", content: "External", message_id: "pi_external", pi_entry_id: "entry_external" }],
      sessionFile: "/tmp/pi-external.jsonl",
      sessionId: "sess_external",
      lastEntryId: "entry_external",
    });
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = { saveChat: jest.fn() };
    chatView.messages = [{ role: "user", content: "Old", message_id: "old" }];
    chatView.chatId = "chat_history";
    chatView.chatVersion = 7;
    chatView.chatTitle = "History";
    chatView.chatBackend = "systemsculpt";
    chatView.isFullyLoaded = true;
    chatView.piSessionFile = "/tmp/pi-old.jsonl";
    chatView.piLastEntryId = "entry_old";
    chatView.isPiBackedChat = jest.fn(() => true);
    chatView.updateViewState = jest.fn();
    chatView.renderMessagesInChunks = jest.fn(async () => {});

    await chatView.syncPiSessionTranscript({
      sessionFile: "/tmp/pi-external.jsonl",
      persist: false,
      force: true,
    });

    expect(chatView.chatStorage.saveChat).not.toHaveBeenCalled();
    expect(chatView.chatVersion).toBe(7);
    expect(chatView.messages.map((message: any) => message.message_id)).toEqual(["pi_external"]);
  });

  it("does not rewrite chat storage when hydrateFromPiSession is called with save false", async () => {
    (loadPiSessionMirrorWithRecovery as jest.Mock).mockResolvedValue({
      messages: [{ role: "assistant", content: "External", message_id: "pi_external", pi_entry_id: "entry_external" }],
      sessionFile: "/tmp/pi-external.jsonl",
      sessionId: "sess_external",
      lastEntryId: "entry_external",
    });
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = { saveChat: jest.fn() };
    chatView.messages = [];
    chatView.chatId = "chat_hydrate";
    chatView.chatVersion = 3;
    chatView.chatTitle = "Hydrate";
    chatView.chatBackend = "systemsculpt";
    chatView.isFullyLoaded = true;
    chatView.piSessionFile = "/tmp/pi-old.jsonl";
    chatView.isPiBackedChat = jest.fn(() => true);
    chatView.updateViewState = jest.fn();
    chatView.renderMessagesInChunks = jest.fn(async () => {});

    await chatView.hydrateFromPiSession({
      sessionFile: "/tmp/pi-external.jsonl",
      save: false,
    });

    expect(chatView.chatStorage.saveChat).not.toHaveBeenCalled();
    expect(chatView.chatVersion).toBe(3);
    expect(chatView.messages.map((message: any) => message.message_id)).toEqual(["pi_external"]);
  });

  it("truncates the visible transcript locally when only a session id is present", async () => {
    const chatView = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    chatView.plugin = { settings: {} };
    chatView.chatStorage = { saveChat: jest.fn(async () => ({ version: 2 })) };
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
    expect(chatView.chatStorage.saveChat).toHaveBeenCalledTimes(1);
    expect(forkPiSession).not.toHaveBeenCalled();
  });
});
