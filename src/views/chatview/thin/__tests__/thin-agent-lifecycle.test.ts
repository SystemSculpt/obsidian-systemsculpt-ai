import {
  ThinAgentLifecycle,
  type ThinAgentLifecycleInput,
} from "../ThinAgentLifecycle";

describe("ThinAgentLifecycle privacy-safe chronology", () => {
  it("records one ordered, bounded, exact diagnostic chronology", () => {
    const persisted: unknown[] = [];
    let now = 1_000;
    const lifecycle = new ThinAgentLifecycle(
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
      runId: "run_0123456789abcdef",
      toolName: "read",
      toolCallId: "call_0123456789abcdef",
      incidentId: "incident_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    expect(lifecycle.diagnosticFrame(second!)).toEqual({
      type: "systemsculpt.client_diagnostic.v1",
      payload: {
        version: 1,
        severity: "info",
        code: "local_tool_started",
        phase: "tool_execution",
        run_id: "run_0123456789abcdef",
        tool_name: "read",
        tool_call_id: "call_0123456789abcdef",
        incident_id: "incident_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(first).not.toBeNull();
    expect(third).not.toBeNull();
  });

  it("rejects unknown codes and phases without advancing sequence", () => {
    const persisted: unknown[] = [];
    const lifecycle = new ThinAgentLifecycle((record) => persisted.push(record), () => 10);

    expect(lifecycle.record({
      code: "prompt_captured",
      phase: "response",
    } as unknown as ThinAgentLifecycleInput)).toBeNull();
    expect(lifecycle.record({
      code: "run_started",
      phase: "context",
    } as unknown as ThinAgentLifecycleInput)).toBeNull();
    expect(lifecycle.record({
      code: "run_started",
      phase: "response",
    })).toMatchObject({ sequence: 1 });
    expect(persisted).toHaveLength(1);
  });

  it("drops content fields and invalid identifiers rather than serializing caller objects", () => {
    const persisted: any[] = [];
    const lifecycle = new ThinAgentLifecycle((record) => persisted.push(record), () => 100);
    const hostile = {
      code: "context_prepare_failed",
      phase: "start",
      status: 503,
      retryable: true,
      runId: "contains spaces and /paths",
      toolName: "read Secret.md",
      toolCallId: "call with spaces",
      prompt: "private prompt",
      content: "private content",
      path: "Private.md",
      query: "private query",
      input: { private: true },
      output: { private: true },
      license: "license-secret",
      ticket: "ticket-secret",
      reason: "socket reason",
      incidentId: "incident_not-safe",
      nested: { private: true },
    } as unknown as ThinAgentLifecycleInput;

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
    const serializedFrame = JSON.stringify(lifecycle.diagnosticFrame(record!));
    for (const forbidden of [
      "private prompt",
      "private content",
      "Private.md",
      "private query",
      "license-secret",
      "ticket-secret",
      "socket reason",
      "nested",
    ]) {
      expect(serializedRecord).not.toContain(forbidden);
      expect(serializedFrame).not.toContain(forbidden);
    }
    expect(lifecycle.diagnosticFrame(record!)).toEqual({
      type: "systemsculpt.client_diagnostic.v1",
      payload: {
        version: 1,
        severity: "info",
        code: "context_prepare_failed",
        phase: "start",
        status: 503,
        retryable: true,
      },
    });
  });

  it("keeps lifecycle persistence failures observational only", () => {
    const lifecycle = new ThinAgentLifecycle(() => {
      throw new Error("diagnostics unavailable");
    }, () => 200);

    expect(() => lifecycle.record({
      code: "session_opened",
      phase: "session",
    })).not.toThrow();
  });
});
