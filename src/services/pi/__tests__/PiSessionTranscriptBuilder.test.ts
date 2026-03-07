import { buildPiSessionTranscript } from "../PiSessionTranscriptBuilder";

describe("PiSessionTranscriptBuilder", () => {
  it("turns cumulative Pi entries into one canonical chat transcript", () => {
    const transcript = buildPiSessionTranscript([
      {
        type: "message",
        id: "entry_user_1",
        parentId: null,
        timestamp: "100",
        message: {
          role: "user",
          timestamp: 100,
          content: "hey whatcha up to",
        },
      },
      {
        type: "message",
        id: "entry_assistant_1",
        parentId: "entry_user_1",
        timestamp: "200",
        message: {
          role: "assistant",
          timestamp: 200,
          content: [
            { type: "thinking", thinking: "Need to inspect the vault first." },
            { type: "text", text: "Let me inspect your vault." },
            { type: "toolCall", id: "call_1", name: "read_vault", arguments: { path: "." } },
          ],
        },
      },
      {
        type: "message",
        id: "entry_tool_1",
        parentId: "entry_assistant_1",
        timestamp: "250",
        message: {
          role: "toolResult",
          timestamp: 250,
          toolCallId: "call_1",
          toolName: "read_vault",
          content: [{ type: "text", text: "vault contents" }],
        },
      },
      {
        type: "message",
        id: "entry_assistant_2",
        parentId: "entry_tool_1",
        timestamp: "300",
        message: {
          role: "assistant",
          timestamp: 300,
          content: [{ type: "text", text: "Short version: it is organized around chats." }],
        },
      },
      {
        type: "message",
        id: "entry_user_2",
        parentId: "entry_assistant_2",
        timestamp: "400",
        message: {
          role: "user",
          timestamp: 400,
          content: "hey whatcha up to\n\ntldr my vault pls",
        },
      },
      {
        type: "message",
        id: "entry_assistant_3",
        parentId: "entry_user_2",
        timestamp: "500",
        message: {
          role: "assistant",
          timestamp: 500,
          content: [{ type: "text", text: "TLDR: chats, studio flows, and diagnostics." }],
        },
      },
    ] as any);

    expect(transcript).toHaveLength(4);

    expect(transcript[0]).toEqual(
      expect.objectContaining({
        role: "user",
        pi_entry_id: "entry_user_1",
        content: "hey whatcha up to",
      }),
    );

    expect(transcript[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        pi_entry_id: "entry_assistant_2",
        content: "Let me inspect your vault.\n\nShort version: it is organized around chats.",
        reasoning: "Need to inspect the vault first.",
        tool_calls: [
          expect.objectContaining({
            id: "call_1",
            state: "completed",
            request: expect.objectContaining({
              function: {
                name: "read_vault",
                arguments: "{\"path\":\".\"}",
              },
            }),
            result: {
              success: true,
              data: "vault contents",
            },
          }),
        ],
      }),
    );

    expect(transcript[2]).toEqual(
      expect.objectContaining({
        role: "user",
        pi_entry_id: "entry_user_2",
        content: "tldr my vault pls",
      }),
    );

    expect(transcript[3]).toEqual(
      expect.objectContaining({
        role: "assistant",
        pi_entry_id: "entry_assistant_3",
        content: "TLDR: chats, studio flows, and diagnostics.",
      }),
    );
  });
});
