import {
  AgentLifecycle,
  CREDITS_REFRESH_REASONS,
  HISTORY_SYNC_KINDS,
  THIN_AGENT_LIFECYCLE_CODES,
  THIN_AGENT_LIFECYCLE_PHASES,
  type AgentLifecycleInput,
} from "../Lifecycle";
import {
  CREDITS_REFRESH_REASONS as SHARED_CREDITS_REFRESH_REASONS,
  HISTORY_SYNC_KINDS as SHARED_HISTORY_SYNC_KINDS,
  THIN_AGENT_LIFECYCLE_CODES as SHARED_THIN_AGENT_LIFECYCLE_CODES,
  THIN_AGENT_LIFECYCLE_PHASES as SHARED_THIN_AGENT_LIFECYCLE_PHASES,
} from "../../../../utils/ThinAgentLifecycleSchema";

describe("AgentLifecycle privacy-safe chronology", () => {
  it("keeps the Lifecycle compatibility exports bound to the shared schema", () => {
    expect(THIN_AGENT_LIFECYCLE_CODES).toBe(SHARED_THIN_AGENT_LIFECYCLE_CODES);
    expect(THIN_AGENT_LIFECYCLE_PHASES).toBe(SHARED_THIN_AGENT_LIFECYCLE_PHASES);
    expect(CREDITS_REFRESH_REASONS).toBe(SHARED_CREDITS_REFRESH_REASONS);
    expect(HISTORY_SYNC_KINDS).toBe(SHARED_HISTORY_SYNC_KINDS);

    expect(THIN_AGENT_LIFECYCLE_CODES).toEqual(expect.arrayContaining([
      "session_opened",
      "response_stream_ended_incomplete",
      "response_first_assistant_sse_frame_parsed",
      "local_tool_terminal_dom_committed",
      "continuation_content_paint_opportunity",
      "tool_result_command_stream_failed",
      "credits_refresh_succeeded",
    ]));
    expect(THIN_AGENT_LIFECYCLE_PHASES).toEqual([
      "start",
      "session",
      "response",
      "approval",
      "tool_execution",
      "mutation_journal",
      "persistence",
      "render",
      "account",
      "unknown",
    ]);
    expect(CREDITS_REFRESH_REASONS).toEqual([
      "view_open",
      "post_terminal",
      "billing_failure",
      "settings_update",
      "unspecified",
    ]);
    expect(HISTORY_SYNC_KINDS).toEqual([
      "before_send",
      "authoritative_prefix",
      "cancelled_queue",
      "terminal",
    ]);
  });

  it("uses Date.now when no clock is injected", () => {
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(500);
    try {
      const lifecycle = new AgentLifecycle(() => undefined);

      expect(lifecycle.record({
        code: "session_opened",
        phase: "session",
      })).toMatchObject({ timestamp: 500 });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("records one ordered and bounded local chronology", () => {
    const persisted: unknown[] = [];
    let now = 1_000;
    const lifecycle = new AgentLifecycle(
      (record) => persisted.push(record),
      () => now++,
    );

    const first = lifecycle.record({
      code: "run_started",
      phase: "response",
      runId: "run_0123456789abcdef",
    });
    const second = lifecycle.record({
      code: "local_tool_started",
      phase: "tool_execution",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      requestId: "request_0123456789abcdef",
      clientInstanceId: "client_0123456789abcdef0123456789abcdef",
      pluginBuildId: "07bd9378-dirty-20260731T120000000Z",
      runId: "run-local-0123456789abcdef",
      serverRunId: "run_0123456789abcdef0123456789abcdef",
      toolName: "read",
      toolCallId: "call_0123456789abcdef",
      incidentId: "incident_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      failureCode: "response_capacity_unavailable",
    });
    const third = lifecycle.record({
      code: "run_finished_completed",
      phase: "response",
      runId: "run_0123456789abcdef",
    });

    expect(persisted).toEqual([
      expect.objectContaining({ sequence: 1, timestamp: 1_000, code: "run_started" }),
      expect.objectContaining({ sequence: 2, timestamp: 1_001, code: "local_tool_started" }),
      expect.objectContaining({ sequence: 3, timestamp: 1_002, code: "run_finished_completed" }),
    ]);
    expect(second).toMatchObject({
      sequence: 2,
      timestamp: 1_001,
      code: "local_tool_started",
      phase: "tool_execution",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      requestId: "request_0123456789abcdef",
      clientInstanceId: "client_0123456789abcdef0123456789abcdef",
      toolName: "read",
      toolCallId: "call_0123456789abcdef",
      failureCode: "response_capacity_unavailable",
    });
    expect(first).not.toBeNull();
    expect(third).not.toBeNull();
  });

  it("rejects unknown codes and phases without advancing sequence", () => {
    const persisted: unknown[] = [];
    const lifecycle = new AgentLifecycle((record) => persisted.push(record), () => 10);

    expect(lifecycle.record({
      code: "prompt_captured",
      phase: "response",
    } as unknown as AgentLifecycleInput)).toBeNull();
    expect(lifecycle.record({
      code: "run_started",
      phase: "context",
    } as unknown as AgentLifecycleInput)).toBeNull();
    expect(lifecycle.record({
      code: "run_started",
      phase: "response",
    })).toMatchObject({ sequence: 1 });
    expect(persisted).toHaveLength(1);
  });

  it("drops content fields and invalid identifiers rather than serializing caller objects", () => {
    const persisted: any[] = [];
    const lifecycle = new AgentLifecycle((record) => persisted.push(record), () => 100);
    const hostile = {
      code: "context_prepare_failed",
      phase: "start",
      status: 503,
      retryable: true,
      conversationId: "Private.md",
      requestId: "https:private.example.com",
      clientInstanceId: "client_not-safe",
      pluginBuildId: "file:Private.md",
      runId: "contains spaces and /paths",
      serverRunId: "run_not-safe",
      toolName: "web_search",
      toolCallId: "https:private.example.com",
      prompt: "private prompt",
      content: "private content",
      path: "Private.md",
      url: "https://private.example.com",
      arguments: { private: true },
      rawError: "raw provider failure",
      query: "private query",
      input: { private: true },
      output: { private: true },
      license: "license-secret",
      ticket: "ticket-secret",
      reason: "transport reason",
      incidentId: "incident_not-safe",
      nested: { private: true },
    } as unknown as AgentLifecycleInput;

    const record = lifecycle.record(hostile);
    expect(record).toEqual({
      sequence: 1,
      timestamp: 100,
      code: "context_prepare_failed",
      phase: "start",
      status: 503,
      retryable: true,
    });
    const serializedRecord = JSON.stringify(persisted);
    for (const forbidden of [
      "private prompt",
      "private content",
      "Private.md",
      "private query",
      "https://private.example.com",
      "raw provider failure",
      "license-secret",
      "ticket-secret",
      "transport reason",
      "nested",
    ]) {
      expect(serializedRecord).not.toContain(forbidden);
    }
  });

  it.each([
    "mutation_execute_claimed",
    "mutation_replay_served",
    "mutation_outcome_unknown",
    "mutation_call_conflict",
    "diagnostics_truncated",
  ] as const)("accepts the bounded observability code %s", (code) => {
    const lifecycle = new AgentLifecycle(() => undefined, () => 200);

    expect(lifecycle.record({
      code,
      phase: code === "diagnostics_truncated" ? "session" : "mutation_journal",
    })).toMatchObject({ code });
  });

  it.each([
    "request_dispatch_started",
    "request_dispatch_returned",
    "request_dispatch_failed",
  ] as const)("accepts the privacy-safe request boundary code %s", (code) => {
    const lifecycle = new AgentLifecycle(() => undefined, () => 201);

    expect(lifecycle.record({
      code,
      phase: "response",
    })).toEqual({
      sequence: 1,
      timestamp: 201,
      code,
      phase: "response",
    });
  });

  it("records the content-free client latency waterfall without mixing clocks", () => {
    const records: unknown[] = [];
    const lifecycle = new AgentLifecycle((record) => records.push(record), () => 300);
    const trace = "a".repeat(32);
    const codes = [
      "response_available",
      "response_first_body_chunk_observed",
      "response_first_sse_frame_parsed",
      "response_first_assistant_snapshot_received",
      "response_first_content_projected",
      "response_first_dom_committed",
      "response_first_paint_opportunity",
      "response_stream_ended_incomplete",
    ] as const;

    codes.forEach((code, index) => lifecycle.record({
      code,
      phase: code.includes("dom") || code.includes("paint") ? "render" : "response",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      requestId: "user_latency",
      latencyTraceId: trace,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 3,
      clientMonotonicOffsetMs: index + 0.1234,
      ...(code === "response_available"
        ? {
            responseDeliveryMode: "fetch_stream" as const,
            serverTimingAppMs: 12.3456,
            serverTimingAuthMs: 2.5,
          }
        : {}),
    }));

    expect(records).toHaveLength(codes.length);
    expect(records[0]).toMatchObject({
      sequence: 1,
      latencyTraceId: trace,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 3,
      clientMonotonicOffsetMs: 0.123,
      clientClockDomain: "client_turn_monotonic",
      serverTimingAppMs: 12.346,
      serverTimingAuthMs: 2.5,
      responseDeliveryMode: "fetch_stream",
      serverTimingClockDomain: "server_response_headers_monotonic_duration",
    });
    expect(records.map((record: any) => record.code)).toEqual(codes);
    expect(JSON.stringify(records)).not.toContain("prompt");
  });

  it("keeps client and credits-route timing in separate monotonic clock domains", () => {
    const lifecycle = new AgentLifecycle(() => undefined, () => 350);

    expect(lifecycle.record({
      code: "credits_refresh_succeeded",
      phase: "account",
      creditsRefreshReason: "post_terminal",
      creditsRefreshSequence: 2,
      creditsRefreshTransport: "request_url",
      creditsRefreshElapsedMs: 42_345.6789,
      creditsRefreshServerAuthMs: 1.2345,
      creditsRefreshServerRateLimitMs: 2,
      creditsRefreshServerBalanceStoreMs: 39_999.9999,
      creditsRefreshServerTotalMs: 42_000.1255,
      status: 200,
    })).toEqual({
      sequence: 1,
      timestamp: 350,
      code: "credits_refresh_succeeded",
      phase: "account",
      status: 200,
      creditsRefreshReason: "post_terminal",
      creditsRefreshSequence: 2,
      creditsRefreshTransport: "request_url",
      creditsRefreshElapsedMs: 42_345.679,
      creditsRefreshClockDomain: "client_refresh_monotonic_duration",
      creditsRefreshServerAuthMs: 1.235,
      creditsRefreshServerRateLimitMs: 2,
      creditsRefreshServerBalanceStoreMs: 40_000,
      creditsRefreshServerTotalMs: 42_000.126,
      creditsRefreshServerTimingClockDomain:
        "server_response_headers_monotonic_duration",
    });
  });

  it("drops invalid credits refresh classifiers and timings", () => {
    const lifecycle = new AgentLifecycle(() => undefined, () => 375);

    expect(lifecycle.record({
      code: "credits_refresh_failed",
      phase: "account",
      creditsRefreshReason: "private_reason" as never,
      creditsRefreshSequence: 0,
      creditsRefreshTransport: "private_transport" as never,
      creditsRefreshElapsedMs: -1,
      creditsRefreshServerAuthMs: Number.POSITIVE_INFINITY,
      creditsRefreshServerRateLimitMs: -1,
      creditsRefreshServerBalanceStoreMs: 999_999_999,
      creditsRefreshServerTotalMs: Number.NaN,
      status: 500,
    })).toEqual({
      sequence: 1,
      timestamp: 375,
      code: "credits_refresh_failed",
      phase: "account",
      status: 500,
    });
  });

  it("drops invalid trace and timing fields", () => {
    const lifecycle = new AgentLifecycle(() => undefined, () => 400);

    expect(lifecycle.record({
      code: "response_available",
      phase: "response",
      latencyTraceId: "trace_private",
      commandKind: "server_spoofed" as never,
      commandSegmentOrdinal: 0,
      responseDeliveryMode: "server_spoofed" as never,
      clientMonotonicOffsetMs: -1,
      serverTimingAppMs: Number.POSITIVE_INFINITY,
      serverTimingAuthMs: 999_999_999,
    })).toEqual({
      sequence: 1,
      timestamp: 400,
      code: "response_available",
      phase: "response",
    });
  });

  it("keeps only bounded tool and history correlation ordinals", () => {
    const lifecycle = new AgentLifecycle(() => undefined, () => 425);

    expect(lifecycle.record({
      code: "history_sync_completed",
      phase: "persistence",
      historySyncKind: "terminal",
      historySyncOrdinal: 9,
      toolExecutionOrdinal: 3,
    })).toMatchObject({
      historySyncKind: "terminal",
      historySyncOrdinal: 9,
      toolExecutionOrdinal: 3,
    });
    expect(lifecycle.record({
      code: "history_sync_failed",
      phase: "persistence",
      historySyncKind: "private_path" as never,
      historySyncOrdinal: 2_049,
      toolExecutionOrdinal: 513,
    })).toEqual({
      sequence: 2,
      timestamp: 425,
      code: "history_sync_failed",
      phase: "persistence",
    });
  });

  it("keeps lifecycle persistence failures observational only", () => {
    const lifecycle = new AgentLifecycle(() => {
      throw new Error("diagnostics unavailable");
    }, () => 200);

    expect(() => lifecycle.record({
      code: "session_opened",
      phase: "session",
    })).not.toThrow();
  });
});
