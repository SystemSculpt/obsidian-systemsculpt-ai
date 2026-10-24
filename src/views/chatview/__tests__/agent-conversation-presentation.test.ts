import type { AgentConversationSnapshot, AgentToolPart } from "../../../chat/ChatConversation";
import {
  presentAgentConversation,
  presentAgentError,
  presentAgentErrorMessage,
} from "../AgentConversationPresentation";

describe("AgentConversationPresentation product-copy boundary", () => {
  it("prefers the plugin-local report ID for client-only failures", () => {
    expect(presentAgentError({
      code: "response_start_failed",
      message: "private transport text",
      retryable: true,
      reportId: `report_${"f".repeat(32)}`,
    }, true)).toMatchObject({
      heading: "Could not finish",
      reportId: `report_${"f".repeat(32)}`,
    });
  });

  it.each([
    {
      code: "agent_connection_closed",
      message: "The agent connection ticket is invalid.",
      heading: "Response interrupted",
      visibleMessage: "Retry this message to continue.",
    },
    {
      code: "agent_stream_error",
      message: "The WebSocket closed unexpectedly.",
      heading: "Response interrupted",
      visibleMessage: "Retry this message to continue.",
    },
    {
      code: "response_interrupted",
      message: "Stream error",
      heading: "Response interrupted",
      visibleMessage: "Retry this message to continue.",
    },
    {
      code: "agent_bootstrap_failed",
      message: "The transport failed during bootstrap.",
      heading: "Could not finish",
      visibleMessage: "SystemSculpt could not complete the response.",
    },
    {
      code: "agent_bootstrap_failed",
      message: "Bootstrap could not obtain a ticket.",
      heading: "Could not finish",
      visibleMessage: "SystemSculpt could not complete the response.",
    },
    {
      code: "agent_provider_failed",
      message: "The Cloudflare AI SDK provider failed.",
      heading: "Could not finish",
      visibleMessage: "SystemSculpt could not complete the response.",
    },
    {
      code: "server_failed",
      message: "OpenRouter rejected the response.",
      heading: "Could not finish",
      visibleMessage: "SystemSculpt could not complete the response.",
    },
    {
      code: "server_failed",
      message: "Think could not continue this run.",
      heading: "Could not finish",
      visibleMessage: "SystemSculpt could not complete the response.",
    },
    {
      code: "server_failed",
      message: "Pi returned an invalid event.",
      heading: "Could not finish",
      visibleMessage: "SystemSculpt could not complete the response.",
    },
  ])("never exposes internal connection wording: $message", ({
    code,
    message,
    heading,
    visibleMessage,
  }) => {
    const presented = presentAgentError({
      code,
      message,
      retryable: true,
    }, true);
    const visible = `${presented.heading} ${presented.message}`;

    expect(presented).toEqual({ heading, message: visibleMessage });
    expect(visible).not.toMatch(
      /connection|websocket|socket|ticket|bootstrap|transport|protocol|provider|cloudflare|openrouter|think|\bpi\b|ai sdk|cf_agent/i,
    );
  });

  it("surfaces a valid server report id on a final failure", () => {
    expect(presentAgentError({
      code: "agent_turn_failed",
      message: "Provider detail that must stay hidden.",
      incidentId: "incident_0123456789abcdef0123456789abcdef",
    }, false)).toEqual({
      heading: "Could not finish",
      message: "SystemSculpt could not complete the response.",
      reportId: "incident_0123456789abcdef0123456789abcdef",
    });
  });

  it("drops a malformed report id instead of rendering it", () => {
    expect(presentAgentError({
      code: "agent_turn_failed",
      message: "failed",
      incidentId: "openrouter-request-778899",
    }, false)).toEqual({
      heading: "Could not finish",
      message: "SystemSculpt could not complete the response.",
    });
  });

  it("keeps the report id available when a retry may recover the turn", () => {
    expect(presentAgentError({
      code: "agent_connection_closed",
      message: "The agent connection ticket is invalid.",
      incidentId: "incident_0123456789abcdef0123456789abcdef",
      retryable: true,
    }, true)).toEqual({
      heading: "Response interrupted",
      message: "Retry this message to continue.",
      reportId: "incident_0123456789abcdef0123456789abcdef",
    });
  });

  it("omits the report id on credits errors", () => {
    expect(presentAgentError({
      code: "out_of_credits",
      message: "failed",
      incidentId: "incident_0123456789abcdef0123456789abcdef",
    }, false)).toEqual({
      heading: "Out of credits",
      message: "You have no credits left. Add credits to continue using Chat.",
      action: "add-credits",
    });
  });

  it("uses natural terminal headings with fixed first-party copy", () => {
    expect(presentAgentError({
      code: "vault_failed",
      message: "The selected vault file is no longer available.",
    }, false)).toEqual({
      heading: "Could not finish",
      message: "SystemSculpt could not complete the response.",
    });
  });

  it("shows actionable first-party copy for a safety filter", () => {
    expect(presentAgentError({
      code: "content_filter",
      message: "Provider detail that must stay hidden.",
    }, false)).toEqual({
      heading: "Could not finish",
      message: "The safety filter stopped this response. Change the request and try again.",
    });
  });

  it.each([
    {
      code: "insufficient_credits",
      heading: "Not enough credits",
      message: "Not enough credits are available. Add credits to continue using Chat.",
    },
    {
      code: "out_of_credits",
      heading: "Out of credits",
      message: "You have no credits left. Add credits to continue using Chat.",
    },
  ])("shows actionable first-party billing copy for $code", ({ code, heading, message }) => {
    expect(presentAgentError({
      code,
      message: "Unsafe remote billing detail.",
    }, false)).toEqual({ heading, message, action: "add-credits" });
  });

  it.each(["out_of_credits", "insufficient_credits", "payment_required"])(
    "offers monthly before credit packs for a non-entitled account with %s",
    (code) => {
      expect(presentAgentError({ code, message: "Remote billing detail." }, false, true)).toEqual({
        heading: "Out of credits",
        message: "Monthly is $9 and includes 10,000 credits every month. You can also add a credit pack.",
        action: "see-plans",
      });
    },
  );

  it("uses the same final copy filter for global banners and tool failures", () => {
    expect(presentAgentErrorMessage(
      "Agent connection closed: WebSocket closed with code 4001",
      true,
    )).toBe("Retry this message to continue.");
    expect(presentAgentErrorMessage(
      "Connection lost.",
      true,
    )).toBe("Retry this message to continue.");
    expect(presentAgentErrorMessage(
      "The cf_agent protocol frame was invalid.",
      false,
    )).toBe("SystemSculpt could not complete the response.");
    expect(presentAgentErrorMessage(
      "The selected vault file is no longer available.",
      false,
    )).toBe("SystemSculpt could not complete the response.");
  });

  it("projects no duplicate status part beside the single activity header", () => {
    const visibleText = {
      id: "text-1",
      kind: "text" as const,
      messageId: "assistant-1",
      state: "streaming" as const,
      markdown: "Working",
      order: 0,
    };
    const presentation = presentAgentConversation({
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "thinking",
      statusLabel: "Starting",
      messages: [{
        id: "assistant-1",
        role: "assistant",
        partIds: ["text-1"],
      }],
      parts: [visibleText],
    }, true);

    expect(presentation.activityStatus).toBe("Writing");
    expect(presentation.visibleParts).toEqual([visibleText]);
  });

  it("lets terminal truth override a stale in-flight tool presenter", () => {
    const staleSearch = {
      id: "tool-1",
      kind: "tool" as const,
      messageId: "assistant-1",
      callId: "call-1",
      name: "web_search",
      location: "server" as const,
      input: { query: "latest" },
      state: "running" as const,
      order: 0,
    };
    const presentation = presentAgentConversation({
      runId: "run-1",
      turnId: "user-1",
      status: "failed",
      phase: "working",
      statusLabel: "Reconnecting",
      messages: [{
        id: "assistant-1",
        role: "assistant",
        partIds: ["tool-1"],
      }],
      parts: [staleSearch],
    }, true);

    expect(presentation).toMatchObject({
      phase: "failed",
      busy: false,
      composerRunning: false,
      activityStatus: "Failed",
    });
  });

  it.each([false, true])("keeps idle snapshots idle despite stale activity and outer pending %s", (pending) => {
    const idle: AgentConversationSnapshot = {
      runId: null,
      turnId: null,
      status: "idle",
      phase: "retrying",
      statusLabel: "Connection interrupted",
      messages: [],
      parts: [{
        id: "stale-text", kind: "text", messageId: "assistant", order: 0,
        state: "streaming", markdown: "Partial answer",
      }, {
        id: "stale-approval", kind: "tool", messageId: "assistant", order: 1,
        callId: "call", name: "write", input: {}, location: "vault",
        state: "approval-required", approvalId: "approval",
      }],
    };
    expect(presentAgentConversation(idle, pending)).toMatchObject({
      phase: "idle", busy: false, composerRunning: false, progressActive: false,
      activityStatus: "Idle", visibleParts: idle.parts,
    });
    expect(presentAgentConversation({ ...idle, parts: [] }, pending)).toMatchObject({
      phase: "idle", busy: false, composerRunning: false, progressActive: false,
    });
  });

  it.each(["running", "waiting"] as const)("pauses progress without ending a %s run during recovery", (status) => {
    const recovering: AgentConversationSnapshot = {
      runId: "run", turnId: "turn", status, phase: "retrying", messages: [],
      parts: [{
        id: "tool", kind: "tool", messageId: "assistant", order: 0,
        callId: "call", name: "web_search", location: "server",
        input: { query: "latest" }, state: "running",
      }],
    };
    for (const statusLabel of ["Reconnecting", "Recovering", "Continuing", "Connection interrupted"]) {
      for (const pending of [false, true]) {
        const presentation = presentAgentConversation({ ...recovering, statusLabel }, pending);
        expect(presentation).toMatchObject({
          phase: "recovering", busy: true, composerRunning: true, progressActive: false,
          activityStatus: statusLabel === "Connection interrupted" ? "Reconnecting" : "Continuing",
        });
        expect(presentation.visibleParts).toBe(recovering.parts);
      }
    }
    expect(presentAgentConversation({ ...recovering, phase: "working" }, false)).toMatchObject({
      phase: "acting", busy: true, composerRunning: true, progressActive: true,
      activityStatus: "Searching",
    });
  });

  it("presents a sustained connection interruption above stale tool activity", () => {
    const staleSearch = {
      id: "tool-1",
      kind: "tool" as const,
      messageId: "assistant-1",
      callId: "call-1",
      name: "web_search",
      location: "server" as const,
      input: { query: "latest" },
      state: "running" as const,
      order: 0,
    };
    const presentation = presentAgentConversation({
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "retrying",
      statusLabel: "Connection interrupted",
      messages: [{
        id: "assistant-1",
        role: "assistant",
        partIds: ["tool-1"],
      }],
      parts: [staleSearch],
    }, true);

    expect(presentation).toMatchObject({
      phase: "recovering",
      busy: true,
      composerRunning: true,
      activityStatus: "Reconnecting",
    });
  });

  it.each(["claude", "codex", "hosted"] as const)("waits for %s approval without marking the turn idle or losing terminal truth", (backend) => {
    const snapshot = {
      runId: "run-approval", turnId: "turn-approval", status: "waiting" as const,
      phase: "waiting" as const, waitingReason: "approval" as const, messages: [],
      parts: [{ id: "tool", kind: "tool" as const, messageId: "assistant", callId: "call", name: "Edit", input: {}, order: 0,
        location: backend === "hosted" ? "vault" as const : "server" as const,
        state: "approval-required" as const, approvalId: "approval",
        ...(backend === "hosted" ? {} : { native: { agent: backend, workingDirectory: "/vault" } }),
      }],
    };
    expect(presentAgentConversation(snapshot, true)).toMatchObject({
      phase: "awaiting-approval", activityStatus: "Waiting for your approval", busy: true, composerRunning: true,
    });
    for (const status of ["completed", "cancelled", "failed"] as const) {
      expect(presentAgentConversation({ ...snapshot, status }, true)).toMatchObject({ phase: status, busy: false, composerRunning: false });
    }
    expect(presentAgentConversation({ ...snapshot, status: "running", parts: [{ ...snapshot.parts[0], state: "approved" }] }, true).phase).toBe("acting");
  });

  it.each([
    { name: "Bash", native: { agent: "claude" as const, workingDirectory: "/vault" }, expected: "Waiting for your approval" },
    { name: "AskUserQuestion", native: { agent: "claude" as const, workingDirectory: "/vault" }, expected: "Waiting for your answer" },
    { name: "requestUserInput", native: { agent: "codex" as const, workingDirectory: "/vault", requestMethod: "item/tool/requestUserInput" }, expected: "Waiting for your answer" },
  ])("projects native $name as a user wait even at the server location", ({ name, native, expected }) => {
    const presentation = presentAgentConversation({
      runId: "run-native-wait",
      turnId: "user-native-wait",
      status: "waiting",
      phase: "waiting",
      elapsedMs: 45_000,
      messages: [],
      parts: [{
        id: "native-wait",
        kind: "tool",
        messageId: "assistant-native-wait",
        callId: "call-native-wait",
        name,
        native,
        location: "server",
        input: {},
        state: "approval-required",
        approvalId: "approval-native-wait",
        order: 0,
      }],
    }, true);

    expect(presentation).toMatchObject({
      phase: "awaiting-approval",
      busy: true,
      composerRunning: true,
      activityStatus: expected,
    });
  });

  it.each(["hosted", "native"] as const)("keeps a pending %s approval actionable through a connection interruption", (backend) => {
    const pending: AgentToolPart = {
      id: "pending-disconnected",
      kind: "tool",
      messageId: "assistant-disconnected",
      callId: "call-disconnected",
      name: backend === "native" ? "Bash" : "write",
      location: backend === "native" ? "server" : "vault",
      ...(backend === "native" ? { native: { agent: "claude" as const, workingDirectory: "/vault" } } : {}),
      input: {},
      state: "approval-required",
      approvalId: "approval-disconnected",
      order: 0,
    };
    const disconnected: AgentConversationSnapshot = {
      runId: "run-disconnected",
      turnId: "user-disconnected",
      status: "running",
      phase: "retrying",
      statusLabel: "Connection interrupted",
      messages: [],
      parts: [pending],
    };

    expect(presentAgentConversation(disconnected, true)).toMatchObject({
      phase: "awaiting-approval",
      busy: true,
      composerRunning: true,
      activityStatus: "Waiting for your approval",
    });
    expect(presentAgentConversation({
      ...disconnected,
      parts: [{ ...pending, state: "approved" }],
    }, true)).toMatchObject({
      phase: "recovering",
      busy: true,
      activityStatus: "Reconnecting",
    });
    expect(presentAgentConversation({ ...disconnected, status: "failed" }, true)).toMatchObject({
      phase: "failed",
      busy: false,
      composerRunning: false,
      activityStatus: "Failed",
    });
  });

  it("uses a connection-specific label before any response arrives", () => {
    expect(presentAgentConversation(null, true)).toMatchObject({
      phase: "submitting",
      busy: true,
      composerRunning: true,
      activityStatus: "Connecting…",
      visibleParts: [],
    });
  });

  it.each(["write", "AskUserQuestion", "requestUserInput"])("never turns a server-owned %s approval-shaped part into vault approval UX", (name) => {
    const presentation = presentAgentConversation({
      runId: "run-server-approval",
      turnId: "user-server-approval",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-server-approval",
        role: "assistant",
        partIds: ["tool-server-approval"],
      }],
      parts: [{
        id: "tool-server-approval",
        kind: "tool",
        messageId: "assistant-server-approval",
        callId: "call-server-approval",
        name,
        location: "server",
        input: {},
        state: "approval-required",
        approvalId: "approval-server",
        order: 0,
      }],
    }, true);

    expect(presentation).toMatchObject({
      phase: "acting",
      busy: true,
      activityStatus: "Thinking",
    });
  });
});
