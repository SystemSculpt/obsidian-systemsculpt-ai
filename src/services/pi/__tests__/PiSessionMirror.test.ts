import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPiSessionMirror, loadPiSessionMirrorWithRecovery } from "../PiSessionMirror";
import { loadPiSdkModule } from "../PiSdk";

jest.mock("../PiSdk", () => ({
  loadPiSdkModule: jest.fn(),
}));

const loadPiSdkModuleMock = loadPiSdkModule as jest.MockedFunction<typeof loadPiSdkModule>;

describe("PiSessionMirror", () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "pi-session-mirror-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rebuilds a canonical transcript from Pi session entries", async () => {
    const entries = [
      {
        type: "message",
        id: "entry_user",
        parentId: null,
        timestamp: "100",
        message: {
          role: "user",
          timestamp: 100,
          content: [
            { type: "text", text: "Look at this image" },
            { type: "image", data: "YWJj", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message",
        id: "entry_assistant_start",
        parentId: "entry_user",
        timestamp: "200",
        message: {
          role: "assistant",
          timestamp: 200,
          provider: "openai",
          model: "gpt-5.3-codex-spark",
          content: [
            { type: "thinking", thinking: "Need to inspect the image." },
            { type: "text", text: "It looks like a diagram." },
            { type: "toolCall", id: "call_1", name: "read", arguments: { file: "notes.md" } },
          ],
        },
      },
      {
        type: "message",
        id: "entry_tool",
        parentId: "entry_assistant_start",
        timestamp: "300",
        message: {
          role: "toolResult",
          timestamp: 300,
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      },
      {
        type: "message",
        id: "entry_assistant_end",
        parentId: "entry_tool",
        timestamp: "350",
        message: {
          role: "assistant",
          timestamp: 350,
          provider: "openai",
          model: "gpt-5.3-codex-spark",
          content: [{ type: "text", text: "I also found a summary." }],
        },
      },
      {
        type: "message",
        id: "entry_user_2",
        parentId: "entry_assistant_end",
        timestamp: "400",
        message: {
          role: "user",
          timestamp: 400,
          content: "Look at this image\n\nNow summarize the note",
        },
      },
    ];

    loadPiSdkModuleMock.mockResolvedValue({
      SessionManager: {
        open: jest.fn(() => ({
          getBranch: () => entries,
          buildSessionContext: () => ({
            model: {
              provider: "openai",
              modelId: "gpt-5.3-codex-spark",
            },
          }),
          getSessionId: () => "sess_pi",
          getSessionFile: () => "/vault/.pi/sessions/session.jsonl",
          getSessionName: () => "Pi Session Name",
        })),
      },
    } as any);

    const snapshot = await loadPiSessionMirror({
      plugin: {} as any,
      sessionFile: "/vault/.pi/sessions/session.jsonl",
    });

    expect(snapshot).toEqual({
      sessionFile: "/vault/.pi/sessions/session.jsonl",
      sessionId: "sess_pi",
      sessionName: "Pi Session Name",
      actualModelId: "openai/gpt-5.3-codex-spark",
      lastEntryId: "entry_user_2",
      messages: [
        expect.objectContaining({
          role: "user",
          pi_entry_id: "entry_user",
          content: [
            { type: "text", text: "Look at this image" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YWJj" },
            },
          ],
        }),
        expect.objectContaining({
          role: "assistant",
          pi_entry_id: "entry_assistant_end",
          content: "It looks like a diagram.\n\nI also found a summary.",
          reasoning: "Need to inspect the image.",
          tool_calls: [
            expect.objectContaining({
              id: "call_1",
              state: "completed",
              request: expect.objectContaining({
                function: {
                  name: "read",
                  arguments: "{\"file\":\"notes.md\"}",
                },
              }),
            }),
          ],
        }),
        expect.objectContaining({
          role: "user",
          pi_entry_id: "entry_user_2",
          content: "Now summarize the note",
        }),
      ],
    });
    expect(snapshot.messages.some((message) => message.role === "tool")).toBe(false);
  });

  it("recovers a stale session file by matching persisted Pi entry ids", async () => {
    const sessionDir = join(tempDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });

    const staleSessionFile = join(sessionDir, "missing-session.jsonl");
    const recoveredSessionFile = join(sessionDir, "recovered-session.jsonl");
    const unrelatedSessionFile = join(sessionDir, "unrelated-session.jsonl");
    writeFileSync(recoveredSessionFile, "");
    writeFileSync(unrelatedSessionFile, "");

    const sessionEntriesByFile = new Map<string, any[]>([
      [
        recoveredSessionFile,
        [
          {
            type: "message",
            id: "entry_user_match",
            parentId: null,
            timestamp: "100",
            message: {
              role: "user",
              timestamp: 100,
              content: "hi :)",
            },
          },
          {
            type: "message",
            id: "entry_assistant_match",
            parentId: "entry_user_match",
            timestamp: "200",
            message: {
              role: "assistant",
              timestamp: 200,
              provider: "anthropic",
              model: "claude-haiku-4-5",
              content: [{ type: "text", text: "Hey there" }],
            },
          },
        ],
      ],
      [
        unrelatedSessionFile,
        [
          {
            type: "message",
            id: "entry_other",
            parentId: null,
            timestamp: "100",
            message: {
              role: "user",
              timestamp: 100,
              content: "other chat",
            },
          },
        ],
      ],
    ]);

    loadPiSdkModuleMock.mockResolvedValue({
      SessionManager: {
        open: jest.fn((sessionFile: string) => {
          if (!sessionEntriesByFile.has(sessionFile)) {
            throw new Error(`ENOENT: no such file or directory, open '${sessionFile}'`);
          }
          const entries = sessionEntriesByFile.get(sessionFile) || [];
          return {
            getBranch: () => entries,
            buildSessionContext: () => ({
              model: {
                provider: "anthropic",
                modelId: "claude-haiku-4-5",
              },
            }),
            getSessionId: () => `sess-${sessionFile.includes("recovered") ? "recovered" : "other"}`,
            getSessionFile: () => sessionFile,
            getSessionName: () => undefined,
          };
        }),
      },
    } as any);

    const snapshot = await loadPiSessionMirrorWithRecovery({
      plugin: {} as any,
      sessionFile: staleSessionFile,
      lastEntryId: "entry_assistant_match",
      messageEntryIds: ["entry_user_match"],
    });

    expect(snapshot.sessionFile).toBe(recoveredSessionFile);
    expect(snapshot.sessionId).toBe("sess-recovered");
    expect(snapshot.lastEntryId).toBe("entry_assistant_match");
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        role: "user",
        pi_entry_id: "entry_user_match",
        content: "hi :)",
      }),
      expect.objectContaining({
        role: "assistant",
        pi_entry_id: "entry_assistant_match",
        content: "Hey there",
      }),
    ]);
  });
});
