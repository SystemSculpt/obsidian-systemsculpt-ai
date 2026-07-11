import type { ChatMessage } from "../../../types";
import { ChatPersistenceError } from "../persistence/ChatPersistenceError";
import { ChatTranscript } from "../transcript/ChatTranscript";
import type { ChatTranscriptStorage } from "../transcript/ChatTranscriptStorage";
import type { ChatTranscriptSnapshot } from "../transcript/ChatTranscriptTypes";

function message(message_id: string, role: "user" | "assistant" | "tool", content = message_id): ChatMessage {
  return { message_id, role, content } as ChatMessage;
}

function storage(): jest.Mocked<ChatTranscriptStorage> {
  return {
    load: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({ version: 1 }),
    createExclusive: jest.fn().mockResolvedValue({ version: 1 }),
  };
}

const fixedNow = () => new Date(2026, 6, 10, 12, 34, 56);

function assertReadonlySnapshot(value: ChatTranscriptSnapshot): void {
  // @ts-expect-error snapshots expose no mutable message array
  value.messages.push(message("illegal", "user"));
  // @ts-expect-error snapshot identity is readonly
  value.chatId = "other";
}
void assertReadonlySnapshot;

describe("ChatTranscript", () => {
  it("loads an empty transcript", async () => {
    const transcript = await ChatTranscript.load(storage(), "");

    expect(transcript.snapshot()).toEqual({ chatId: "", version: 0, messages: [] });
  });

  it("loads an existing immutable snapshot", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 4, messages: [message("u1", "user")] });

    const transcript = await ChatTranscript.load(port, "chat-1");

    expect(transcript.snapshot()).toEqual({ chatId: "chat-1", version: 4, messages: [message("u1", "user")] });
    expect(Object.isFrozen(transcript.snapshot())).toBe(true);
    expect(Object.isFrozen(transcript.snapshot().messages)).toBe(true);
  });

  it("builds and commits a user candidate without changing the accepted snapshot early", async () => {
    const port = storage();
    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();
    const candidate = transcript.candidateUser(message("u1", "user"));

    expect(transcript.snapshot()).toBe(accepted);
    expect(candidate.messages).toEqual([message("u1", "user")]);
    await expect(transcript.commit(candidate)).resolves.toMatchObject({ chatId: "chat-1", version: 1 });
    expect(port.save).toHaveBeenCalledWith("chat-1", candidate.messages);
  });

  it("builds an assistant candidate that replaces the same message id", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: [message("a1", "assistant", "draft")] });
    const transcript = await ChatTranscript.load(port, "chat-1");

    const candidate = transcript.candidateAssistant(message("a1", "assistant", "final"));

    expect(candidate.messages).toEqual([message("a1", "assistant", "final")]);
    expect(candidate.operation).toBe("assistant_commit");
  });

  it("builds a tool checkpoint candidate", async () => {
    const transcript = await ChatTranscript.load(storage(), "chat-1");
    const tool = message("t1", "tool", "result");

    const candidate = transcript.candidateTools(tool);

    expect(candidate).toMatchObject({ operation: "tool_checkpoint", messages: [tool] });
  });

  it("does not append a duplicate user message id", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: [message("u1", "user", "original")] });
    const transcript = await ChatTranscript.load(port, "chat-1");

    const candidate = transcript.candidateUser(message("u1", "user", "duplicate"));

    expect(candidate.messages).toEqual([message("u1", "user", "original")]);
  });

  it("merges tool updates by id and preserves an existing result", async () => {
    const port = storage();
    const original = {
      ...message("a1", "assistant"),
      tool_calls: [{ id: "call-1", name: "read", arguments: {}, result: { success: true, data: "kept" } }],
    } as ChatMessage;
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: [original] });
    const transcript = await ChatTranscript.load(port, "chat-1");

    const candidate = transcript.candidateTools({
      ...message("a1", "assistant"),
      tool_calls: [
        { id: "call-1", name: "read", arguments: { path: "a" } },
        { id: "call-2", name: "write", arguments: {} },
      ],
    } as ChatMessage);

    expect(candidate.messages[0].tool_calls).toEqual([
      { id: "call-1", name: "read", arguments: { path: "a" }, result: { success: true, data: "kept" } },
      { id: "call-2", name: "write", arguments: {} },
    ]);
  });

  it("persists a middle branch under the existing chat identity", async () => {
    const port = storage();
    port.load.mockResolvedValue({
      chatId: "chat-1",
      version: 2,
      messages: [message("u1", "user"), message("a1", "assistant"), message("u2", "user")],
    });
    port.save.mockResolvedValue({ version: 3 });
    const transcript = await ChatTranscript.load(port, "chat-1");

    const branched = await transcript.branchFrom(2);

    expect(branched).toEqual({ chatId: "chat-1", version: 3, messages: [message("u1", "user"), message("a1", "assistant")] });
    expect(port.save).toHaveBeenCalledWith("chat-1", branched.messages);
  });

  it("atomically allocates a new identity for a first-message branch", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 2, messages: [message("u1", "user")] });
    port.createExclusive.mockResolvedValueOnce(null).mockResolvedValueOnce({ version: 1 });
    const transcript = await ChatTranscript.load(port, "chat-1", fixedNow);

    const branched = await transcript.branchFrom(0);

    expect(branched).toEqual({ chatId: "2026-07-10 12-34-56-2", version: 1, messages: [] });
    expect(port.createExclusive.mock.calls.map(([id]) => id)).toEqual([
      "2026-07-10 12-34-56",
      "2026-07-10 12-34-56-2",
    ]);
  });

  it("leaves snapshot identity unchanged when a user commit fails", async () => {
    const port = storage();
    port.save.mockRejectedValue(new Error("disk"));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();

    await expect(transcript.commit(transcript.candidateUser(message("u1", "user")))).rejects.toMatchObject({
      code: "chat_persistence_failed",
      operation: "user_commit",
      chatId: "chat-1",
    });
    expect(transcript.snapshot()).toBe(accepted);
  });

  it("leaves snapshot identity unchanged when an assistant commit fails", async () => {
    const port = storage();
    port.save.mockRejectedValue(new Error("disk"));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();

    await expect(transcript.commit(transcript.candidateAssistant(message("a1", "assistant")))).rejects.toBeInstanceOf(ChatPersistenceError);
    expect(transcript.snapshot()).toBe(accepted);
  });

  it("leaves snapshot identity unchanged when a tool checkpoint fails", async () => {
    const port = storage();
    port.save.mockRejectedValue(new Error("disk"));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();

    await expect(transcript.commit(transcript.candidateTools(message("t1", "tool")))).rejects.toMatchObject({ operation: "tool_checkpoint" });
    expect(transcript.snapshot()).toBe(accepted);
  });

  it("leaves snapshot identity unchanged when branch persistence fails", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: [message("u1", "user"), message("a1", "assistant")] });
    port.save.mockRejectedValue(new Error("disk"));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();

    await expect(transcript.branchFrom(1)).rejects.toMatchObject({ operation: "resend_branch" });
    expect(transcript.snapshot()).toBe(accepted);
  });

  it("recovers the accepted projection from durable storage", async () => {
    const port = storage();
    port.load
      .mockResolvedValueOnce({ chatId: "chat-1", version: 1, messages: [message("u1", "user")] })
      .mockResolvedValueOnce({ chatId: "chat-1", version: 7, messages: [message("u1", "user"), message("a1", "assistant")] });
    const transcript = await ChatTranscript.load(port, "chat-1");

    const recovered = await transcript.recover();

    expect(recovered).toEqual({ chatId: "chat-1", version: 7, messages: [message("u1", "user"), message("a1", "assistant")] });
    expect(transcript.snapshot()).toBe(recovered);
  });

  it("reloads the same durable transcript into an independent immutable projection", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 3, messages: [message("u1", "user")] });

    const first = await ChatTranscript.load(port, "chat-1");
    const second = await ChatTranscript.load(port, "chat-1");

    expect(second.snapshot()).toEqual(first.snapshot());
    expect(second.snapshot()).not.toBe(first.snapshot());
    expect(second.snapshot().messages).not.toBe(first.snapshot().messages);
  });

  it("shares one existing-chat write and snapshot across concurrent commits of the same candidate", async () => {
    const port = storage();
    let release!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const candidate = transcript.candidateUser(message("u1", "user"));

    const first = transcript.commit(candidate);
    const concurrent = transcript.commit(candidate);

    expect(concurrent).toBe(first);
    expect(port.save).toHaveBeenCalledTimes(1);
    release({ version: 2 });
    const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
    expect(concurrentSnapshot).toBe(firstSnapshot);
  });

  it("shares one allocation across concurrent commits for a new transcript", async () => {
    const port = storage();
    let release!: (value: { version: number }) => void;
    port.createExclusive.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "", fixedNow);
    const candidate = transcript.candidateUser(message("u1", "user"));

    const first = transcript.commit(candidate);
    const concurrent = transcript.commit(candidate);

    expect(concurrent).toBe(first);
    expect(port.createExclusive).toHaveBeenCalledTimes(1);
    release({ version: 1 });
    const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
    expect(concurrentSnapshot).toBe(firstSnapshot);
  });

  it("shares one write across concurrent middle branches", async () => {
    const port = storage();
    port.load.mockResolvedValue({
      chatId: "chat-1",
      version: 1,
      messages: [message("u1", "user"), message("a1", "assistant")],
    });
    let release!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");

    const first = transcript.branchFrom(1);
    const concurrent = transcript.branchFrom(1);

    expect(concurrent).toBe(first);
    expect(port.save).toHaveBeenCalledTimes(1);
    release({ version: 2 });
    const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
    expect(concurrentSnapshot).toBe(firstSnapshot);
  });

  it("shares one allocation across concurrent first-message branches", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: [message("u1", "user")] });
    let release!: (value: { version: number }) => void;
    port.createExclusive.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1", fixedNow);

    const first = transcript.branchFrom(0);
    const concurrent = transcript.branchFrom(0);

    expect(concurrent).toBe(first);
    expect(port.createExclusive).toHaveBeenCalledTimes(1);
    release({ version: 1 });
    const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
    expect(concurrentSnapshot).toBe(firstSnapshot);
  });

  it("clears failed in-flight ownership so retry performs exactly one new write", async () => {
    const port = storage();
    let rejectFirst!: (error: Error) => void;
    port.save
      .mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ version: 2 });
    const transcript = await ChatTranscript.load(port, "chat-1");
    const candidate = transcript.candidateUser(message("u1", "user"));

    const first = transcript.commit(candidate);
    const concurrent = transcript.commit(candidate);
    rejectFirst(new Error("disk"));
    await expect(first).rejects.toMatchObject({ operation: "user_commit" });
    await expect(concurrent).rejects.toMatchObject({ operation: "user_commit" });

    await expect(transcript.commit(candidate)).resolves.toMatchObject({ version: 2 });
    expect(port.save).toHaveBeenCalledTimes(2);
  });

  it("deeply clones and recursively freezes loaded snapshots without storage aliases", async () => {
    const port = storage();
    const nested = {
      ...message("a1", "assistant"),
      content: [{ type: "text", text: "original" }],
      reasoning: { steps: [{ text: "reason" }] },
      annotations: [{ source: { path: "note.md" } }],
      tool_calls: [{
        id: "call-1",
        name: "read",
        arguments: { paths: ["a.md"] },
        result: { success: true, data: { rows: [{ value: 1 }] } },
      }],
      documentContext: { files: [{ path: "context.md", ranges: [[1, 2]] }] },
    } as unknown as ChatMessage;
    const loadedMessages = [nested];
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: loadedMessages });

    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();
    (nested as any).tool_calls[0].result.data.rows[0].value = 99;
    (nested as any).content[0].text = "mutated";
    loadedMessages.push(message("u2", "user"));

    expect((accepted.messages[0] as any).tool_calls[0].result.data.rows[0].value).toBe(1);
    expect((accepted.messages[0] as any).content[0].text).toBe("original");
    expect(accepted.messages).toHaveLength(1);
    expect(Object.isFrozen((accepted.messages[0] as any).tool_calls[0].result.data.rows)).toBe(true);
    expect(Object.isFrozen((accepted.messages[0] as any).annotations[0].source)).toBe(true);
    expect(Object.isFrozen((accepted.messages[0] as any).documentContext.files[0].ranges[0])).toBe(true);
  });

  it("isolates pending candidates and committed snapshots from caller and storage mutation", async () => {
    const port = storage();
    let release!: (value: { version: number }) => void;
    let storageInput!: readonly ChatMessage[];
    port.save.mockImplementation((_chatId, messages) => {
      storageInput = messages;
      (messages[0] as any).tool_calls[0].result.data.value = "storage-mutated";
      return new Promise((resolve) => { release = resolve; });
    });
    const transcript = await ChatTranscript.load(port, "chat-1");
    const callerMessage = {
      ...message("a1", "assistant"),
      tool_calls: [{
        id: "call-1",
        name: "read",
        arguments: { paths: ["a.md"] },
        result: { success: true, data: { value: "original" } },
      }],
    } as unknown as ChatMessage;
    const candidate = transcript.candidateTools(callerMessage);

    const pending = transcript.commit(candidate);
    (callerMessage as any).tool_calls[0].result.data.value = "caller-mutated";
    expect(() => {
      (candidate.messages[0] as any).tool_calls[0].result.data.value = "candidate-mutated";
    }).toThrow();
    expect((storageInput[0] as any).tool_calls[0].result.data.value).toBe("storage-mutated");
    expect((candidate.messages[0] as any).tool_calls[0].result.data.value).toBe("original");

    release({ version: 2 });
    const committed = await pending;
    expect((committed.messages[0] as any).tool_calls[0].result.data.value).toBe("original");
    expect(committed.messages[0]).not.toBe(candidate.messages[0]);
    expect(committed.messages[0]).not.toBe(storageInput[0]);
  });

  it("wraps initial load failure with the exact typed persistence contract", async () => {
    const port = storage();
    const cause = new Error("read failed");
    port.load.mockRejectedValue(cause);

    await expect(ChatTranscript.load(port, "chat-load")).rejects.toMatchObject({
      code: "chat_persistence_failed",
      operation: "flush",
      chatId: "chat-load",
      cause,
    });
  });

  it("wraps recovery load failure with the exact typed persistence contract", async () => {
    const port = storage();
    const cause = new Error("recovery read failed");
    port.load
      .mockResolvedValueOnce({ chatId: "chat-recover", version: 1, messages: [] })
      .mockRejectedValueOnce(cause);
    const transcript = await ChatTranscript.load(port, "chat-recover");

    await expect(transcript.recover()).rejects.toMatchObject({
      code: "chat_persistence_failed",
      operation: "flush",
      chatId: "chat-recover",
      cause,
    });
  });

  it("serializes distinct new-transcript candidates so only the winner allocates", async () => {
    const port = storage();
    let release!: (value: { version: number }) => void;
    port.createExclusive.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "", fixedNow);
    const firstCandidate = transcript.candidateUser(message("u1", "user"));
    const secondCandidate = transcript.candidateUser(message("u2", "user"));

    const first = transcript.commit(firstCandidate);
    const second = transcript.commit(secondCandidate);
    expect(port.createExclusive).toHaveBeenCalledTimes(1);
    release({ version: 1 });

    const winner = await first;
    await expect(second).rejects.toMatchObject({
      code: "chat_persistence_failed",
      operation: "user_commit",
      cause: { code: "chat_transcript_stale_transition" },
    });
    expect(port.createExclusive).toHaveBeenCalledTimes(1);
    expect(transcript.snapshot()).toBe(winner);
    expect(winner.messages).toEqual([message("u1", "user")]);
  });

  it("prevents distinct existing commits from completing out of order", async () => {
    const port = storage();
    let release!: (value: { version: number }) => void;
    let latestDurable: ChatMessage[] = [];
    port.save.mockImplementation((_chatId, messages) => {
      latestDurable = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
      return new Promise((resolve) => { release = resolve; });
    });
    const transcript = await ChatTranscript.load(port, "chat-1");
    const first = transcript.commit(transcript.candidateUser(message("u1", "user")));
    const second = transcript.commit(transcript.candidateUser(message("u2", "user")));

    expect(port.save).toHaveBeenCalledTimes(1);
    release({ version: 2 });
    const winner = await first;
    await expect(second).rejects.toMatchObject({ cause: { code: "chat_transcript_stale_transition" } });
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(transcript.snapshot()).toBe(winner);
    expect(transcript.snapshot().messages).toEqual(latestDurable);
  });

  it("serializes a commit-versus-branch race against their shared base", async () => {
    const port = storage();
    port.load.mockResolvedValue({ chatId: "chat-1", version: 1, messages: [message("u0", "user")] });
    let release!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");

    const commit = transcript.commit(transcript.candidateAssistant(message("a1", "assistant")));
    const branch = transcript.branchFrom(0);
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(port.createExclusive).not.toHaveBeenCalled();
    release({ version: 2 });

    const winner = await commit;
    await expect(branch).rejects.toMatchObject({
      operation: "resend_branch",
      cause: { code: "chat_transcript_stale_transition" },
    });
    expect(port.createExclusive).not.toHaveBeenCalled();
    expect(transcript.snapshot()).toBe(winner);
  });

  it("serializes distinct branch races against their shared base", async () => {
    const port = storage();
    port.load.mockResolvedValue({
      chatId: "chat-1",
      version: 1,
      messages: [message("u1", "user"), message("a1", "assistant"), message("u2", "user")],
    });
    let release!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");

    const first = transcript.branchFrom(2);
    const second = transcript.branchFrom(1);
    expect(port.save).toHaveBeenCalledTimes(1);
    release({ version: 2 });

    const winner = await first;
    await expect(second).rejects.toMatchObject({
      operation: "resend_branch",
      cause: { code: "chat_transcript_stale_transition" },
    });
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(transcript.snapshot()).toBe(winner);
  });

  it("allows a queued distinct transition after the first transition fails", async () => {
    const port = storage();
    let rejectFirst!: (error: Error) => void;
    port.save
      .mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ version: 2 });
    const transcript = await ChatTranscript.load(port, "chat-1");
    const accepted = transcript.snapshot();
    const first = transcript.commit(transcript.candidateUser(message("u1", "user")));
    const second = transcript.commit(transcript.candidateUser(message("u2", "user")));

    expect(port.save).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("first failed"));
    await expect(first).rejects.toMatchObject({ operation: "user_commit" });
    const winner = await second;

    expect(port.save).toHaveBeenCalledTimes(2);
    expect(transcript.snapshot()).not.toBe(accepted);
    expect(transcript.snapshot()).toBe(winner);
    expect(winner.messages).toEqual([message("u2", "user")]);
  });

  it("queues recovery behind an active commit and loads its latest durable state", async () => {
    const port = storage();
    port.load
      .mockResolvedValueOnce({ chatId: "chat-1", version: 1, messages: [] })
      .mockResolvedValueOnce({ chatId: "chat-1", version: 2, messages: [message("u1", "user")] });
    let releaseSave!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");

    const commit = transcript.commit(transcript.candidateUser(message("u1", "user")));
    const recovery = transcript.recover();
    expect(port.load).toHaveBeenCalledTimes(1);
    releaseSave({ version: 2 });

    await commit;
    const recovered = await recovery;
    expect(port.load).toHaveBeenCalledTimes(2);
    expect(transcript.snapshot()).toBe(recovered);
    expect(recovered).toEqual({ chatId: "chat-1", version: 2, messages: [message("u1", "user")] });
  });

  it("queues recovery behind an active branch and converges on its durable state", async () => {
    const port = storage();
    port.load
      .mockResolvedValueOnce({
        chatId: "chat-1",
        version: 1,
        messages: [message("u1", "user"), message("a1", "assistant")],
      })
      .mockResolvedValueOnce({ chatId: "chat-1", version: 2, messages: [message("u1", "user")] });
    let releaseSave!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");

    const branch = transcript.branchFrom(1);
    const recovery = transcript.recover();
    expect(port.load).toHaveBeenCalledTimes(1);
    releaseSave({ version: 2 });

    await branch;
    const recovered = await recovery;
    expect(recovered.messages).toEqual([message("u1", "user")]);
    expect(transcript.snapshot()).toBe(recovered);
  });

  it("continues to queued recovery after an intervening transition becomes stale", async () => {
    const port = storage();
    port.load
      .mockResolvedValueOnce({ chatId: "chat-1", version: 1, messages: [] })
      .mockResolvedValueOnce({ chatId: "chat-1", version: 2, messages: [message("u1", "user")] });
    let releaseSave!: (value: { version: number }) => void;
    port.save.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const first = transcript.commit(transcript.candidateUser(message("u1", "user")));
    const stale = transcript.commit(transcript.candidateUser(message("u2", "user")));
    const recovery = transcript.recover();

    releaseSave({ version: 2 });
    await first;
    await expect(stale).rejects.toMatchObject({ cause: { code: "chat_transcript_stale_transition" } });
    const recovered = await recovery;

    expect(port.save).toHaveBeenCalledTimes(1);
    expect(port.load).toHaveBeenCalledTimes(2);
    expect(transcript.snapshot()).toBe(recovered);
    expect(recovered.messages).toEqual([message("u1", "user")]);
  });

  it("lets a queued commit proceed when recovery fails without changing its base", async () => {
    const port = storage();
    const recoveryCause = new Error("recovery failed");
    port.load
      .mockResolvedValueOnce({ chatId: "chat-1", version: 1, messages: [] })
      .mockRejectedValueOnce(recoveryCause);
    port.save.mockResolvedValue({ version: 2 });
    const transcript = await ChatTranscript.load(port, "chat-1");
    const candidate = transcript.candidateUser(message("u1", "user"));

    const recovery = transcript.recover();
    const commit = transcript.commit(candidate);

    await expect(recovery).rejects.toMatchObject({ cause: recoveryCause });
    const committed = await commit;
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(transcript.snapshot()).toBe(committed);
    expect(committed.messages).toEqual([message("u1", "user")]);
  });

  it("makes a transition queued behind successful recovery reject as stale", async () => {
    const port = storage();
    let releaseRecovery!: (value: { chatId: string; version: number; messages: ChatMessage[] }) => void;
    port.load
      .mockResolvedValueOnce({ chatId: "chat-1", version: 1, messages: [] })
      .mockReturnValueOnce(new Promise((resolve) => { releaseRecovery = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");
    const candidate = transcript.candidateUser(message("u1", "user"));

    const recovery = transcript.recover();
    const commit = transcript.commit(candidate);
    releaseRecovery({ chatId: "chat-1", version: 2, messages: [message("remote", "assistant")] });

    const recovered = await recovery;
    await expect(commit).rejects.toMatchObject({ cause: { code: "chat_transcript_stale_transition" } });
    expect(port.save).not.toHaveBeenCalled();
    expect(transcript.snapshot()).toBe(recovered);
  });

  it("deduplicates concurrent recovery calls into one durable load", async () => {
    const port = storage();
    port.load.mockResolvedValueOnce({ chatId: "chat-1", version: 1, messages: [] });
    let releaseRecovery!: (value: { chatId: string; version: number; messages: ChatMessage[] }) => void;
    port.load.mockReturnValueOnce(new Promise((resolve) => { releaseRecovery = resolve; }));
    const transcript = await ChatTranscript.load(port, "chat-1");

    const first = transcript.recover();
    const concurrent = transcript.recover();

    expect(concurrent).toBe(first);
    expect(port.load).toHaveBeenCalledTimes(2);
    releaseRecovery({ chatId: "chat-1", version: 2, messages: [message("u1", "user")] });
    const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
    expect(concurrentSnapshot).toBe(firstSnapshot);
  });

  it("returns the committed snapshot on idempotent retry without writing twice", async () => {
    const port = storage();
    const transcript = await ChatTranscript.load(port, "", fixedNow);
    const candidate = transcript.candidateUser(message("u1", "user"));

    const first = await transcript.commit(candidate);
    const retry = await transcript.commit(candidate);

    expect(retry).toBe(first);
    expect(port.createExclusive).toHaveBeenCalledTimes(1);
  });
});
