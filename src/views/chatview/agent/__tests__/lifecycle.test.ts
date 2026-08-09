import {
  AgentLifecycle,
  type AgentLifecycleInput,
} from "../Lifecycle";

describe("AgentLifecycle privacy-safe chronology", () => {
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
