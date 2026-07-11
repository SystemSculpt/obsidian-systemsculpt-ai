import type { ChatMessage } from "../../../types";
import { ChatTranscript, ChatTranscriptReadOnlyError } from "../transcript/ChatTranscript";
import type { ChatTranscriptStorage } from "../transcript/ChatTranscriptStorage";

const user = (id: string): ChatMessage => ({ role: "user", content: id, message_id: id });
const assistant = (id: string): ChatMessage => ({ role: "assistant", content: id, message_id: id });

function storage(initial: Record<string, { version: number; messages: ChatMessage[]; readOnly?: boolean }> = {}) {
  const durable = new Map(Object.entries(initial));
  const port: jest.Mocked<ChatTranscriptStorage> = {
    load: jest.fn(async (chatId) => {
      const value = durable.get(chatId);
      return value ? { chatId, ...structuredClone(value) } : null;
    }),
    save: jest.fn(async (chatId, messages) => {
      const version = (durable.get(chatId)?.version || 0) + 1;
      durable.set(chatId, { version, messages: structuredClone(messages) as ChatMessage[] });
      return { version };
    }),
    createExclusive: jest.fn(async (chatId, messages) => {
      if (durable.has(chatId)) return null;
      durable.set(chatId, { version: 1, messages: structuredClone(messages) as ChatMessage[] });
      return { version: 1 };
    }),
  };
  return { port, durable };
}

describe("ChatTranscript branch, load, clear, and recovery", () => {
  it("loads an existing durable transcript", async () => {
    const { port } = storage({ chat: { version: 3, messages: [user("u1")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    expect(transcript.snapshot()).toMatchObject({ chatId: "chat", version: 3, messages: [user("u1")] });
  });

  it("loads a missing chat as an empty transcript with its requested identity", async () => {
    const { port } = storage();
    const transcript = await ChatTranscript.load(port, "missing");
    expect(transcript.snapshot()).toMatchObject({ chatId: "missing", version: 0, messages: [] });
  });

  it("clears to a writable, identity-free transcript without storage", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    expect(transcript.clear()).toEqual({ chatId: "", version: 0, messages: [] });
    expect(port.save).not.toHaveBeenCalled();
  });

  it("persists a middle branch before replacing the accepted snapshot", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1"), assistant("a1"), user("u2")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    const pending = transcript.branchFrom(2);
    expect(transcript.snapshot().messages).toHaveLength(3);
    await expect(pending).resolves.toMatchObject({ chatId: "chat", messages: [user("u1"), assistant("a1")] });
  });

  it("allocates a new durable identity for a first-message branch", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1"), assistant("a1")] } });
    const transcript = await ChatTranscript.load(port, "chat", () => new Date(2026, 6, 10, 12, 34, 56));
    await expect(transcript.branchFrom(0)).resolves.toMatchObject({ chatId: "2026-07-10 12-34-56", messages: [] });
  });

  it("skips identity collisions for a first-message branch", async () => {
    const { port } = storage({
      chat: { version: 1, messages: [user("u1")] },
      "2026-07-10 12-34-56": { version: 1, messages: [] },
    });
    const transcript = await ChatTranscript.load(port, "chat", () => new Date(2026, 6, 10, 12, 34, 56));
    await expect(transcript.branchFrom(0)).resolves.toMatchObject({ chatId: "2026-07-10 12-34-56-2" });
  });

  it("leaves the accepted snapshot unchanged when branch storage fails", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1"), assistant("a1")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    const before = transcript.snapshot();
    port.save.mockRejectedValueOnce(new Error("disk"));
    await expect(transcript.branchFrom(1)).rejects.toMatchObject({ operation: "resend_branch" });
    expect(transcript.snapshot()).toBe(before);
  });

  it("reloads the durable snapshot during recovery", async () => {
    const { port, durable } = storage({ chat: { version: 1, messages: [user("u1")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    durable.set("chat", { version: 2, messages: [user("u1"), assistant("a1")] });
    await expect(transcript.recover()).resolves.toMatchObject({ version: 2, messages: [user("u1"), assistant("a1")] });
  });

  it("keeps the prior accepted snapshot when recovery storage fails", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    const before = transcript.snapshot();
    port.load.mockRejectedValueOnce(new Error("offline"));
    await expect(transcript.recover()).rejects.toMatchObject({ code: "chat_persistence_failed", chatId: "chat" });
    expect(transcript.snapshot()).toBe(before);
  });

  it("can recover a durable first-message branch after restart", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1")] } });
    const transcript = await ChatTranscript.load(port, "chat", () => new Date(2026, 6, 10, 12, 34, 56));
    const branch = await transcript.branchFrom(0);
    const restarted = await ChatTranscript.load(port, branch.chatId);
    expect(restarted.snapshot()).toEqual(branch);
  });

  it("repeated loads return independent immutable views of the same durable data", async () => {
    const { port } = storage({ chat: { version: 1, messages: [user("u1")] } });
    const first = await ChatTranscript.load(port, "chat");
    const second = await ChatTranscript.load(port, "chat");
    expect(second.snapshot()).toEqual(first.snapshot());
    expect(second.snapshot()).not.toBe(first.snapshot());
  });

  it("opens unsupported future data read-only", async () => {
    const { port } = storage({ chat: { version: 99, messages: [user("u1")], readOnly: true } });
    const transcript = await ChatTranscript.load(port, "chat");
    expect(transcript.snapshot().readOnly).toBe(true);
    await expect(transcript.commit(transcript.candidateUser(user("u2")))).rejects.toBeInstanceOf(ChatTranscriptReadOnlyError);
  });

  it("prevents branching unsupported future data", async () => {
    const { port } = storage({ chat: { version: 99, messages: [user("u1")], readOnly: true } });
    const transcript = await ChatTranscript.load(port, "chat");
    await expect(transcript.branchFrom(0)).rejects.toBeInstanceOf(ChatTranscriptReadOnlyError);
    expect(port.createExclusive).not.toHaveBeenCalled();
  });

  it("recovery can move an accepted transcript into read-only mode atomically", async () => {
    const { port, durable } = storage({ chat: { version: 1, messages: [user("u1")] } });
    const transcript = await ChatTranscript.load(port, "chat");
    durable.set("chat", { version: 99, messages: [user("future")], readOnly: true });
    await expect(transcript.recover()).resolves.toMatchObject({ readOnly: true, messages: [user("future")] });
  });
});
