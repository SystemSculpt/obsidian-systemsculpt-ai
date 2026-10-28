import { ClientLatency } from "../ClientLatency";
import type { AgentLifecycleInput } from "../Lifecycle";

const CONVERSATION_ID = `conversation_${"a".repeat(32)}`;
const REQUEST_ID = "user-76712c65-86b6-4408-8dfc-6de89d79a479";

function createLatency() {
  let now = 100;
  const records: AgentLifecycleInput[] = [];
  const activeRun = {
    conversationId: CONVERSATION_ID,
    requestId: REQUEST_ID,
    serverRunId: null,
  };
  const latency = new ClientLatency({
    monotonicNow: () => now,
    activeRun: () => activeRun,
    toolName: () => "read",
    recordLifecycle: (record) => records.push(record),
  });
  latency.ensure({ ...activeRun, startedAtMonotonicMs: 90 });
  return { latency, records, activeRun, setNow: (value: number) => { now = value; } };
}

describe("ClientLatency", () => {
  it("owns retained clocks without exposing or resetting their backing records", () => {
    const { latency, setNow } = createLatency();
    expect(latency.elapsed(CONVERSATION_ID, REQUEST_ID)).toBe(10);
    latency.ensure({
      conversationId: CONVERSATION_ID,
      requestId: REQUEST_ID,
      startedAtMonotonicMs: 0,
    });
    setNow(120);
    expect(latency.elapsed(CONVERSATION_ID, REQUEST_ID)).toBe(30);
    expect(latency.elapsed("other-conversation", REQUEST_ID)).toBeNull();
    expect(latency.fields(REQUEST_ID)).toEqual({ clientMonotonicOffsetMs: 30 });
    setNow(110);
    expect(latency.fields(REQUEST_ID)).toEqual({ clientMonotonicOffsetMs: 30 });
    latency.clear();
    expect(latency.elapsed(CONVERSATION_ID, REQUEST_ID)).toBeNull();
    expect(latency.fields(REQUEST_ID)).toEqual({});
  });

  it("correlates acknowledgements and terminal frames only during their delivery", () => {
    const { latency } = createLatency();
    const timing = {
      requestId: REQUEST_ID,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 2,
      observedAtMonotonicMs: 100,
      toolCallId: "call-one",
    } as const;
    latency.handleTransportTiming({ ...timing, milestone: "command_ack_sse_frame" });
    expect(latency.commandAckSegmentOrdinal(REQUEST_ID, "client_tool_result", "call-one")).toBe(2);
    expect(latency.commandAckSegmentOrdinal(REQUEST_ID, "client_tool_result", "call-two")).toBeUndefined();
    latency.handleTransportTiming({ ...timing, milestone: "command_ack_sse_frame_delivery_completed" });
    expect(latency.commandAckSegmentOrdinal(REQUEST_ID, "client_tool_result", "call-one")).toBeUndefined();
    latency.handleTransportTiming({ ...timing, milestone: "terminal_sse_frame" });
    expect(latency.acceptTerminal(REQUEST_ID)).toBe(2);
    latency.handleTransportTiming({ ...timing, milestone: "terminal_sse_frame_delivery_completed" });
    expect(latency.acceptTerminal(REQUEST_ID)).toBeUndefined();
    expect(latency.terminalSegmentOrdinal(REQUEST_ID)).toBe(2);
  });

  it("requires a local execution before transport can receive a tool ordinal", () => {
    const { latency, records, activeRun } = createLatency();
    const timing = {
      requestId: REQUEST_ID,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 1,
      observedAtMonotonicMs: 100,
      toolCallId: "call-one",
      milestone: "command_dispatch_started",
    } as const;
    latency.handleTransportTiming(timing);
    expect(records[0]).not.toHaveProperty("toolExecutionOrdinal");
    expect(latency.needsToolRenderMilestone("local_tool_terminal_dom_committed", REQUEST_ID, "call-one")).toBe(false);
    expect(latency.ensureToolExecutionOrdinal(activeRun, "call-one")).toBe(1);
    latency.handleTransportTiming({ ...timing, commandSegmentOrdinal: 2 });
    expect(records[1]).toMatchObject({ toolExecutionOrdinal: 1, commandSegmentOrdinal: 2 });
    latency.recordToolRenderMilestone("local_tool_terminal_dom_committed", REQUEST_ID, "call-one", 110);
    expect(records[2]).toMatchObject({ toolExecutionOrdinal: 1, commandSegmentOrdinal: 2 });
    expect(latency.needsToolRenderMilestone("local_tool_terminal_dom_committed", REQUEST_ID, "call-one")).toBe(false);
  });
});
