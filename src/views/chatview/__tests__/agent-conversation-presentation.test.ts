import {
  presentAgentConversation,
  presentAgentError,
  presentAgentErrorMessage,
} from "../AgentConversationPresentation";

describe("AgentConversationPresentation product-copy boundary", () => {
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

    expect(presentation.activityStatus).toBe("Thinking");
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

  it("never turns a server-owned approval-shaped part into vault approval UX", () => {
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
        name: "write",
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
