import {
  AgentConversationProtocolError,
  MANAGED_AGENT_EVENT_VERSION,
  applyManagedAgentEvent,
  createInitialAgentConversation,
  isAgentConversationTerminal,
  replayManagedAgentEvents,
  selectAgentMessageParts,
  selectAgentPart,
  selectPendingApprovals,
  selectToolCall,
  type AgentPart,
  type ManagedAgentEvent,
  type ManagedAgentEventEnvelope,
} from "../AgentConversation";

const RUN_ID = "run-1";
const TURN_ID = "turn-1";

function envelope(
  seq: number,
  event: ManagedAgentEvent,
  overrides: Partial<ManagedAgentEventEnvelope> = {},
): ManagedAgentEventEnvelope {
  return {
    version: MANAGED_AGENT_EVENT_VERSION,
    seq,
    runId: RUN_ID,
    turnId: TURN_ID,
    emittedAt: 1_000 + seq,
    event,
    ...overrides,
  };
}

function expectProtocolError(
  action: () => unknown,
  code: AgentConversationProtocolError["code"],
): AgentConversationProtocolError {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AgentConversationProtocolError);
  expect(error).toMatchObject({ code });
  return error as AgentConversationProtocolError;
}

function exhaustPart(part: AgentPart): string {
  switch (part.kind) {
    case "reasoning":
    case "text":
    case "status":
    case "tool":
    case "error":
      return part.kind;
    default: {
      const unreachable: never = part;
      throw new Error(String(unreachable));
    }
  }
}

function exhaustEvent(event: ManagedAgentEvent): string {
  switch (event.type) {
    case "run.started":
    case "run.status":
    case "message.started":
    case "message.restarted":
    case "reasoning.delta":
    case "reasoning.completed":
    case "text.delta":
    case "text.completed":
    case "tool.input.started":
    case "tool.input.delta":
    case "tool.requested":
    case "approval.requested":
    case "approval.resolved":
    case "tool.started":
    case "tool.succeeded":
    case "tool.failed":
    case "usage.updated":
    case "run.waiting":
    case "run.completed":
    case "run.cancelled":
    case "run.failed":
      return event.type;
    default: {
      const unreachable: never = event;
      throw new Error(String(unreachable));
    }
  }
}
void exhaustPart;
void exhaustEvent;

describe("AgentConversation", () => {
  it("projects the complete typed agent lifecycle through one deterministic replay", () => {
    const events: ManagedAgentEventEnvelope[] = [
      envelope(1, { type: "run.started" }),
      envelope(2, { type: "run.status", phase: "working", label: "Reading the vault" }),
      envelope(3, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      envelope(4, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: "Hello" }),
      envelope(5, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: " world" }),
      envelope(6, { type: "text.completed", messageId: "assistant-1", partId: "text-1" }),
      envelope(7, {
        type: "tool.input.delta",
        callId: "call-1",
        partId: "tool-1",
        messageId: "assistant-1",
        name: "write",
        location: "vault",
        delta: "{\"path\":",
      }),
      envelope(8, {
        type: "tool.input.delta",
        callId: "call-1",
        partId: "tool-1",
        messageId: "assistant-1",
        name: "write",
        location: "vault",
        delta: "\"note.md\"}",
      }),
      envelope(9, {
        type: "tool.requested",
        call: {
          callId: "call-1",
          partId: "tool-1",
          messageId: "assistant-1",
          name: "write",
          location: "vault",
          input: { path: "note.md" },
        },
      }),
      envelope(10, { type: "approval.requested", callId: "call-1", approvalId: "approval-1" }),
      envelope(11, { type: "run.waiting", reason: "approval" }),
      envelope(12, { type: "approval.resolved", approvalId: "approval-1", approved: true }),
      envelope(13, { type: "tool.started", callId: "call-1" }),
      envelope(14, {
        type: "tool.succeeded",
        callId: "call-1",
        result: { title: "Wrote note.md", summary: "12 bytes" },
      }),
      envelope(15, {
        type: "usage.updated",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costTotal: 0.01 },
      }),
      envelope(16, { type: "run.completed" }),
    ];

    const snapshot = replayManagedAgentEvents(events);

    expect(snapshot).toMatchObject({
      version: 1,
      runId: RUN_ID,
      turnId: TURN_ID,
      lastSeq: 16,
      status: "completed",
      phase: "complete",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costTotal: 0.01 },
    });
    expect(snapshot.messages).toEqual([{
      id: "assistant-1",
      role: "assistant",
      partIds: ["text-1", "tool-1"],
    }]);
    expect(selectAgentPart(snapshot, "text-1")).toMatchObject({
      kind: "text",
      state: "complete",
      markdown: "Hello world",
      order: 1,
    });
    expect(selectToolCall(snapshot, "call-1")).toMatchObject({
      kind: "tool",
      state: "succeeded",
      inputText: "{\"path\":\"note.md\"}",
      input: { path: "note.md" },
      output: { title: "Wrote note.md", summary: "12 bytes" },
    });
    expect(selectAgentMessageParts(snapshot, "assistant-1").map(exhaustPart)).toEqual(["text", "tool"]);
    expect(selectPendingApprovals(snapshot)).toEqual([]);
    expect(isAgentConversationTerminal(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.parts)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
  });

  it("accepts exact replay duplicates without changing identity or applying them twice", () => {
    const start = envelope(1, { type: "run.started" });
    const message = envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" });
    const initial = replayManagedAgentEvents([start, message]);

    expect(applyManagedAgentEvent(initial, message)).toBe(initial);

    const continued = replayManagedAgentEvents([
      message,
      envelope(3, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: "One" }),
    ], initial);
    expect(continued.messages).toHaveLength(1);
    expect(selectAgentPart(continued, "text-1")).toMatchObject({ markdown: "One" });
  });

  it("streams a bounded reasoning summary as its own ordered message part", () => {
    const snapshot = replayManagedAgentEvents([
      envelope(1, { type: "run.started" }),
      envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      envelope(3, {
        type: "reasoning.delta",
        messageId: "assistant-1",
        partId: "reasoning-1",
        delta: "Checked the request. ",
      }),
      envelope(4, {
        type: "reasoning.delta",
        messageId: "assistant-1",
        partId: "reasoning-1",
        delta: "Selected the safest path.",
      }),
      envelope(5, {
        type: "reasoning.completed",
        messageId: "assistant-1",
        partId: "reasoning-1",
      }),
      envelope(6, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: "Done." }),
      envelope(7, { type: "text.completed", messageId: "assistant-1", partId: "text-1" }),
      envelope(8, { type: "run.completed" }),
    ]);

    expect(selectAgentMessageParts(snapshot, "assistant-1")).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        state: "complete",
        summary: "Checked the request. Selected the safest path.",
      }),
      expect.objectContaining({ kind: "text", state: "complete", markdown: "Done." }),
    ]);
  });

  it("canonicalizes object key order when checking duplicate fingerprints", () => {
    const first = replayManagedAgentEvents([
      envelope(1, { type: "run.started" }),
      envelope(2, {
        type: "usage.updated",
        usage: { promptTokens: 10, completionTokens: 2 },
      }),
    ]);
    const reordered = envelope(2, {
      type: "usage.updated",
      usage: { completionTokens: 2, promptTokens: 10 },
    });
    expect(applyManagedAgentEvent(first, reordered)).toBe(first);
  });

  it("tracks approval waiting and denied states without a modal-only side channel", () => {
    const requested = replayManagedAgentEvents([
      envelope(1, { type: "run.started" }),
      envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      envelope(3, {
        type: "tool.requested",
        call: {
          callId: "call-1",
          partId: "tool-1",
          messageId: "assistant-1",
          name: "trash",
          location: "vault",
          input: { path: "note.md" },
        },
      }),
      envelope(4, { type: "approval.requested", callId: "call-1", approvalId: "approval-1" }),
      envelope(5, { type: "run.waiting", reason: "approval" }),
    ]);
    expect(requested).toMatchObject({ status: "waiting", waitingReason: "approval" });
    expect(selectPendingApprovals(requested)).toHaveLength(1);

    const denied = applyManagedAgentEvent(
      requested,
      envelope(6, { type: "approval.resolved", approvalId: "approval-1", approved: false }),
    );
    expect(denied).toMatchObject({ status: "running", waitingReason: undefined });
    expect(selectToolCall(denied, "call-1")).toMatchObject({ state: "denied" });
  });

  it("keeps distinct text runs around a tool in exact message order", () => {
    const snapshot = replayManagedAgentEvents([
      envelope(1, { type: "run.started" }),
      envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      envelope(3, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: "Before" }),
      envelope(4, { type: "text.completed", messageId: "assistant-1", partId: "text-1" }),
      envelope(5, {
        type: "tool.input.started",
        callId: "call-1",
        partId: "tool-1",
        messageId: "assistant-1",
        name: "read",
        location: "vault",
      }),
      envelope(6, {
        type: "tool.input.delta",
        callId: "call-1",
        partId: "tool-1",
        messageId: "assistant-1",
        name: "read",
        location: "vault",
        delta: '{"paths":["one.md"]}',
      }),
      envelope(7, {
        type: "tool.requested",
        call: {
          callId: "call-1",
          partId: "tool-1",
          messageId: "assistant-1",
          name: "read",
          location: "vault",
          input: { paths: ["one.md"] },
        },
      }),
      envelope(8, { type: "tool.started", callId: "call-1" }),
      envelope(9, { type: "tool.succeeded", callId: "call-1", result: { title: "Read one.md" } }),
      envelope(10, { type: "text.delta", messageId: "assistant-1", partId: "text-2", delta: "After" }),
      envelope(11, { type: "text.completed", messageId: "assistant-1", partId: "text-2" }),
      envelope(12, { type: "run.completed" }),
    ]);

    expect(snapshot.messages[0].partIds).toEqual(["text-1", "tool-1", "text-2"]);
    expect(selectAgentMessageParts(snapshot, "assistant-1").map((part) => part.kind)).toEqual([
      "text",
      "tool",
      "text",
    ]);
  });

  it("projects tool errors and terminal run errors independently", () => {
    const toolFailed = replayManagedAgentEvents([
      envelope(1, { type: "run.started" }),
      envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      envelope(3, {
        type: "tool.requested",
        call: {
          callId: "call-1",
          partId: "tool-1",
          messageId: "assistant-1",
          name: "read",
          location: "vault",
          input: { path: "missing.md" },
        },
      }),
      envelope(4, { type: "tool.started", callId: "call-1" }),
      envelope(5, { type: "tool.failed", callId: "call-1", error: { code: "not_found", message: "Missing" } }),
      envelope(6, { type: "run.failed", error: { code: "agent_failed", message: "Could not finish" } }),
    ]);
    expect(selectToolCall(toolFailed, "call-1")).toMatchObject({
      state: "failed",
      error: { code: "not_found" },
    });
    expect(toolFailed).toMatchObject({
      status: "failed",
      terminalError: { code: "agent_failed" },
    });
    expect(toolFailed.parts.at(-1)).toMatchObject({ kind: "error", retryable: true });
  });

  it("supports cancellation while parts remain active", () => {
    const cancelled = replayManagedAgentEvents([
      envelope(1, { type: "run.started" }),
      envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      envelope(3, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: "Partial" }),
      envelope(4, { type: "run.cancelled" }),
    ]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", state: "complete", markdown: "Partial" }),
      expect.objectContaining({ kind: "status", phase: "complete", label: "Stopped" }),
    ]));
    expect(isAgentConversationTerminal(cancelled)).toBe(true);
  });

  describe("fail-closed protocol guards", () => {
    it("rejects a future event version", () => {
      expectProtocolError(() => applyManagedAgentEvent(
        createInitialAgentConversation(),
        { ...envelope(1, { type: "run.started" }), version: 2 } as ManagedAgentEventEnvelope,
      ), "unsupported_version");
    });

    it("requires a positive contiguous sequence starting with run.started", () => {
      expectProtocolError(() => applyManagedAgentEvent(
        createInitialAgentConversation(),
        envelope(0, { type: "run.started" }),
      ), "invalid_envelope");
      expectProtocolError(() => applyManagedAgentEvent(
        createInitialAgentConversation(),
        envelope(2, { type: "run.started" }),
      ), "out_of_order");
      expectProtocolError(() => applyManagedAgentEvent(
        createInitialAgentConversation(),
        envelope(1, { type: "run.status", phase: "thinking", label: "Thinking" }),
      ), "illegal_transition");
    });

    it("rejects gaps, conflicting duplicate sequences, and identity drift", () => {
      const started = replayManagedAgentEvents([
        envelope(1, { type: "run.started" }),
        envelope(2, { type: "run.status", phase: "thinking", label: "Thinking" }),
      ]);
      expectProtocolError(() => applyManagedAgentEvent(
        started,
        envelope(4, { type: "run.status", phase: "working", label: "Working" }),
      ), "out_of_order");
      expectProtocolError(() => applyManagedAgentEvent(
        started,
        envelope(2, { type: "run.status", phase: "thinking", label: "Different" }),
      ), "sequence_conflict");
      expectProtocolError(() => applyManagedAgentEvent(
        started,
        envelope(3, { type: "run.status", phase: "working", label: "Working" }, { runId: "run-2" }),
      ), "identity_mismatch");
    });

    it("rejects unknown event kinds and all new events after terminal settlement", () => {
      const started = applyManagedAgentEvent(createInitialAgentConversation(), envelope(1, { type: "run.started" }));
      expectProtocolError(() => applyManagedAgentEvent(
        started,
        envelope(2, { type: "future.event" } as ManagedAgentEvent),
      ), "unknown_event");

      const completed = applyManagedAgentEvent(started, envelope(2, { type: "run.completed" }));
      expectProtocolError(() => applyManagedAgentEvent(
        completed,
        envelope(3, { type: "run.status", phase: "working", label: "Late" }),
      ), "illegal_transition");
      expect(applyManagedAgentEvent(completed, envelope(2, { type: "run.completed" }))).toBe(completed);
    });

    it("requires entities and legal part transitions before applying deltas", () => {
      const started = applyManagedAgentEvent(createInitialAgentConversation(), envelope(1, { type: "run.started" }));
      expectProtocolError(() => applyManagedAgentEvent(
        started,
        envelope(2, { type: "text.delta", messageId: "missing", partId: "text-1", delta: "No" }),
      ), "missing_entity");

      const message = applyManagedAgentEvent(
        started,
        envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
      );
      expectProtocolError(() => applyManagedAgentEvent(
        message,
        envelope(3, { type: "text.completed", messageId: "assistant-1", partId: "missing" }),
      ), "illegal_transition");
    });

    it("prevents duplicate approval settlement", () => {
      const approval = replayManagedAgentEvents([
        envelope(1, { type: "run.started" }),
        envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
        envelope(3, {
          type: "tool.requested",
          call: {
            callId: "call-1",
            partId: "tool-1",
            messageId: "assistant-1",
            name: "write",
            location: "vault",
            input: { path: "note.md" },
          },
        }),
        envelope(4, { type: "approval.requested", callId: "call-1", approvalId: "approval-1" }),
      ]);
      const resolved = applyManagedAgentEvent(
        approval,
        envelope(5, { type: "approval.resolved", approvalId: "approval-1", approved: true }),
      );
      expectProtocolError(() => applyManagedAgentEvent(
        resolved,
        envelope(6, { type: "approval.resolved", approvalId: "approval-1", approved: true }),
      ), "illegal_transition");
    });

    it("rejects terminal completion with unsettled text or tools", () => {
      const streamingText = replayManagedAgentEvents([
        envelope(1, { type: "run.started" }),
        envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }),
        envelope(3, { type: "text.delta", messageId: "assistant-1", partId: "text-1", delta: "Partial" }),
      ]);
      expectProtocolError(() => applyManagedAgentEvent(
        streamingText,
        envelope(4, { type: "run.completed" }),
      ), "illegal_transition");
    });

    it("rejects decreasing or invalid usage counters", () => {
      const usage = replayManagedAgentEvents([
        envelope(1, { type: "run.started" }),
        envelope(2, { type: "usage.updated", usage: { totalTokens: 20 } }),
      ]);
      expectProtocolError(() => applyManagedAgentEvent(
        usage,
        envelope(3, { type: "usage.updated", usage: { totalTokens: 19 } }),
      ), "illegal_transition");
      expectProtocolError(() => applyManagedAgentEvent(
        usage,
        envelope(3, { type: "usage.updated", usage: { costTotal: Number.NaN } }),
      ), "illegal_transition");
    });

    it.each([
      { type: "run.status", phase: "future", label: "Unknown" },
      { type: "message.started", messageId: "assistant-1", role: "user" },
      { type: "run.waiting", reason: "external" },
    ] as unknown as ManagedAgentEvent[])("rejects unknown closed-contract values for $type", (event) => {
      const started = applyManagedAgentEvent(createInitialAgentConversation(), envelope(1, { type: "run.started" }));
      expectProtocolError(() => applyManagedAgentEvent(started, envelope(2, event)), "illegal_transition");
    });

  });
});
