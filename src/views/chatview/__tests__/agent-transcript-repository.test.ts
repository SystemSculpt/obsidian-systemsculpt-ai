import type { ChatMessage } from "../../../types";
import { AgentTranscriptConflictError, AgentTranscriptRepository } from "../AgentTranscriptRepository";

function user(id: string, content = id): ChatMessage {
  return { role: "user", content, message_id: id };
}

function assistant(id: string, content = id): ChatMessage {
  return { role: "assistant", content, message_id: id };
}

function createHarness() {
  const records = new Map<string, any>();
  const storage = {
    loadChat: jest.fn(async (id: string) => records.get(id) ?? null),
    createChatExclusive: jest.fn(async (id: string, messages: ChatMessage[], options: any) => {
      if (records.has(id)) return null;
      records.set(id, {
        id,
        title: options.title,
        version: 1,
        chatBackend: "systemsculpt",
        messages,
        context_files: [],
        managedSession: options.managedSession,
      });
      return { version: 1 };
    }),
    saveChat: jest.fn(async (id: string, messages: ChatMessage[], options: any) => {
      const previous = records.get(id);
      const version = (previous?.version ?? 0) + 1;
      records.set(id, {
        ...previous,
        id,
        title: options.title,
        version,
        chatBackend: previous?.chatBackend ?? "systemsculpt",
        messages,
        managedSession: options.managedSession,
      });
      return { version };
    }),
  };
  const repository = new AgentTranscriptRepository(storage as any, () => ({
    title: "ignored",
    contextFiles: new Set(["[[Project.md]]"]),
    chatFontSize: "medium",
  }));
  return { records, repository, storage };
}

describe("AgentTranscriptRepository", () => {
  const sessionId = "mchat_0123456789abcdef0123456789abcdef";
  const toolsetFingerprint = "2:741638a5:5967d5";
  const budget = Object.freeze({
    messageCount: 2,
    imageCount: 0,
    attachmentBytes: 0,
    storedJsonBytes: 256,
  });

  it("allocates the chat on the first durable user turn and serializes assistant checkpoints", async () => {
    const { repository, storage } = createHarness();
    const commits: Array<{ role: string; messageId: string; version: number }> = [];
    repository.subscribeToCommits(({ role, messageId, snapshot }) => {
      commits.push({ role, messageId, version: snapshot.version });
    });
    repository.setTitle("Project work");
    const accepted = await repository.commitUser({ kind: "append", message: user("u1", "Update Project.md") });
    expect(accepted.chatId).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(accepted.version).toBe(1);
    expect(storage.createChatExclusive).toHaveBeenCalledTimes(1);

    const firstAssistant = assistant("a1", "Working");
    firstAssistant.tool_calls = [{
      id: "call-1",
      messageId: "a1",
      request: { id: "call-1", type: "function", function: { name: "edit", arguments: "{}" } },
      state: "executing",
      timestamp: 1,
    }];
    await repository.persistAssistant(firstAssistant);
    const completed = assistant("a1", "Done");
    completed.tool_calls = [{
      ...firstAssistant.tool_calls[0],
      state: "completed",
      result: { success: true, data: { path: "Project.md" } },
    }];
    const final = await repository.persistAssistant(completed);

    expect(final.messages).toHaveLength(2);
    expect(final.messages[1]).toMatchObject({ content: "Done" });
    expect(final.messages[1].tool_calls?.[0]).toMatchObject({ state: "completed", result: { success: true } });
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(commits).toEqual([
      { role: "user", messageId: "u1", version: 1 },
      { role: "assistant", messageId: "a1", version: 2 },
      { role: "assistant", messageId: "a1", version: 3 },
    ]);
  });

  it("does not let a transcript observer invalidate a completed durable commit", async () => {
    const { repository } = createHarness();
    const healthy = jest.fn();
    repository.subscribeToCommits(() => { throw new Error("renderer failed"); });
    repository.subscribeToCommits(healthy);

    await expect(repository.commitUser({ kind: "append", message: user("u1") }))
      .resolves.toMatchObject({ messages: [expect.objectContaining({ message_id: "u1" })] });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("branches a retry only from the exact durable user/version pair", async () => {
    const { repository, records } = createHarness();
    records.set("chat-1", {
      id: "chat-1",
      title: "Chat",
      version: 4,
      chatBackend: "systemsculpt",
      messages: [user("u1"), assistant("a1"), user("u2"), assistant("a2")],
      context_files: [],
    });
    await repository.load("chat-1");

    const retried = await repository.commitUser({
      kind: "resend",
      message: user("u3", "Try again"),
      targetMessageId: "u2",
      expectedIndex: 2,
      expectedVersion: 4,
    });
    expect(retried.messages.map((message) => message.message_id)).toEqual(["u1", "a1", "u3"]);

    await expect(repository.commitUser({
      kind: "resend",
      message: user("u4"),
      targetMessageId: "u1",
      expectedIndex: 0,
      expectedVersion: 4,
    })).rejects.toBeInstanceOf(AgentTranscriptConflictError);
  });

  it("atomically persists assistant content with its server checkpoint and clears it on resend", async () => {
    const { repository, records, storage } = createHarness();
    const accepted = await repository.commitUser({ kind: "append", message: user("u1") });
    const committed = await repository.persistAssistantWithSession(
      assistant("a1", "Done"),
      { id: sessionId, revision: 1 },
      toolsetFingerprint,
      budget,
    );

    expect(committed.managedSession).toEqual({
      id: sessionId,
      revision: 1,
      boundChatId: accepted.chatId,
      checkpointMessageId: "a1",
      toolsetFingerprint,
      budget,
    });
    expect(records.get(accepted.chatId)).toMatchObject({
      messages: [expect.objectContaining({ message_id: "u1" }), expect.objectContaining({ message_id: "a1" })],
      managedSession: { id: sessionId, revision: 1, checkpointMessageId: "a1" },
    });
    expect(storage.saveChat).toHaveBeenCalledTimes(1);

    const resent = await repository.commitUser({
      kind: "resend",
      message: user("u2", "Again"),
      targetMessageId: "u1",
      expectedIndex: 0,
      expectedVersion: committed.version,
    });
    expect(resent.managedSession).toBeUndefined();
    expect(records.get(accepted.chatId).managedSession).toBeUndefined();
  });

  it("restores only a final clean assistant anchor and durably removes stale bindings", async () => {
    const valid = createHarness();
    valid.records.set("valid", {
      id: "valid",
      title: "Valid",
      version: 2,
      chatBackend: "systemsculpt",
      messages: [user("u1"), assistant("a1")],
      context_files: [],
      managedSession: {
        id: sessionId,
        revision: 1,
        boundChatId: "valid",
        checkpointMessageId: "a1",
        toolsetFingerprint,
        budget,
      },
    });
    await expect(valid.repository.load("valid")).resolves.toMatchObject({
      managedSession: { id: sessionId, checkpointMessageId: "a1" },
    });
    expect(valid.storage.saveChat).not.toHaveBeenCalled();

    const budgetless = createHarness();
    budgetless.records.set("budgetless", {
      id: "budgetless",
      title: "Budgetless",
      version: 2,
      chatBackend: "systemsculpt",
      messages: [user("u1"), assistant("a1")],
      context_files: [],
      managedSession: {
        id: sessionId,
        revision: 1,
        boundChatId: "budgetless",
        checkpointMessageId: "a1",
        toolsetFingerprint,
      },
    });
    const budgetlessLoaded = await budgetless.repository.load("budgetless");
    expect(budgetlessLoaded?.managedSession).toBeUndefined();
    expect(budgetless.storage.saveChat).toHaveBeenCalledTimes(1);

    const stale = createHarness();
    stale.records.set("stale", {
      id: "stale",
      title: "Stale",
      version: 3,
      chatBackend: "systemsculpt",
      messages: [user("u1"), assistant("a1"), user("u2")],
      context_files: [],
      managedSession: {
        id: sessionId,
        revision: 1,
        boundChatId: "stale",
        checkpointMessageId: "a1",
        toolsetFingerprint,
        budget,
      },
    });
    const loaded = await stale.repository.load("stale");
    expect(loaded?.managedSession).toBeUndefined();
    expect(stale.storage.saveChat).toHaveBeenCalledTimes(1);
    expect(stale.records.get("stale").managedSession).toBeUndefined();
  });

  it("loads legacy transcripts read-only and never rewrites them", async () => {
    const { repository, records, storage } = createHarness();
    records.set("legacy", {
      id: "legacy",
      title: "Legacy",
      version: 9,
      chatBackend: "legacy",
      messages: [user("u1"), assistant("a1")],
      context_files: ["[[Old.md]]"],
      chatFontSize: "large",
    });
    const loaded = await repository.load("legacy");
    expect(loaded).toMatchObject({ backend: "legacy", contextFiles: ["[[Old.md]]"], chatFontSize: "large" });
    await expect(repository.commitUser({ kind: "append", message: user("u2") })).rejects.toThrow("read-only");
    expect(storage.saveChat).not.toHaveBeenCalled();
  });

  it("reconciles a crash-interrupted active tool to an honest unknown outcome", async () => {
    const { repository, records } = createHarness();
    const interrupted = assistant("a1", "Working");
    interrupted.tool_calls = [{
      id: "call-1",
      messageId: "a1",
      request: { id: "call-1", type: "function", function: { name: "move", arguments: "{}" } },
      state: "executing",
      timestamp: 1,
      executionStartedAt: 2,
    }];
    interrupted.messageParts = [{
      id: "part-1",
      type: "tool_call",
      timestamp: 1,
      data: interrupted.tool_calls[0],
    }];
    records.set("current", {
      id: "current",
      title: "Current",
      version: 2,
      chatBackend: "systemsculpt",
      messages: [user("u1"), interrupted],
      context_files: [],
    });

    const loaded = await repository.load("current");

    expect(loaded?.messages[1].tool_calls?.[0]).toMatchObject({
      state: "failed",
      result: { success: false, error: { code: "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART" } },
    });
    expect(loaded?.messages[1].messageParts?.[0].data).toMatchObject({
      state: "failed",
      result: { error: { code: "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART" } },
    });
  });

  it("returns immutable copies so renderers cannot mutate durable state", async () => {
    const { repository } = createHarness();
    const accepted = await repository.commitUser({ kind: "append", message: user("u1") });
    (accepted.messages[0] as ChatMessage).content = "tampered";
    expect(repository.snapshot().messages[0].content).toBe("u1");
  });
});
