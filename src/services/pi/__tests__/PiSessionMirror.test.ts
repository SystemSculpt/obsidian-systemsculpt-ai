import { loadPiSessionMirror } from "../PiSessionMirror";
import { loadPiSdkModule } from "../PiSdk";

jest.mock("../PiSdk", () => ({
  loadPiSdkModule: jest.fn(),
}));

const loadPiSdkModuleMock = loadPiSdkModule as jest.MockedFunction<typeof loadPiSdkModule>;

describe("PiSessionMirror", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps Pi session entries into chatview-friendly transcript messages", async () => {
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
        id: "entry_assistant",
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
        parentId: "entry_assistant",
        timestamp: "300",
        message: {
          role: "toolResult",
          timestamp: 300,
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
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
          pi_entry_id: "entry_assistant",
          content: "It looks like a diagram.",
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
          role: "tool",
          pi_entry_id: "entry_tool",
          tool_call_id: "call_1",
          name: "read",
          content: "file contents",
        }),
      ],
    });
  });
});
