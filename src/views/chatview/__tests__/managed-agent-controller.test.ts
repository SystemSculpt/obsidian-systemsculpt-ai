import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import {
  composeAcceptedChatContinuation,
  composeAcceptedChatContinuationDelta,
  type AcceptedManagedChatRequestSnapshot,
} from "../../../services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedManagedChatOperation } from "../../../services/managed/ManagedTypes";
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";
import { selectAgentMessageParts, selectPendingApprovals, selectToolCall } from "../AgentConversation";
import type { AgentTranscriptSnapshot } from "../AgentTranscriptRepository";
import type { ManagedChatSessionBinding } from "../storage/ChatPersistenceTypes";
import {
  ManagedAgentController,
  type ManagedAgentControllerHost,
  type ManagedAgentRuntimePort,
} from "../ManagedAgentController";
import type { ManagedChatRuntimeEvent } from "../turn/ManagedChatRuntimeAdapter";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    parseYaml: jest.fn((yaml: string) => Object.fromEntries(yaml
      .split("\n")
      .map((line) => line.match(/^([A-Za-z0-9_]+):\s*(.+)$/))
      .filter((match): match is RegExpMatchArray => !!match)
      .map((match) => [match[1], match[2].replace(/^"(.*)"$/, "$1")]))),
  };
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function* stream(...events: ManagedChatRuntimeEvent[]): AsyncGenerator<ManagedChatRuntimeEvent> {
  for (const event of events) yield event;
}

const SESSION_ID = "mchat_0123456789abcdef0123456789abcdef";
const checkpointEvent = (revision = 1): ManagedChatRuntimeEvent => ({
  kind: "session_committed",
  checkpoint: { id: SESSION_ID, revision },
});

function textEvents(text: string, revision = 1): ManagedChatRuntimeEvent[] {
  return [
    { kind: "content_delta", text },
    { kind: "finish_reason", reason: "stop" },
    { kind: "usage", promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    checkpointEvent(revision),
    { kind: "done" },
  ];
}

function toolEvents(
  id: string,
  name: string,
  args: string,
  revision = 1,
): ManagedChatRuntimeEvent[] {
  const split = Math.max(1, Math.floor(args.length / 2));
  return [
    { kind: "tool_call_delta", index: 0, id, name, arguments: args.slice(0, split) },
    { kind: "tool_call_delta", index: 0, arguments: args.slice(split) },
    { kind: "finish_reason", reason: "tool_calls" },
    checkpointEvent(revision),
    { kind: "tool_call_completed", index: 0, id, name, arguments: args },
    { kind: "done" },
  ];
}

function manyToolEvents(count: number, revision = 1): ManagedChatRuntimeEvent[] {
  const events: ManagedChatRuntimeEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      kind: "tool_call_delta",
      index,
      id: `call-${index}`,
      name: "read",
      arguments: JSON.stringify({ paths: [`Note-${index}.md`] }),
    });
  }
  events.push({ kind: "finish_reason", reason: "tool_calls" }, checkpointEvent(revision));
  for (let index = 0; index < count; index += 1) {
    events.push({
      kind: "tool_call_completed",
      index,
      id: `call-${index}`,
      name: "read",
      arguments: JSON.stringify({ paths: [`Note-${index}.md`] }),
    });
  }
  events.push({ kind: "done" });
  return events;
}

function user(id = "user-1", content = "Hello"): ChatMessage {
  return { role: "user", content, message_id: id };
}

function reloadMessage(message: ChatMessage): ChatMessage {
  const markdown = [
    "---",
    "id: reload-test",
    "model: ai-agent",
    "title: Reload Test",
    "created: 2026-07-13T00:00:00.000Z",
    "lastModified: 2026-07-13T00:00:00.000Z",
    "---",
    "",
    ChatMarkdownSerializer.serializeMessages([message]),
  ].join("\n");
  const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);
  if (!parsed?.messages[0]) throw new Error("Failed to reload the persisted assistant message.");
  return parsed.messages[0];
}

function createHarness(
  responses: ManagedChatRuntimeEvent[][],
  executeLocalTool: (toolCall: ToolCall, signal: AbortSignal) => Promise<any> = async () => ({
    success: true,
    data: { path: "Notes/result.md", bytes: 12 },
  }),
) {
  const chatDescriptor = fixture.capabilities.find((entry) => entry.alias === "systemsculpt/chat")!;
  let version = 0;
  let messages: ChatMessage[] = [];
  let managedSession: ManagedChatSessionBinding | undefined;
  const persisted: Array<{ phase: string; message: ChatMessage }> = [];
  const snapshot = (): AgentTranscriptSnapshot => Object.freeze({
    chatId: "chat-1",
    title: "Chat",
    version,
    backend: "systemsculpt",
    ...(managedSession ? { managedSession } : {}),
    messages: Object.freeze(clone(messages)),
  });

  const host: ManagedAgentControllerHost = {
    acquireChatTurnLease: jest.fn(async () => ({
      outcome: "allowed" as const,
      lease: {
        outcome: "allowed" as const,
        descriptor: chatDescriptor,
        requestContract: { capability: "chat_turn" },
      } as any,
    })),
    commitUser: jest.fn(async (input) => {
      messages.push(clone(input.message));
      version += 1;
      return snapshot();
    }),
    claimUser: jest.fn(() => true),
    prepareAcceptedRequest: jest.fn(async (operation: AcceptedManagedChatOperation) => ({
      runtime: "managed" as const,
      operation,
      durableTurnId: operation.durableTurnId,
      durableSnapshot: operation.initialDurableSnapshot,
      continuationBoundaryMessageId: operation.durableTurnId,
      policy: {
        contextCount: 0,
        imageContextIncluded: false,
        documentContextIncluded: false,
        tools: "normalized" as const,
      },
      model: "ai-agent" as const,
      messages: [{ role: "user", content: String(operation.acceptedUserMessage.content) }],
      turnMessages: [{ role: "user", content: String(operation.acceptedUserMessage.content) }],
      webSearch: false,
    }) as AcceptedManagedChatRequestSnapshot),
    persistAssistant: jest.fn(async (message, phase) => {
      persisted.push({ phase, message: clone(message) });
      const index = messages.findIndex((candidate) => candidate.message_id === message.message_id);
      if (index < 0) messages.push(clone(message));
      else messages[index] = clone(message);
      version += 1;
      return snapshot();
    }),
    persistAssistantWithSession: jest.fn(async (message, checkpoint, toolsetFingerprint, budget) => {
      persisted.push({ phase: "assistant_commit", message: clone(message) });
      const index = messages.findIndex((candidate) => candidate.message_id === message.message_id);
      if (index < 0) messages.push(clone(message));
      else messages[index] = clone(message);
      managedSession = Object.freeze({
        ...checkpoint,
        boundChatId: "chat-1",
        checkpointMessageId: message.message_id,
        toolsetFingerprint,
        budget,
      });
      version += 1;
      return snapshot();
    }),
    clearSessionCheckpoint: jest.fn(async () => { managedSession = undefined; }),
    snapshot,
    executeLocalTool: jest.fn(executeLocalTool),
    refreshCredits: jest.fn(),
    reportError: jest.fn(),
  };
  const runtime: ManagedAgentRuntimePort = {
    dispatch: jest.fn(async () => {
      const next = responses.shift();
      if (!next) return { kind: "transport_failure" as const, diagnostic: {} };
      return { kind: "success" as const, diagnostic: {}, events: stream(...next) };
    }),
    notifyDurablyTerminal: jest.fn(),
  };
  const controller = new ManagedAgentController({
    host,
    runtime,
    now: (() => {
      let now = 1_000;
      return () => ++now;
    })(),
  });
  return { controller, host, runtime, persisted, snapshot };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for controller state.");
}

describe("ManagedAgentController", () => {
  it("streams an answer through the closed first-party event contract", async () => {
    const harness = createHarness([textEvents("Hello from the agent")]);
    const envelopes: string[] = [];
    harness.controller.subscribe((_snapshot, envelope) => envelopes.push(envelope.event.type));

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "completed",
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      messages: [{ id: "user-1:assistant:0" }],
    });
    expect(envelopes).toEqual(expect.arrayContaining([
      "run.started",
      "message.started",
      "text.delta",
      "text.completed",
      "usage.updated",
      "run.completed",
    ]));
    expect(harness.persisted).toHaveLength(1);
    expect(harness.persisted[0].message).toMatchObject({
      role: "assistant",
      content: "Hello from the agent",
      message_id: "user-1:assistant:0",
    });
    expect(harness.persisted[0].message.reasoning).toBeUndefined();
    expect(harness.host.persistAssistantWithSession).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: "user-1:assistant:0" }),
      { id: SESSION_ID, revision: 1 },
      expect.stringMatching(/^\d+:[0-9a-f]+:[0-9a-f]+$/),
      expect.objectContaining({ messageCount: 2, imageCount: 0, attachmentBytes: 0 }),
    );
    expect(harness.runtime.notifyDurablyTerminal).toHaveBeenCalledTimes(1);
    expect(harness.host.clearSessionCheckpoint).not.toHaveBeenCalled();
  });

  it("replaces partial stream state when the same managed phase is recovered", async () => {
    const harness = createHarness([[
      { kind: "content_delta", text: "partial answer" },
      { kind: "tool_call_delta", index: 0, id: "discarded-call", name: "read", arguments: "{}" },
      { kind: "phase_restarted", attempt: 1 },
      { kind: "content_delta", text: "recovered answer" },
      { kind: "finish_reason", reason: "stop" },
      checkpointEvent(),
      { kind: "done" },
    ]]);
    const emitted: string[] = [];
    harness.controller.subscribe((_snapshot, envelope) => emitted.push(envelope.event.type));

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    expect(emitted).toContain("message.restarted");
    expect(harness.persisted).toHaveLength(1);
    expect(harness.persisted[0].message).toMatchObject({
      content: "recovered answer",
      messageParts: [{ type: "content", data: "recovered answer" }],
    });
    expect(harness.persisted[0].message.tool_calls).toBeUndefined();
    expect(selectAgentMessageParts(
      harness.controller.getSnapshot(),
      "user-1:assistant:0",
    )).toEqual([
      expect.objectContaining({ kind: "text", markdown: "recovered answer", state: "complete" }),
    ]);
    expect(harness.host.executeLocalTool).not.toHaveBeenCalled();
  });

  it("executes model-emitted tools locally, persists their checkpoint, and continues with explicit tool results", async () => {
    const harness = createHarness([
      toolEvents("call-1", "read", '{"paths":["Notes/result.md"]}'),
      textEvents("The note is ready.", 2),
    ]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    expect(harness.host.executeLocalTool).toHaveBeenCalledTimes(1);
    expect(harness.persisted.map((entry) => entry.phase)).toEqual([
      "assistant_commit",
      "tool_checkpoint",
      "assistant_commit",
    ]);
    expect(harness.persisted[1].message.tool_calls?.[0]).toMatchObject({
      id: "call-1",
      state: "completed",
      result: { success: true },
    });
    const secondDispatch = (harness.runtime.dispatch as jest.Mock).mock.calls[1][0];
    expect(secondDispatch).toMatchObject({ phase: "continuation", continuationIndex: 0 });
    expect(secondDispatch.postCheckpointDurableSnapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      tool_calls: [expect.objectContaining({ id: "call-1", state: "completed" })],
    });
    expect(composeAcceptedChatContinuationDelta(
      secondDispatch.acceptedRequestSnapshot,
      secondDispatch.postCheckpointDurableSnapshot,
    )).toEqual([
      expect.objectContaining({ role: "tool", tool_call_id: "call-1", name: "read" }),
    ]);
    expect(selectToolCall(harness.controller.getSnapshot(), "user-1:assistant:0:tool:0")).toMatchObject({
      state: "succeeded",
      output: {
        summary: "Notes/result.md",
        artifacts: [{ kind: "vault_file", path: "Notes/result.md" }],
      },
    });
  });

  it("rejects an oversized tool batch before any local tool can run", async () => {
    const harness = createHarness([manyToolEvents(17)]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result).toMatchObject({
      kind: "failed",
      error: { code: "local_tool_batch_limit" },
    });
    expect(harness.host.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.runtime.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.persisted.at(-1)?.phase).toBe("tool_checkpoint");
  });

  it("preserves text, tool, text chronology in live projection, durable parts, and reload", async () => {
    const args = '{"paths":["Notes/result.md"]}';
    const split = 12;
    const harness = createHarness([[
      { kind: "content_delta", text: "I will read it. " },
      { kind: "tool_call_delta", index: 0, id: "call-ordered", name: "read", arguments: args.slice(0, split) },
      { kind: "content_delta", text: "Then I will summarize it." },
      { kind: "tool_call_delta", index: 0, arguments: args.slice(split) },
      { kind: "finish_reason", reason: "tool_calls" },
      checkpointEvent(),
      { kind: "tool_call_completed", index: 0, id: "call-ordered", name: "read", arguments: args },
      { kind: "done" },
    ], textEvents("Summary complete.", 2)]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    const liveParts = selectAgentMessageParts(
      harness.controller.getSnapshot(),
      "user-1:assistant:0",
    );
    expect(liveParts.map((part) => part.kind)).toEqual(["text", "tool", "text"]);
    expect(liveParts.map((part) => part.id)).toEqual([
      "user-1:assistant:0:text:0",
      "user-1:assistant:0:tool:0:part",
      "user-1:assistant:0:text:1",
    ]);

    const settled = harness.persisted[1].message;
    expect(settled.content).toBe("I will read it. Then I will summarize it.");
    expect(settled.messageParts?.map((part) => part.type)).toEqual(["content", "tool_call", "content"]);
    expect(settled.messageParts?.map((part) => part.type === "tool_call" ? part.data.id : part.data)).toEqual([
      "I will read it. ",
      "call-ordered",
      "Then I will summarize it.",
    ]);
    const reloaded = reloadMessage(settled);
    expect(reloaded.content).toBe("I will read it. Then I will summarize it.");
    expect(reloaded.messageParts?.map((part) => part.type)).toEqual(["content", "tool_call", "content"]);
    expect(reloaded.messageParts?.map((part) => part.type === "tool_call" ? part.data.id : part.data)).toEqual([
      "I will read it. ",
      "call-ordered",
      "Then I will summarize it.",
    ]);
  });

  it("keeps two interleaved tool streams in first-observed part order", async () => {
    const firstArgs = '{"paths":["one.md"]}';
    const secondArgs = '{"paths":["two.md"]}';
    const harness = createHarness([[
      { kind: "tool_call_delta", index: 0, id: "call-one", name: "read", arguments: firstArgs.slice(0, 9) },
      { kind: "tool_call_delta", index: 1, id: "call-two", name: "read", arguments: secondArgs.slice(0, 8) },
      { kind: "tool_call_delta", index: 0, arguments: firstArgs.slice(9) },
      { kind: "content_delta", text: "I am checking both." },
      { kind: "tool_call_delta", index: 1, arguments: secondArgs.slice(8) },
      { kind: "finish_reason", reason: "tool_calls" },
      checkpointEvent(),
      { kind: "tool_call_completed", index: 0, id: "call-one", name: "read", arguments: firstArgs },
      { kind: "tool_call_completed", index: 1, id: "call-two", name: "read", arguments: secondArgs },
      { kind: "done" },
    ], textEvents("Both checked.", 2)]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    expect(harness.host.executeLocalTool).toHaveBeenCalledTimes(2);
    const settled = harness.persisted[1].message;
    expect(settled.messageParts?.map((part) => part.type)).toEqual(["tool_call", "tool_call", "content"]);
    expect(settled.messageParts?.map((part) => part.type === "tool_call" ? part.data.id : part.data)).toEqual([
      "call-one",
      "call-two",
      "I am checking both.",
    ]);
    expect(selectAgentMessageParts(
      harness.controller.getSnapshot(),
      "user-1:assistant:0",
    ).map((part) => part.kind)).toEqual(["tool", "tool", "text"]);
  });

  it("keeps tool-first parts and allocates fresh text parts in a continuation", async () => {
    const firstArgs = '{"paths":["one.md"]}';
    const secondArgs = '{"paths":["two.md"]}';
    const harness = createHarness([[
      { kind: "tool_call_delta", index: 0, id: "call-first", name: "read", arguments: firstArgs },
      { kind: "content_delta", text: "First action queued." },
      { kind: "finish_reason", reason: "tool_calls" },
      checkpointEvent(),
      { kind: "tool_call_completed", index: 0, id: "call-first", name: "read", arguments: firstArgs },
      { kind: "done" },
    ], [
      { kind: "content_delta", text: "Before the second action. " },
      { kind: "tool_call_delta", index: 0, id: "call-second", name: "read", arguments: secondArgs },
      { kind: "content_delta", text: "After the second action." },
      { kind: "finish_reason", reason: "tool_calls" },
      checkpointEvent(2),
      { kind: "tool_call_completed", index: 0, id: "call-second", name: "read", arguments: secondArgs },
      { kind: "done" },
    ], textEvents("All done.", 3)]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    expect(harness.persisted[1].message.messageParts?.map((part) => part.type)).toEqual([
      "tool_call",
      "content",
    ]);
    expect(harness.persisted[3].message.messageParts?.map((part) => part.type)).toEqual([
      "content",
      "tool_call",
      "content",
    ]);
    expect(selectAgentMessageParts(
      harness.controller.getSnapshot(),
      "user-1:assistant:1",
    ).map((part) => part.id)).toEqual([
      "user-1:assistant:1:text:0",
      "user-1:assistant:1:tool:0:part",
      "user-1:assistant:1:text:1",
    ]);
    expect((harness.runtime.dispatch as jest.Mock).mock.calls.map(([input]) => [input.phase, input.continuationIndex]))
      .toEqual([["initial", 0], ["continuation", 0], ["continuation", 1]]);
  });

  it("waits for an inline approval and records a denial without opening or executing anything", async () => {
    const harness = createHarness([
      toolEvents("call-write", "write", '{"path":"Notes/new.md","content":"x"}'),
      textEvents("I left the vault unchanged.", 2),
    ]);
    const running = harness.controller.start({ commit: { kind: "append", message: user() } });
    await waitFor(() => selectPendingApprovals(harness.controller.getSnapshot()).length === 1);
    const pending = selectPendingApprovals(harness.controller.getSnapshot())[0];

    expect(harness.controller.respondToApproval(pending.approvalId!, false)).toBe(true);
    const result = await running;

    expect(result.kind).toBe("completed");
    expect(harness.host.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.persisted[1].message.tool_calls?.[0]).toMatchObject({
      state: "failed",
      result: { error: { code: "USER_DENIED" } },
    });
    expect(selectToolCall(harness.controller.getSnapshot(), pending.callId)).toMatchObject({ state: "denied" });
    expect(harness.controller.respondToApproval(pending.approvalId!, true)).toBe(false);
  });

  it("allows a synchronous automation subscriber to resolve an approval", async () => {
    const harness = createHarness([
      toolEvents("call-write", "write", '{"path":"Notes/new.md","content":"x"}'),
      textEvents("I left the vault unchanged.", 2),
    ]);
    const responses: boolean[] = [];
    harness.controller.subscribe((snapshot) => {
      for (const pending of selectPendingApprovals(snapshot)) {
        responses.push(harness.controller.respondToApproval(pending.approvalId!, false));
      }
    });

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    expect(responses).toContain(true);
    expect(harness.host.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.persisted[1].message.tool_calls?.[0]).toMatchObject({
      state: "failed",
      result: { error: { code: "USER_DENIED" } },
    });
  });

  it("cancels an approval wait, fences late input, and durably settles the unstarted tool", async () => {
    const harness = createHarness([
      toolEvents("call-write", "write", '{"path":"Notes/new.md","content":"x"}'),
    ]);
    const running = harness.controller.start({ commit: { kind: "append", message: user() } });
    await waitFor(() => selectPendingApprovals(harness.controller.getSnapshot()).length === 1);
    const approvalId = selectPendingApprovals(harness.controller.getSnapshot())[0].approvalId!;

    await harness.controller.cancel();
    const result = await running;

    expect(result.kind).toBe("cancelled");
    expect(harness.controller.getSnapshot().status).toBe("cancelled");
    expect(harness.controller.respondToApproval(approvalId, true)).toBe(false);
    expect(harness.persisted.at(-1)?.phase).toBe("tool_checkpoint");
    expect(harness.persisted.at(-1)?.message.tool_calls?.[0]).toMatchObject({
      state: "failed",
      result: { error: { code: "TOOL_CANCELLED_BEFORE_START" } },
    });
    expect(harness.runtime.notifyDurablyTerminal).toHaveBeenCalledTimes(1);
    expect(harness.host.clearSessionCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("waits for an executing tool to settle before durably fencing cancellation", async () => {
    const harness = createHarness([
      toolEvents("call-read", "read", '{"paths":["Notes/new.md"]}'),
    ], async (_toolCall, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({
        success: false,
        error: {
          code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
          message: "Outcome unknown.",
        },
      }), { once: true });
    }));
    const running = harness.controller.start({ commit: { kind: "append", message: user() } });
    await waitFor(() => (harness.host.executeLocalTool as jest.Mock).mock.calls.length === 1);

    await harness.controller.cancel();
    const result = await running;

    expect(result.kind).toBe("cancelled");
    expect(harness.persisted.at(-1)?.phase).toBe("tool_checkpoint");
    expect(harness.persisted.at(-1)?.message.tool_calls?.[0]).toMatchObject({
      state: "failed",
      result: { error: { code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN" } },
    });
  });

  it("retains structured partial results for the customer and the continuation", async () => {
    const data = {
      success: false,
      appliedFiles: 1,
      results: [
        { path: "Changed.md", success: true },
        { path: "Failed.md", success: false, error: "Conflict" },
      ],
    };
    const harness = createHarness([
      toolEvents("call-edit", "multi_edit", '{"files":[{"path":"Changed.md","edits":[]},{"path":"Failed.md","edits":[]}]}'),
      textEvents("I changed one file and reported the conflict.", 2),
    ], async () => ({
      success: false,
      data,
      error: { code: "TOOL_PARTIAL_FAILURE", message: "One file changed; one conflicted." },
    }));

    const result = await harness.controller.start({
      commit: { kind: "append", message: user() },
      approvalPolicy: { requireDestructiveApproval: false },
    });

    expect(result.kind).toBe("completed");
    expect(selectToolCall(harness.controller.getSnapshot(), "user-1:assistant:0:tool:0")).toMatchObject({
      state: "failed",
      output: {
        data,
        artifacts: [{ path: "Changed.md" }],
      },
    });
    const continuation = (harness.runtime.dispatch as jest.Mock).mock.calls[1][0].postCheckpointDurableSnapshot;
    const [toolMessage] = composeAcceptedChatContinuationDelta(
      (harness.runtime.dispatch as jest.Mock).mock.calls[1][0].acceptedRequestSnapshot,
      continuation,
    );
    expect(JSON.parse(String(toolMessage.content))).toMatchObject({
      error: { code: "TOOL_PARTIAL_FAILURE" },
      data,
    });
  });

  it("deterministically bounds oversized tool results before continuation", async () => {
    const harness = createHarness([
      toolEvents("call-large", "read", '{"paths":["Large.md"]}'),
      textEvents("I used the available portion.", 2),
    ], async () => ({
      success: true,
      data: { path: "Large.md", content: "multibyte-🙂".repeat(150_000) },
    }));

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    const continuation = (harness.runtime.dispatch as jest.Mock).mock.calls[1][0]
      .postCheckpointDurableSnapshot as AgentTranscriptSnapshot;
    const [toolMessage] = composeAcceptedChatContinuationDelta(
      (harness.runtime.dispatch as jest.Mock).mock.calls[1][0].acceptedRequestSnapshot,
      continuation,
    );
    const wire = String(toolMessage.content ?? "");
    expect(new TextEncoder().encode(wire).byteLength).toBeLessThanOrEqual(96 * 1024);
    expect(JSON.parse(wire)).toMatchObject({
      systemsculpt_truncated: true,
      artifact_paths: ["Large.md"],
      original_utf8_bytes: expect.any(Number),
    });
  });

  it("fails closed when a tool finish reason has no completed tool call", async () => {
    const harness = createHarness([[
      { kind: "finish_reason", reason: "tool_calls" },
      checkpointEvent(),
      { kind: "done" },
    ]]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result).toMatchObject({
      kind: "failed",
      error: { code: "managed_tool_result_missing" },
    });
    expect(harness.controller.getSnapshot().status).toBe("failed");
    expect(harness.host.executeLocalTool).not.toHaveBeenCalled();
  });

  it("enforces the continuation bound after a durable tool checkpoint", async () => {
    const harness = createHarness([
      toolEvents("call-1", "read", '{"paths":["one.md"]}'),
      toolEvents("call-2", "read", '{"paths":["two.md"]}', 2),
    ]);
    const bounded = new ManagedAgentController({
      host: harness.host,
      runtime: harness.runtime,
      maxContinuationRounds: 1,
      now: () => 1_000,
    });

    const result = await bounded.start({ commit: { kind: "append", message: user() } });

    expect(result).toMatchObject({
      kind: "failed",
      error: { code: "max_tool_continuation_depth" },
    });
    expect(harness.runtime.dispatch).toHaveBeenCalledTimes(2);
    expect(bounded.getSnapshot().status).toBe("failed");
  });

  it("retains every prior explicit tool result across multiple continuations", async () => {
    const harness = createHarness([
      toolEvents("call-1", "read", '{"paths":["one.md"]}'),
      toolEvents("call-2", "read", '{"paths":["two.md"]}', 2),
      textEvents("Both notes are ready.", 3),
    ]);

    const result = await harness.controller.start({ commit: { kind: "append", message: user() } });

    expect(result.kind).toBe("completed");
    const thirdDispatch = (harness.runtime.dispatch as jest.Mock).mock.calls[2][0];
    expect(composeAcceptedChatContinuation(
      thirdDispatch.acceptedRequestSnapshot,
      thirdDispatch.postCheckpointDurableSnapshot,
    ).map((message) => message.role === "tool" ? `tool:${String(message.tool_call_id)}` : message.role))
      .toEqual(["user", "assistant", "tool:call-1", "assistant", "tool:call-2"]);
    expect((harness.host.persistAssistantWithSession as jest.Mock).mock.calls.map(([, checkpoint]) => checkpoint.revision))
      .toEqual([1, 2, 3]);
    expect((harness.host.persistAssistantWithSession as jest.Mock).mock.calls.map(([, , , budget]) => budget.messageCount))
      .toEqual([2, 4, 6]);
  });
});
