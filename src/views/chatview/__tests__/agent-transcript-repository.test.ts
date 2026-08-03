import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { AgentTranscriptConflictError, AgentTranscriptRepository } from "../AgentTranscriptRepository";
import { createTextAttachmentPart } from "../attachments/ChatAttachmentContent";

function user(id: string, content = id): ChatMessage {
  return { role: "user", content, message_id: id };
}

function assistant(id: string, content = id): ChatMessage {
  return { role: "assistant", content, message_id: id };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function projectedServerHistory(
  timestamp: number,
  content = "The plan is ready.",
  path = "Plan.md",
): ChatMessage[] {
  const tool: ToolCall = {
    id: "call-read",
    messageId: "assistant-1",
    request: {
      id: "call-read",
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ paths: ["Plan.md"] }) },
    },
    state: "completed",
    timestamp: timestamp + 1,
    result: { success: true, data: { path } },
  };
  const response = assistant("assistant-1", content);
  response.tool_calls = [tool];
  response.messageParts = [{
    id: "reasoning:assistant-1:0",
    type: "reasoning",
    timestamp,
    data: "Checking the vault.",
  }, {
    id: "tool:call-read",
    type: "tool_call",
    timestamp: timestamp + 1,
    data: { ...tool },
  }, {
    id: "text:assistant-1:2",
    type: "content",
    timestamp: timestamp + 2,
    data: content,
  }];
  return [
    user("user-1", "Check the plan."),
    response,
  ];
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
        messages,
        context_files: [],
        agentConversationId: options.agentConversationId,
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
        messages,
        agentConversationId: options.agentConversationId,
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
  const conversationId = "conversation_0123456789abcdef0123456789abcdef";

  it("allocates on the first user turn and durably upserts assistant output", async () => {
    const { repository, storage } = createHarness();
    const commits: Array<{ role: string; messageId: string; version: number }> = [];
    repository.subscribeToCommits(({ role, messageId, snapshot }) => {
      commits.push({ role, messageId, version: snapshot.version });
    });
    repository.setTitle("Project work");
    const accepted = await repository.commitUser({
      kind: "append",
      message: user("u1", "Update Project.md"),
    });
    expect(accepted.chatId).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(storage.createChatExclusive).toHaveBeenCalledTimes(1);

    const working = assistant("a1", "Working");
    working.tool_calls = [{
      id: "call-1",
      messageId: "a1",
      request: { id: "call-1", type: "function", function: { name: "edit", arguments: "{}" } },
      state: "executing",
      timestamp: 1,
    }];
    await repository.persistAssistant(working);
    const completed = assistant("a1", "Done");
    completed.tool_calls = [{
      ...working.tool_calls[0],
      state: "completed",
      result: { success: true, data: { path: "Project.md" } },
    }];
    const final = await repository.persistAssistant(completed);

    expect(final.messages).toHaveLength(2);
    expect(final.messages[1]).toMatchObject({
      content: "Done",
      tool_calls: [expect.objectContaining({ state: "completed" })],
    });
    expect(commits).toEqual([
      { role: "user", messageId: "u1", version: 1 },
      { role: "assistant", messageId: "a1", version: 2 },
      { role: "assistant", messageId: "a1", version: 3 },
    ]);
  });

  it("preserves same-generation serialization for operations invoked together", async () => {
    const { repository, storage } = createHarness();

    const userCommit = repository.commitUser({
      kind: "append",
      message: user("u1", "Question"),
    }, conversationId);
    const assistantCommit = repository.persistAssistant(
      assistant("a1", "Answer"),
    );

    await expect(userCommit).resolves.toMatchObject({
      messages: [expect.objectContaining({ message_id: "u1" })],
    });
    await expect(assistantCommit).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ message_id: "u1" }),
        expect.objectContaining({ message_id: "a1" }),
      ],
    });
    expect(storage.createChatExclusive).toHaveBeenCalledTimes(1);
    expect(storage.saveChat).toHaveBeenCalledTimes(1);
  });

  it("rejects queued old-chat operations after reset without allocating or writing old history", async () => {
    const { repository, records, storage } = createHarness();
    const oldMessages = [
      user("user-old", "Old question"),
      assistant("assistant-old", "Old answer"),
    ];
    records.set("old-chat", {
      id: "old-chat",
      title: "Old chat",
      version: 5,
      messages: oldMessages,
      context_files: [],
      agentConversationId: conversationId,
    });
    await repository.load("old-chat");

    const writeStarted = deferred<void>();
    const writeResult = deferred<{ version: number }>();
    storage.saveChat.mockImplementationOnce(async () => {
      writeStarted.resolve(undefined);
      return writeResult.promise;
    });
    const inFlightMetadata = repository.saveMetadata();
    await writeStarted.promise;

    const staleHistory = repository.reconcileServerHistory([
      user("user-server-old", "Server old question"),
      assistant("assistant-server-old", "Server old answer"),
    ]);
    const staleUser = repository.commitUser({
      kind: "append",
      message: user("user-late-old", "Late old question"),
    }, conversationId);
    const staleAssistant = repository.persistAssistant(
      assistant("assistant-late-old", "Late old answer"),
    );
    const staleMetadata = repository.saveMetadata();

    const reset = repository.reset({ title: "Fresh chat" });
    const expectedConflicts = [
      expect(inFlightMetadata).rejects.toBeInstanceOf(AgentTranscriptConflictError),
      expect(staleHistory).rejects.toBeInstanceOf(AgentTranscriptConflictError),
      expect(staleUser).rejects.toBeInstanceOf(AgentTranscriptConflictError),
      expect(staleAssistant).rejects.toBeInstanceOf(AgentTranscriptConflictError),
      expect(staleMetadata).rejects.toBeInstanceOf(AgentTranscriptConflictError),
    ];
    writeResult.resolve({ version: 6 });
    await Promise.all(expectedConflicts);

    expect(reset).toMatchObject({
      chatId: "",
      title: "Fresh chat",
      version: 0,
      messages: [],
    });
    expect(repository.snapshot()).toEqual(reset);
    expect(storage.createChatExclusive).not.toHaveBeenCalled();
    expect(storage.saveChat).toHaveBeenCalledTimes(1);
    expect(storage.saveChat.mock.calls[0]?.[1]).toEqual(oldMessages);
    expect(records).toEqual(new Map([[
      "old-chat",
      expect.objectContaining({
        version: 5,
        messages: oldMessages,
      }),
    ]]));
  });

  it("rejects an operation queued before a load changes the active chat", async () => {
    const { repository, records, storage } = createHarness();
    const loadedRecord = {
      id: "loaded-chat",
      title: "Loaded chat",
      version: 8,
      messages: [
        user("user-loaded", "Loaded question"),
        assistant("assistant-loaded", "Loaded answer"),
      ],
      context_files: [],
      agentConversationId: conversationId,
    };
    records.set("loaded-chat", loadedRecord);
    const loadStarted = deferred<void>();
    const loadResult = deferred<typeof loadedRecord>();
    storage.loadChat.mockImplementationOnce(async () => {
      loadStarted.resolve(undefined);
      return loadResult.promise;
    });

    const loading = repository.load("loaded-chat");
    await loadStarted.promise;
    const staleHistory = repository.reconcileServerHistory([
      user("user-stale", "Stale question"),
      assistant("assistant-stale", "Stale answer"),
    ]);
    const staleExpectation = expect(staleHistory).rejects
      .toBeInstanceOf(AgentTranscriptConflictError);
    loadResult.resolve(loadedRecord);

    await expect(loading).resolves.toMatchObject({
      chatId: "loaded-chat",
      version: 8,
      messages: loadedRecord.messages,
    });
    await staleExpectation;
    expect(repository.snapshot()).toMatchObject({
      chatId: "loaded-chat",
      version: 8,
      messages: loadedRecord.messages,
    });
    expect(storage.createChatExclusive).not.toHaveBeenCalled();
    expect(storage.saveChat).not.toHaveBeenCalled();
  });

  it("does not apply a deferred load after reset changes the active chat", async () => {
    const { repository, storage } = createHarness();
    const loadedRecord = {
      id: "stale-loaded-chat",
      title: "Stale loaded chat",
      version: 11,
      messages: [
        user("user-stale-loaded", "Stale loaded question"),
        assistant("assistant-stale-loaded", "Stale loaded answer"),
      ],
      context_files: [],
      agentConversationId: conversationId,
    };
    const loadStarted = deferred<void>();
    const loadResult = deferred<typeof loadedRecord>();
    storage.loadChat.mockImplementationOnce(async () => {
      loadStarted.resolve(undefined);
      return loadResult.promise;
    });

    const loading = repository.load("stale-loaded-chat");
    await loadStarted.promise;
    const reset = repository.reset({ title: "Fresh after load" });
    const staleLoadExpectation = expect(loading).rejects
      .toBeInstanceOf(AgentTranscriptConflictError);
    loadResult.resolve(loadedRecord);
    await staleLoadExpectation;

    expect(repository.snapshot()).toEqual(reset);
    expect(repository.snapshot()).toMatchObject({
      chatId: "",
      title: "Fresh after load",
      version: 0,
      messages: [],
    });
    expect(storage.createChatExclusive).not.toHaveBeenCalled();
    expect(storage.saveChat).not.toHaveBeenCalled();
  });

  it("atomically rejects the local user row and conversation pointer when persistence fails", async () => {
    const { repository, storage } = createHarness();
    storage.createChatExclusive.mockRejectedValueOnce(new Error("disk full"));

    await expect(repository.commitUser(
      { kind: "append", message: user("u1") },
      conversationId,
    )).rejects.toThrow("Failed to exclusively create chat");
    expect(repository.snapshot()).toMatchObject({
      chatId: "",
      version: 0,
      messages: [],
    });
    expect(repository.snapshot().agentConversationId).toBeUndefined();
  });

  it("atomically repairs local divergence from server order and content", async () => {
    const { repository, records } = createHarness();
    const accepted = await repository.commitUser(
      { kind: "append", message: user("u-local", "stale") },
      conversationId,
    );
    await repository.persistAssistant(assistant("a-local", "stale answer"));

    const reconciled = await repository.reconcileServerHistory([
      user("u-server", "authoritative question"),
      assistant("a-server", "authoritative answer"),
    ]);

    expect(reconciled.messages).toEqual([
      user("u-server", "authoritative question"),
      assistant("a-server", "authoritative answer"),
    ]);
    expect(records.get(accepted.chatId).messages).toEqual(reconciled.messages);
  });

  it("does not rewrite identical projected server history when only synthesized timestamps change", async () => {
    const { repository, records, storage } = createHarness();
    const accepted = await repository.commitUser({
      kind: "append",
      message: user("user-1", "Check the plan."),
    }, conversationId);

    const first = await repository.reconcileServerHistory(projectedServerHistory(100));
    const replayed = await repository.reconcileServerHistory(projectedServerHistory(10_000));

    expect(first.version).toBe(2);
    expect(replayed.version).toBe(2);
    expect(storage.saveChat).toHaveBeenCalledTimes(1);
    expect(replayed.messages[1].messageParts?.map((part) => part.timestamp))
      .toEqual([100, 101, 102]);
    expect(replayed.messages[1].tool_calls?.[0].timestamp).toBe(101);
    expect(records.get(accepted.chatId).version).toBe(2);
  });

  it("persists real content and tool-result updates despite synthesized timestamp changes", async () => {
    const { repository, storage } = createHarness();
    await repository.commitUser({
      kind: "append",
      message: user("user-1", "Check the plan."),
    }, conversationId);
    await repository.reconcileServerHistory(projectedServerHistory(100));

    const updated = await repository.reconcileServerHistory(
      projectedServerHistory(10_000, "The revised plan is ready.", "Revised Plan.md"),
    );

    expect(updated.version).toBe(3);
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(updated.messages[1]).toMatchObject({
      content: "The revised plan is ready.",
      tool_calls: [{
        result: { success: true, data: { path: "Revised Plan.md" } },
      }],
    });
    expect(updated.messages[1].messageParts?.map((part) => part.id)).toEqual([
      "reasoning:assistant-1:0",
      "tool:call-read",
      "text:assistant-1:2",
    ]);
    expect(updated.messages[1].messageParts?.map((part) => part.timestamp))
      .toEqual([100, 101, 102]);
    expect(updated.messages[1].messageParts?.[1]).toMatchObject({
      timestamp: 101,
      data: { timestamp: 101 },
    });
    expect(updated.messages[1].tool_calls?.[0].timestamp).toBe(101);
  });

  it("allocates a collision-free timestamp for a newly appended projected part", async () => {
    const { repository, storage } = createHarness();
    await repository.commitUser({
      kind: "append",
      message: user("user-1", "Check the plan."),
    }, conversationId);
    await repository.reconcileServerHistory(projectedServerHistory(100));

    const expanded = projectedServerHistory(10_000);
    const response = expanded[1];
    response.content = `${response.content} One more detail.`;
    response.messageParts?.push({
      id: "text:assistant-1:3",
      type: "content",
      timestamp: 10_003,
      data: " One more detail.",
    });

    const updated = await repository.reconcileServerHistory(expanded);
    const timestamps = updated.messages[1].messageParts?.map((part) => part.timestamp) ?? [];

    expect(updated.version).toBe(3);
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(timestamps).toEqual([100, 101, 102, 103]);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(updated.messages[1].tool_calls?.[0].timestamp).toBe(101);
  });

  it("accepts incoming chronology when a new projected part is inserted between stable IDs", async () => {
    const { repository, storage } = createHarness();
    await repository.commitUser({
      kind: "append",
      message: user("user-1", "Check the plan."),
    }, conversationId);
    const initial = projectedServerHistory(100);
    initial[1].messageParts = initial[1].messageParts?.filter((part) => part.type !== "tool_call");
    initial[1].tool_calls = undefined;
    await repository.reconcileServerHistory(initial);

    const inserted = await repository.reconcileServerHistory(projectedServerHistory(10_000));

    expect(inserted.version).toBe(3);
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(inserted.messages[1].messageParts?.map((part) => part.id)).toEqual([
      "reasoning:assistant-1:0",
      "tool:call-read",
      "text:assistant-1:2",
    ]);
    expect(inserted.messages[1].messageParts?.map((part) => part.timestamp))
      .toEqual([10_000, 10_001, 10_002]);
    expect(inserted.messages[1].tool_calls?.[0].timestamp).toBe(10_001);
  });

  it("accepts incoming chronology when a stable tool part ID changes call identity", async () => {
    const { repository, storage } = createHarness();
    await repository.commitUser({
      kind: "append",
      message: user("user-1", "Check the plan."),
    }, conversationId);
    await repository.reconcileServerHistory(projectedServerHistory(100));

    const changed = projectedServerHistory(10_000);
    const toolPart = changed[1].messageParts?.find((part) => part.type === "tool_call");
    if (!toolPart || toolPart.type !== "tool_call") throw new Error("Expected projected tool part.");
    const changedTool: ToolCall = {
      ...toolPart.data,
      id: "call-read-replaced",
      request: { ...toolPart.data.request, id: "call-read-replaced" },
    };
    toolPart.data = changedTool;
    changed[1].tool_calls = [changedTool];

    const updated = await repository.reconcileServerHistory(changed);

    expect(updated.version).toBe(3);
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(updated.messages[1].messageParts?.map((part) => part.timestamp))
      .toEqual([10_000, 10_001, 10_002]);
    expect(updated.messages[1].tool_calls?.[0]).toMatchObject({
      id: "call-read-replaced",
      timestamp: 10_001,
    });
  });

  it("persists a real projected part-order change when timestamps are regenerated", async () => {
    const { repository, storage } = createHarness();
    await repository.commitUser({
      kind: "append",
      message: user("user-1", "Check the plan."),
    }, conversationId);
    await repository.reconcileServerHistory(projectedServerHistory(100));

    const reordered = projectedServerHistory(10_000);
    const response = reordered[1];
    const [reasoningPart, toolPart, contentPart] = response.messageParts ?? [];
    response.messageParts = [toolPart, reasoningPart, contentPart].map((part, index) =>
      part.type === "tool_call"
        ? {
            ...part,
            timestamp: 10_000 + index,
            data: { ...part.data, timestamp: 10_000 + index },
          }
        : { ...part, timestamp: 10_000 + index });
    if (response.tool_calls?.[0]) response.tool_calls[0].timestamp = 10_000;

    const updated = await repository.reconcileServerHistory(reordered);

    expect(updated.version).toBe(3);
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(updated.messages[1].messageParts?.map((part) => part.id)).toEqual([
      "tool:call-read",
      "reasoning:assistant-1:0",
      "text:assistant-1:2",
    ]);
    expect(updated.messages[1].messageParts?.map((part) => part.timestamp))
      .toEqual([10_000, 10_001, 10_002]);
    expect(updated.messages[1].tool_calls?.[0].timestamp).toBe(10_000);
  });

  it("clears a stale saved cache when confirmed authoritative history is empty", async () => {
    const { repository, records, storage } = createHarness();
    const savedMessages = [
      user("user-saved", "Please update the note"),
      assistant("assistant-saved", "The note is updated."),
    ];
    records.set("2026-07-30 08-02-11", {
      id: "2026-07-30 08-02-11",
      title: "Saved tool run",
      version: 9,
      messages: savedMessages,
      context_files: [],
      agentConversationId: conversationId,
    });

    const loaded = await repository.load("2026-07-30 08-02-11");
    expect(loaded?.messages).toEqual(savedMessages);

    const reconciled = await repository.reconcileServerHistory([]);

    expect(reconciled).toMatchObject({
      chatId: "2026-07-30 08-02-11",
      version: 10,
      messages: [],
    });
    expect(repository.snapshot().messages).toEqual([]);
    expect(storage.saveChat).toHaveBeenCalledTimes(1);
    expect(storage.saveChat).toHaveBeenCalledWith(
      "2026-07-30 08-02-11",
      [],
      expect.objectContaining({
        agentConversationId: conversationId,
        authoritativeServerHistoryReconciliation: true,
      }),
    );
    expect(records.get("2026-07-30 08-02-11")).toMatchObject({
      version: 10,
      messages: [],
    });
  });

  it("does not reuse cleared local history when the next user turn is committed", async () => {
    const { repository, records, storage } = createHarness();
    const savedMessages = [
      user("user-stale", "Stale local question"),
      assistant("assistant-stale", "Stale local answer"),
    ];
    records.set("chat-stale", {
      id: "chat-stale",
      title: "Stale chat",
      version: 3,
      messages: savedMessages,
      context_files: [],
      agentConversationId: conversationId,
    });
    await repository.load("chat-stale");
    await repository.reconcileServerHistory([]);

    const next = await repository.commitUser({
      kind: "append",
      message: user("user-next", "Start from the server state"),
    }, conversationId);

    expect(next.messages).toEqual([
      user("user-next", "Start from the server state"),
    ]);
    expect(records.get("chat-stale")).toMatchObject({
      version: 5,
      messages: [user("user-next", "Start from the server state")],
    });
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(storage.saveChat.mock.calls[0]?.[1]).toEqual([]);
    expect(storage.saveChat.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      authoritativeServerHistoryReconciliation: true,
    }));
    expect(storage.saveChat.mock.calls[1]?.[1]).toEqual([
      user("user-next", "Start from the server state"),
    ]);
    expect(storage.saveChat.mock.calls[1]?.[2])
      .not.toHaveProperty("authoritativeServerHistoryReconciliation");
  });

  it("preserves local attachment presentation metadata by authoritative message id", async () => {
    const { repository } = createHarness();
    const local = user("u1");
    local.content = [
      { type: "text", text: "Review" },
      createTextAttachmentPart(
        "report.pdf",
        "text/markdown",
        new TextEncoder().encode("PDF canary 42"),
      ),
    ];
    local.attachmentMetadata = [{
      id: "attachment-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      byteLength: 42,
      kind: "document",
      contentPartIndex: 1,
      contentRef: {
        schema: "systemsculpt-chat-attachment-v1",
        payload: "utf8-content-part",
        sha256: "a".repeat(64),
        byteLength: 42,
      },
    }];
    await repository.commitUser({ kind: "append", message: local }, conversationId);

    const reconciled = await repository.reconcileServerHistory([{
      ...user("u1"),
      content: [
        { type: "text", text: "Review this" },
        createTextAttachmentPart(
          "report.pdf",
          "text/markdown",
          new TextEncoder().encode("PDF canary 42"),
        ),
      ],
    }]);

    expect(reconciled.messages[0].content).toEqual([
      { type: "text", text: "Review this" },
      createTextAttachmentPart(
        "report.pdf",
        "text/markdown",
        new TextEncoder().encode("PDF canary 42"),
      ),
    ]);
    expect(reconciled.messages[0].attachmentMetadata).toEqual(local.attachmentMetadata);
  });

  it("branches a retry from the exact durable user/version pair without replaying history", async () => {
    const { repository, records } = createHarness();
    records.set("chat-1", {
      id: "chat-1",
      title: "Chat",
      version: 4,
      messages: [user("u1"), assistant("a1"), user("u2"), assistant("a2")],
      context_files: [],
      agentConversationId: conversationId,
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
    expect(retried.agentConversationId).toBe(conversationId);

    await expect(repository.commitUser({
      kind: "resend",
      message: user("u4"),
      targetMessageId: "u1",
      expectedIndex: 0,
      expectedVersion: 4,
    })).rejects.toBeInstanceOf(AgentTranscriptConflictError);
  });

  it.each([
    {
      label: "first user turn",
      targetMessageId: "u1",
      expectedIndex: 0,
      expectedIds: ["u-edited"],
    },
    {
      label: "later user turn",
      targetMessageId: "u2",
      expectedIndex: 2,
      expectedIds: ["u1", "a1", "u-edited"],
    },
  ])("persists an edited $label branch before a later authoritative empty reconciliation", async ({
    targetMessageId,
    expectedIndex,
    expectedIds,
  }) => {
    const { repository, records, storage } = createHarness();
    records.set("chat-1", {
      id: "chat-1",
      title: "Chat",
      version: 4,
      messages: [user("u1"), assistant("a1"), user("u2"), assistant("a2")],
      context_files: [],
      agentConversationId: conversationId,
    });
    await repository.load("chat-1");
    const forkConversationId = "conversation_fedcba9876543210fedcba9876543210";
    const branchWriteStarted = deferred<void>();
    const releaseBranchWrite = deferred<void>();
    storage.saveChat.mockImplementationOnce(async (
      id: string,
      messages: ChatMessage[],
      options: any,
    ) => {
      branchWriteStarted.resolve(undefined);
      await releaseBranchWrite.promise;
      const previous = records.get(id);
      records.set(id, {
        ...previous,
        id,
        title: options.title,
        version: 5,
        messages,
        agentConversationId: options.agentConversationId,
      });
      return { version: 5 };
    });

    const editedPromise = repository.commitUser({
      kind: "resend",
      message: user("u-edited", "Edited request"),
      targetMessageId,
      expectedIndex,
      expectedVersion: 4,
    }, forkConversationId);
    const emptyReconciliation = repository.reconcileServerHistory([]);
    await branchWriteStarted.promise;

    expect(storage.saveChat).toHaveBeenCalledTimes(1);
    expect(storage.saveChat.mock.calls[0]?.[1]
      .map((message: ChatMessage) => message.message_id)).toEqual(expectedIds);
    expect(storage.saveChat.mock.calls[0]?.[2])
      .not.toHaveProperty("authoritativeServerHistoryReconciliation");
    expect(records.get("chat-1").messages.map((message: ChatMessage) => message.message_id))
      .toEqual(["u1", "a1", "u2", "a2"]);

    releaseBranchWrite.resolve(undefined);
    const [edited, reconciled] = await Promise.all([
      editedPromise,
      emptyReconciliation,
    ]);

    expect(edited).toMatchObject({
      version: 5,
      agentConversationId: forkConversationId,
    });
    expect(edited.messages.map((message) => message.message_id)).toEqual(expectedIds);
    expect(reconciled).toMatchObject({
      chatId: "chat-1",
      version: 6,
      agentConversationId: forkConversationId,
      messages: [],
    });
    expect(storage.saveChat).toHaveBeenCalledTimes(2);
    expect(storage.saveChat.mock.calls[1]?.[1]).toEqual([]);
    expect(storage.saveChat.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      agentConversationId: forkConversationId,
      authoritativeServerHistoryReconciliation: true,
    }));
    expect(records.get("chat-1")).toMatchObject({
      version: 6,
      agentConversationId: forkConversationId,
      messages: [],
    });
  });

  it("keeps a cached executing tool presentation-only until authoritative history arrives", async () => {
    const { repository, records, storage } = createHarness();
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
      messages: [user("u1"), interrupted],
      context_files: [],
    });

    const loaded = await repository.load("current");
    expect(loaded?.messages[1].tool_calls?.[0]).toMatchObject({
      state: "executing",
    });
    expect(loaded?.messages[1].tool_calls?.[0]).not.toHaveProperty("result");
    expect(loaded?.messages[1].messageParts?.[0]).toMatchObject({
      type: "tool_call",
      data: expect.objectContaining({ state: "executing" }),
    });
    expect(JSON.stringify(loaded)).not.toContain("TOOL_OUTCOME_UNKNOWN_AFTER_RESTART");
    expect(storage.saveChat).not.toHaveBeenCalled();

    await repository.saveMetadata();
    expect(records.get("current").messages[1].tool_calls[0]).toMatchObject({
      state: "executing",
    });
    expect(JSON.stringify(records.get("current")))
      .not.toContain("TOOL_OUTCOME_UNKNOWN_AFTER_RESTART");
  });

  it("returns copies so UI code cannot mutate durable state", async () => {
    const { repository } = createHarness();
    const accepted = await repository.commitUser({ kind: "append", message: user("u1") });
    (accepted.messages[0] as ChatMessage).content = "tampered";
    expect(repository.snapshot().messages[0].content).toBe("u1");
  });
});
