import {
  applyManagedAgentEvent,
  createInitialAgentConversation,
  MANAGED_AGENT_EVENT_VERSION,
  type ManagedAgentEvent,
  type ManagedAgentEventEnvelope,
} from "../AgentConversation";
import { presentAgentConversation } from "../AgentConversationPresentation";

function envelope(seq: number, event: ManagedAgentEvent): ManagedAgentEventEnvelope {
  return {
    version: MANAGED_AGENT_EVENT_VERSION,
    seq,
    runId: "run-1",
    turnId: "user-1",
    emittedAt: seq,
    event,
  };
}

describe("presentAgentConversation", () => {
  it("uses request pending only until protocol state becomes terminal", () => {
    expect(presentAgentConversation(null, true)).toMatchObject({
      phase: "submitting",
      busy: true,
      composerRunning: true,
    });

    const started = applyManagedAgentEvent(
      createInitialAgentConversation(),
      envelope(1, { type: "run.started" }),
    );
    const completed = applyManagedAgentEvent(
      started,
      envelope(2, { type: "run.completed" }),
    );

    expect(presentAgentConversation(completed, true)).toMatchObject({
      phase: "completed",
      busy: false,
      composerRunning: false,
      activityStatus: "Done",
    });
  });

  it("lets reasoning, tools, and text replace generic status copy", () => {
    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "run.status",
      phase: "working",
      label: "Continuing",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "message.started",
      messageId: "assistant-1",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "text.delta",
      messageId: "assistant-1",
      partId: "text-1",
      delta: "Answer",
    }));

    const presentation = presentAgentConversation(snapshot, true);
    expect(presentation.phase).toBe("responding");
    expect(presentation.visibleParts).toHaveLength(1);
    expect(presentation.visibleParts[0]).toMatchObject({ kind: "text", markdown: "Answer" });
  });

  it("maps approval and settlement to distinct user-facing phases", () => {
    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "message.started",
      messageId: "assistant-1",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "tool.input.started",
      callId: "call-1",
      partId: "tool-1",
      messageId: "assistant-1",
      name: "write",
      location: "vault",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "tool.requested",
      call: {
        callId: "call-1",
        partId: "tool-1",
        messageId: "assistant-1",
        name: "write",
        location: "vault",
        input: { path: "Plan.md" },
      },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(5, {
      type: "approval.requested",
      callId: "call-1",
      approvalId: "approval-1",
    }));
    expect(presentAgentConversation(snapshot, true).phase).toBe("awaiting-approval");
    expect(presentAgentConversation(snapshot, true).activityStatus).toBe("Needs approval");

    let textSnapshot = createInitialAgentConversation();
    textSnapshot = applyManagedAgentEvent(textSnapshot, envelope(1, { type: "run.started" }));
    textSnapshot = applyManagedAgentEvent(textSnapshot, envelope(2, {
      type: "run.status",
      phase: "settling",
      label: "Finishing",
    }));
    expect(presentAgentConversation(textSnapshot, true).phase).toBe("settling");
    expect(presentAgentConversation(textSnapshot, true).activityStatus).toBe("Finishing");
  });

  it("keeps a stopped marker after partial output when the run is cancelled", () => {
    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "message.started",
      messageId: "assistant-1",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "text.delta",
      messageId: "assistant-1",
      partId: "text-1",
      delta: "Partial answer",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, { type: "run.cancelled" }));

    const presentation = presentAgentConversation(snapshot, true);
    expect(presentation.phase).toBe("cancelled");
    expect(presentation.busy).toBe(false);
    expect(presentation.visibleParts.map((part) => part.kind)).toEqual(["text", "status"]);
    expect(presentation.visibleParts.at(-1)).toMatchObject({ kind: "status", label: "Stopped" });
  });
});
