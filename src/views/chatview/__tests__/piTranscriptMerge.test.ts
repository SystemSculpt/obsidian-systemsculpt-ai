import { mergePiTranscriptMessages } from "../piTranscriptMerge";

describe("mergePiTranscriptMessages", () => {
  it("appends a fresh Pi transcript onto an existing non-Pi chat history", () => {
    const currentMessages = [
      {
        role: "user",
        content: "First question",
        message_id: "managed-user-1",
      },
      {
        role: "assistant",
        content: "First answer",
        message_id: "managed-assistant-1",
      },
    ] as any[];
    const snapshotMessages = [
      {
        role: "user",
        content: "Second question",
        message_id: "pi-user-1",
        pi_entry_id: "entry-user-1",
      },
      {
        role: "assistant",
        content: "Second answer",
        message_id: "pi-assistant-1",
        pi_entry_id: "entry-assistant-1",
      },
    ] as any[];

    expect(
      mergePiTranscriptMessages(currentMessages, snapshotMessages, {
        hadSyncedPiTranscript: false,
      }),
    ).toEqual([...currentMessages, ...snapshotMessages]);
  });

  it("preserves the non-Pi prefix when refreshing an existing Pi session transcript", () => {
    const currentMessages = [
      {
        role: "user",
        content: "First question",
        message_id: "managed-user-1",
      },
      {
        role: "assistant",
        content: "First answer",
        message_id: "managed-assistant-1",
      },
      {
        role: "user",
        content: "Second question",
        message_id: "pi-user-1",
        pi_entry_id: "entry-user-1",
      },
      {
        role: "assistant",
        content: "Second answer",
        message_id: "pi-assistant-1",
        pi_entry_id: "entry-assistant-1",
      },
    ] as any[];
    const refreshedSnapshot = [
      currentMessages[2],
      currentMessages[3],
      {
        role: "user",
        content: "Third question",
        message_id: "pi-user-2",
        pi_entry_id: "entry-user-2",
      },
      {
        role: "assistant",
        content: "Third answer",
        message_id: "pi-assistant-2",
        pi_entry_id: "entry-assistant-2",
      },
    ] as any[];

    expect(
      mergePiTranscriptMessages(currentMessages, refreshedSnapshot, {
        hadSyncedPiTranscript: true,
      }),
    ).toEqual([currentMessages[0], currentMessages[1], ...refreshedSnapshot]);
  });

  it("matches the just-rendered Pi turn by role and content when mirror message ids differ", () => {
    const currentMessages = [
      {
        role: "user",
        content: "First question",
        message_id: "managed-user-1",
      },
      {
        role: "assistant",
        content: "First answer",
        message_id: "managed-assistant-1",
      },
      {
        role: "user",
        content: "Second question",
        message_id: "draft-user-2",
      },
      {
        role: "assistant",
        content: "Second answer",
        message_id: "draft-assistant-2",
      },
    ] as any[];
    const mirroredSnapshot = [
      {
        role: "user",
        content: "Second question",
        message_id: "pi-user-2",
        pi_entry_id: "entry-user-2",
      },
      {
        role: "assistant",
        content: "Second answer",
        message_id: "pi-assistant-2",
        pi_entry_id: "entry-assistant-2",
      },
    ] as any[];

    expect(
      mergePiTranscriptMessages(currentMessages, mirroredSnapshot, {
        hadSyncedPiTranscript: false,
      }),
    ).toEqual([currentMessages[0], currentMessages[1], ...mirroredSnapshot]);
  });

  it("falls back to the Pi snapshot when a previously synced transcript no longer overlaps", () => {
    const currentMessages = [
      {
        role: "user",
        content: "Old Pi question",
        message_id: "pi-user-1",
        pi_entry_id: "entry-user-1",
      },
    ] as any[];
    const snapshotMessages = [
      {
        role: "user",
        content: "Replacement question",
        message_id: "pi-user-2",
        pi_entry_id: "entry-user-2",
      },
    ] as any[];

    expect(
      mergePiTranscriptMessages(currentMessages, snapshotMessages, {
        hadSyncedPiTranscript: true,
      }),
    ).toEqual(snapshotMessages);
  });
});
