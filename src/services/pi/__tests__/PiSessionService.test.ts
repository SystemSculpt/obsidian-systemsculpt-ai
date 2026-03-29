jest.mock("../PiSdkCore", () => ({
  SessionManager: {
    open: jest.fn(),
  },
}));

jest.mock("../PiSdkRuntime", () => ({
  openPiAgentSession: jest.fn(),
}));

import { SessionManager } from "../PiSdkCore";
import { openPiAgentSession } from "../PiSdkRuntime";
import {
  forkPiSession,
  listPiForkMessages,
  setPiSessionName,
} from "../PiSessionService";

describe("PiSessionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists user fork messages from the current session branch", async () => {
    (SessionManager.open as jest.Mock).mockReturnValue({
      getBranch: () => [
        { type: "message", id: "entry_user_1", message: { role: "user", content: "First question" } },
        { type: "message", id: "entry_assistant_1", message: { role: "assistant", content: [] } },
        {
          type: "message",
          id: "entry_user_2",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Second question" },
              { type: "image", mimeType: "image/png", data: "..." },
            ],
          },
        },
      ],
    });

    await expect(listPiForkMessages("/vault/.pi/sessions/test.jsonl")).resolves.toEqual([
      { entryId: "entry_user_1", text: "First question" },
      { entryId: "entry_user_2", text: "Second question" },
    ]);
  });

  it("forks a Pi session through the in-process SDK session", async () => {
    const session = {
      fork: jest.fn(async () => ({ selectedText: "Retry me", cancelled: false })),
      dispose: jest.fn(),
      sessionFile: "/vault/.pi/sessions/forked.jsonl",
      sessionId: "sess_forked",
      sessionManager: {
        getSessionName: jest.fn(() => "Forked Pi"),
      },
    };
    (openPiAgentSession as jest.Mock).mockResolvedValue(session);

    await expect(
      forkPiSession({
        plugin: { id: "plugin" } as any,
        sessionFile: "/vault/.pi/sessions/original.jsonl",
        entryId: "entry_user_2",
      })
    ).resolves.toEqual({
      text: "Retry me",
      cancelled: false,
      sessionFile: "/vault/.pi/sessions/forked.jsonl",
      sessionId: "sess_forked",
      sessionName: "Forked Pi",
    });

    expect(session.fork).toHaveBeenCalledWith("entry_user_2");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("renames a Pi session through the in-process SDK session", async () => {
    const session = {
      setSessionName: jest.fn(),
      dispose: jest.fn(),
      sessionFile: "/vault/.pi/sessions/original.jsonl",
      sessionId: "sess_original",
    };
    (openPiAgentSession as jest.Mock).mockResolvedValue(session);

    await expect(
      setPiSessionName({
        plugin: { id: "plugin" } as any,
        sessionFile: "/vault/.pi/sessions/original.jsonl",
        name: "New name",
      })
    ).resolves.toEqual({
      sessionFile: "/vault/.pi/sessions/original.jsonl",
      sessionId: "sess_original",
    });

    expect(session.setSessionName).toHaveBeenCalledWith("New name");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
});
