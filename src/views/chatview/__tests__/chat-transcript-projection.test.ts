import type { ChatMessage } from "../../../types";
import { ChatTranscript } from "../transcript/ChatTranscript";
import type { ChatTranscriptStorage } from "../transcript/ChatTranscriptStorage";

const message = (id: string, role: ChatMessage["role"] = "user", content = id): ChatMessage => ({
  message_id: id,
  role,
  content,
});

function harness(initial: ChatMessage[]) {
  let durable = initial.map((entry) => ({ ...entry }));
  let version = 1;
  let failSave = false;
  const storage: ChatTranscriptStorage = {
    load: async (chatId) => ({ chatId, version, messages: durable }),
    save: async (_chatId, messages) => {
      if (failSave) throw new Error("disk full");
      durable = messages.map((entry) => ({ ...entry })) as ChatMessage[];
      version += 1;
      return { version };
    },
    createExclusive: async () => ({ version }),
  };
  return {
    transcript: ChatTranscript.fromSnapshot(storage, { chatId: "chat", version, messages: initial }),
    durable: () => durable,
    failNextSave: () => { failSave = true; },
  };
}

describe("ChatTranscript projection ownership", () => {
  it("durably removes a failed submitted turn before changing the accepted snapshot", async () => {
    const state = harness([message("kept"), message("failed")]);

    await state.transcript.commit(state.transcript.candidateDeleteMessage("failed"));

    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["kept"]);
    expect(state.durable().map((entry) => entry.message_id)).toEqual(["kept"]);
  });

  it("keeps the accepted and durable transcript when failed-turn rollback cannot save", async () => {
    const state = harness([message("kept"), message("failed")]);
    state.failNextSave();

    await expect(state.transcript.commit(state.transcript.candidateDeleteMessage("failed"))).rejects.toThrow("disk full");

    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["kept", "failed"]);
    expect(state.durable().map((entry) => entry.message_id)).toEqual(["kept", "failed"]);
  });

  it("keeps Pi hydration pending until save succeeds and retry cannot revive stale messages", async () => {
    const state = harness([message("old")]);
    const next = [message("pi-user"), message("pi-answer", "assistant")];
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ version: 2 });

    await expect(state.transcript.commitPiReplacement(next, persist)).rejects.toThrow("disk full");
    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["old"]);

    await state.transcript.commitPiReplacement(next, persist);
    await state.transcript.commit(state.transcript.candidateAssistant(message("next", "assistant")));

    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["pi-user", "pi-answer", "next"]);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("keeps a Pi fork pending until save succeeds and retries from the prior branch", async () => {
    const state = harness([message("one"), message("fork"), message("answer", "assistant")]);
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ version: 2 });

    await expect(state.transcript.commitPiFork("fork", persist)).rejects.toThrow("disk full");
    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["one", "fork", "answer"]);

    await state.transcript.commitPiFork("fork", persist);
    await state.transcript.commit(state.transcript.candidateAssistant(message("new-answer", "assistant")));

    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["one", "new-answer"]);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("clears chat identity and projection for slash clear", () => {
    const state = harness([message("one")]);

    state.transcript.clear();

    expect(state.transcript.snapshot()).toMatchObject({ chatId: "", version: 0, messages: [] });
  });

  it("clears projection during teardown", () => {
    const state = harness([message("one")]);

    state.transcript.teardown();

    expect(state.transcript.snapshot().messages).toEqual([]);
  });

  it("upserts preview assistant state through a named transcript operation", () => {
    const state = harness([message("assistant", "assistant", "partial")]);

    state.transcript.previewAssistant(message("assistant", "assistant", "complete"));

    expect(state.transcript.snapshot().messages[0].content).toBe("complete");
  });

  it("returns deeply readonly snapshots to render and export consumers", () => {
    const state = harness([message("one")]);
    const accepted = state.transcript.snapshot();

    expect(Object.isFrozen(accepted.messages)).toBe(true);
    expect(Object.isFrozen(accepted.messages[0])).toBe(true);
    expect(() => (accepted.messages as ChatMessage[]).push(message("two"))).toThrow();
  });

  it("does not expose mutable message clones", () => {
    const state = harness([message("one")]);
    const accepted = state.transcript.snapshot();
    const consumerCopy = [...accepted.messages];

    consumerCopy.splice(0, 1);

    expect(state.transcript.snapshot().messages).toHaveLength(1);
  });

  it("rejects a Pi fork whose selected message is absent", async () => {
    const state = harness([message("one")]);

    await expect(state.transcript.commitPiFork("missing", async () => ({ version: 2 })))
      .rejects.toThrow("selected for forking");
    expect(state.transcript.snapshot().messages.map((entry) => entry.message_id)).toEqual(["one"]);
  });
});
