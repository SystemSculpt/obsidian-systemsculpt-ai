import { ConversationProjection, type RunPresentation } from "../ConversationProjection";
import { deepFreeze } from "../../../utils/immutableJson";
import type { AgentSessionSnapshot } from "../AuthoritativeSession";
import type { LocalToolCall, WireMessage, WirePart } from "../WireConversation";
import type { ThinAgentRunTerminalData } from "../../../services/managed/ThinAgentV1Contract";

const RUN_ID = `run_${"a".repeat(32)}`;
const user = (id = "user-1") => ({ id, role: "user" as const, parts: [{ type: "text" as const, text: "Help" }] });
const assistant = (parts: readonly WirePart[], id = "assistant-1"): WireMessage => ({ id, role: "assistant", parts });
const call: LocalToolCall = { callId: "call-read", name: "read", input: { paths: ["Note.md"] } };
const request = (action = call): WirePart => ({
  type: "data-systemsculpt-client-tool-request",
  id: `request:${action.callId}`,
  data: { version: 1, tool_call_id: action.callId, tool_name: action.name,
    target: { id: "obsidian.vault", version: 1 }, input: action.input },
});
const tool = (extra: Partial<WirePart> = {}, action = call): WirePart => ({
  type: `tool-${action.name}`, toolCallId: action.callId, input: action.input,
  state: "input-available", ...extra,
});
function snapshot(messages: readonly WireMessage[], optimistic = false): AgentSessionSnapshot<WireMessage> {
  return {
    revision: 1, messages, runState: { version: 1, cursor: 0, state: "idle" },
    terminal: null, queuedRequestIds: [], cancelledQueuedRequestIds: [],
    optimisticUser: optimistic ? { kind: "optimistic_pending_user", request_id: "user-1",
      message: user(), delivery: "sent" } : null,
  };
}
function facts(overrides: Partial<RunPresentation> = {}): RunPresentation {
  return {
    serverRunId: RUN_ID, phase: "working", label: "Working", terminal: null,
    cancelRequested: false, serverQueued: false, elapsedMs: 100, connectionState: "open",
    tools: [{ call, identityConfirmed: true }], executingToolIds: [], ...overrides,
  };
}
function terminal(outcome: "succeeded" | "cancelled" = "cancelled"): ThinAgentRunTerminalData {
  return outcome === "succeeded"
    ? { version: 1, run_id: RUN_ID, root_message_id: "user-1", outcome, code: "completed" }
    : { version: 1, run_id: RUN_ID, root_message_id: "user-1", outcome, code: "cancelled" };
}
function setup() {
  const projection = new ConversationProjection();
  const turn = projection.beginTurn({ turnId: "user-1", requestId: "user-1", origin: "submitted" }, {});
  return { projection, turn };
}

describe("ConversationProjection", () => {
  it("inserts only the matching optimistic root before new assistants and keeps it out of durable authority", () => {
    const projection = new ConversationProjection();
    const prior = [user("old-user"), assistant([{ type: "text", text: "Old reply" }], "old-assistant")];
    projection.observe(snapshot(prior), null);
    const turn = projection.beginTurn({ turnId: "user-1", requestId: "user-1", origin: "submitted" }, {});
    const reply = assistant([{ type: "text", text: "New reply" }]);
    projection.observe(snapshot([...prior, reply], true), turn);
    expect(projection.present(turn, facts()).parts).toContainEqual(expect.objectContaining({ markdown: "New reply" }));
    expect(projection.history({ kind: "prefix", turn, now: 1 })?.messages.map((message) => message.message_id))
      .toEqual(["old-user", "old-assistant"]);
    expect(projection.history({ kind: "presentation", now: 1 })?.messages.map((message) => message.message_id))
      .toEqual(["old-user", "old-assistant", "user-1", "assistant-1"]);
    projection.observe(snapshot([...prior, reply]), turn);
    expect(projection.present(turn, facts()).messages).toHaveLength(0);
  });

  it("keeps prefix content identity stable across equivalent snapshots and empty authority preserves the cache", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user(), assistant([{ type: "text", text: "Partial" }])]), turn);
    const first = projection.history({ kind: "prefix", turn, now: 1 });
    projection.observe(snapshot([user(), assistant([{ type: "text", text: "More" }])]), turn);
    expect(projection.history({ kind: "prefix", turn, now: 2 })).toBe(first);
    projection.present(turn, facts({ terminal: terminal() }));
    expect(projection.history({ kind: "prefix", turn, now: 3 })).toBeNull();
    projection.observe(snapshot([]), turn);
    expect(projection.history({ kind: "presentation", now: 4 })).toBeNull();
  });

  it("preserves every conflicting identity occurrence while retaining display and authorization evidence orders", () => {
    const { projection, turn } = setup();
    const second = { ...call, callId: "call-second" };
    const changed = { ...call, input: { paths: ["Changed.md"] } };
    projection.observe(snapshot([user(), assistant([
      request(call), request(second), tool({}, second), tool(), tool({ state: "output-available", output: {} }, changed),
    ])]), turn);
    const evidence = projection.inspect(turn);
    expect(evidence.requests.map((entry) => entry.callId)).toEqual([call.callId, second.callId]);
    expect(evidence.bindings.map((entry) => entry.input)).toEqual([second.input, call.input, changed.input]);
    expect(evidence.tools.map((entry) => entry.callId)).toEqual([second.callId, call.callId]);
    expect(evidence.clientTools.map((entry) => entry.callId)).toEqual([second.callId, call.callId]);
    expect(evidence.tools.find((entry) => entry.callId === call.callId)?.part.state).toBe("output-available");
    expect(projection.inspect(turn).tools).toBe(evidence.tools);
  });

  it("lets preliminary echoes retain exact local output, then permanently retires it after authoritative completion", () => {
    const { projection, turn } = setup();
    const observe = (part: WirePart) => projection.observe(snapshot([user(), assistant([request(), part])]), turn);
    observe(tool());
    projection.recordLocalResult(turn, call, { success: true, data: { origin: "local" } });
    observe(tool({ state: "output-available", preliminary: true, output: { success: true, data: "preliminary" } }));
    expect(projection.present(turn, facts()).parts[0]).toMatchObject({ state: "succeeded", output: { data: { origin: "local" } } });
    const saved = projection.history({ kind: "terminal", turn, terminal: terminal("succeeded"), tools: facts().tools, now: 5 });
    expect(saved?.assistant?.tool_calls?.[0].result?.data).toEqual({ origin: "local" });
    observe(tool({ state: "output-available", preliminary: false, output: { success: true, data: "final" } }));
    expect(projection.present(turn, facts()).parts[0]).toMatchObject({ output: { data: "final" } });
    observe(tool());
    expect(projection.present(turn, facts()).parts[0]).toMatchObject({ state: "input-ready" });
    expect(projection.present(turn, facts()).parts[0]).not.toHaveProperty("output");
  });

  it("keeps diagnostic reconstruction pure and restores interrupted output with its retained exact approval evidence", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user(), assistant([request(), tool(), { type: "text", text: "Partial" }])]), turn);
    projection.recordLocalResult(turn, call, { success: true, data: { retained: true } });
    projection.present(turn, facts());
    projection.observe(snapshot([user()]), turn);
    const preview = projection.present(turn, facts({ tools: [], terminal: terminal() }), "failure-evidence");
    expect(preview.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", state: "succeeded" }),
      expect.objectContaining({ kind: "text", markdown: "Partial" }),
    ]));
    expect(projection.present(turn, facts({ tools: [] })).parts).toHaveLength(0);
    const history = projection.history({ kind: "terminal", turn, terminal: terminal(), elapsedMs: 42, tools: [], now: 5 });
    expect(history?.messages[1]).toMatchObject({ content: "Partial", terminalOutcome: "cancelled", responseDurationMs: 42 });
    expect(history?.messages[1].tool_calls?.[0].result).toMatchObject({ success: true, data: { retained: true } });
  });

  it("does not retire an overlay or retain a terminal merely by previewing diagnostic evidence", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user(), assistant([request(), tool()])]), turn);
    projection.recordLocalResult(turn, call, { success: true, data: "local" });
    projection.present(turn, facts());
    projection.observe(snapshot([user(), assistant([request(), tool({ state: "output-denied" })])]), turn);
    projection.present(turn, facts({ terminal: terminal() }), "failure-evidence");
    expect(projection.history({ kind: "prefix", turn, now: 1 })).not.toBeNull();
    projection.observe(snapshot([user(), assistant([request(), tool()])]), turn);
    expect(projection.present(turn, facts()).parts[0]).toMatchObject({ state: "succeeded", output: { data: "local" } });
  });

  it("never lends an old local result or approval to a changed identity or a server-owned tool", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user(), assistant([request(), tool()])]), turn);
    projection.recordLocalResult(turn, call, { success: true, data: "local" });
    projection.present(turn, facts());
    const changed = { ...call, input: { paths: ["Other.md"] } };
    projection.observe(snapshot([user(), assistant([request(changed), tool({}, changed)])]), turn);
    expect(projection.present(turn, facts({ tools: [{ call: changed, identityConfirmed: false }] })).parts[0])
      .not.toHaveProperty("output");
    projection.observe(snapshot([user(), assistant([tool({ state: "output-available", output: { success: true, data: "server" } })])]), turn);
    expect(projection.present(turn, facts()).parts[0]).toMatchObject({ location: "server", output: { data: "server" } });
  });

  it("keeps vault activity visible while a replacement temporarily omits the executing tool", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user()]), turn);
    expect(projection.present(turn, facts({ tools: [], executingToolIds: [call.callId] })))
      .toMatchObject({ status: "waiting", waitingReason: "local_tool", statusLabel: "Working in your vault" });
  });

  it("keys history by revision and reuses it for equal content without serializing the transcript", () => {
    const { projection, turn } = setup();
    const stringify = jest.spyOn(JSON, "stringify");
    try {
      projection.observe(snapshot(deepFreeze([user(), assistant([{ type: "text", text: "Done" }])])), turn);
      const first = projection.history({ kind: "presentation", now: 1 })!;
      // A full resynchronization delivers equal content as new objects.
      projection.observe(snapshot(deepFreeze([user(), assistant([{ type: "text", text: "Done" }])])), turn);
      const second = projection.history({ kind: "presentation", now: 2 })!;
      expect(second).toBe(first);
      expect(first.key.length).toBeLessThan(32);
      expect(stringify.mock.calls.some(([value]) => Array.isArray(value)
        && value.some((entry) => (entry as { id?: unknown })?.id === "user-1"))).toBe(false);

      projection.observe(snapshot(deepFreeze([user(), assistant([{ type: "text", text: "Changed" }])])), turn);
      const third = projection.history({ kind: "presentation", now: 3 })!;
      expect(third.key).not.toBe(first.key);
      expect(Object.isFrozen(third.messages[1])).toBe(true);
    } finally {
      stringify.mockRestore();
    }
  });

  it("answers per-frame terminal and assistant checks without analyzing tools", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user(), assistant([request(), tool()])]), turn);
    const analyze = jest.spyOn(projection as unknown as { analyze: () => unknown }, "analyze");
    try {
      const evidence = projection.inspect(turn, "authoritative", RUN_ID);
      expect(evidence.terminal).toBeNull();
      expect(evidence.hasAssistant).toBe(true);
      expect(analyze).not.toHaveBeenCalled();
      expect(evidence.tools.map((entry) => entry.callId)).toEqual(["call-read"]);
      expect(evidence.clientTools).toHaveLength(1);
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(evidence.hasAssistant).toBe(true);
    } finally {
      analyze.mockRestore();
    }
  });

  it("canonicalizes each frozen tool input once across presented frames", () => {
    const { projection, turn } = setup();
    const frozenCall = deepFreeze({ callId: "call-read", name: "read", input: { paths: ["Note.md"] } });
    projection.observe(snapshot(deepFreeze([user(), assistant([request(frozenCall), tool({}, frozenCall)])])), turn);
    const presented = facts({ tools: [{ call: frozenCall, identityConfirmed: true }] });
    projection.present(turn, presented);
    const stringify = jest.spyOn(JSON, "stringify");
    try {
      for (let frame = 0; frame < 5; frame += 1) projection.present(turn, presented);
      // Neither the action key nor the canonical input text is rebuilt.
      expect(stringify.mock.calls.filter(([value]) => value === "paths"
        || (Array.isArray(value) && value[0] === "call-read"))).toEqual([]);
    } finally {
      stringify.mockRestore();
    }
  });

  it("saves a bounded summary of each tool result while keeping presented fields", () => {
    const { projection, turn } = setup();
    const content = "Note body. ".repeat(2_000);
    const output = { success: true, data: { files: [{ path: "Note.md", content }] } };
    projection.observe(snapshot([user(), assistant([
      request(),
      tool({ state: "output-available", output }),
    ])]), turn);
    const saved = projection.history({ kind: "presentation", now: 1 })!.messages[1];
    const result = saved.tool_calls![0].result!;
    const file = (result.data as { files: Array<{ path: string; content: string }> }).files[0];
    expect(result.success).toBe(true);
    expect(file.path).toBe("Note.md");
    expect(file.content.length).toBeLessThan(600);
    expect(file.content).toContain("more characters]");
    expect(saved.messageParts?.find((part) => part.type === "tool_call")?.data)
      .toBe(saved.tool_calls![0]);
    expect(output.data.files[0].content).toBe(content);
  });

  it("protects cached durable graphs and canonical evidence without freezing the caller's wire graph", () => {
    const { projection, turn } = setup();
    const output = { success: true, data: { files: [{ path: "Note.md" }] } };
    projection.observe(snapshot([user(), assistant([request(), tool({ state: "output-available", output })])]), turn);
    const history = projection.history({ kind: "presentation", now: 1 })!;
    const saved = history.messages[1];
    expect(Reflect.set(saved, "content", "poisoned")).toBe(false);
    expect(Reflect.set(saved.tool_calls![0].result!.data as object, "files", [])).toBe(false);
    expect(projection.history({ kind: "presentation", now: 2 })).toBe(history);
    expect(history.messages[1].tool_calls![0].result!.data).toEqual(output.data);
    expect(Object.isFrozen(output)).toBe(false);
    expect(Object.isFrozen(output.data.files)).toBe(false);
    const evidence = projection.inspect(turn);
    expect(Reflect.set(evidence.tools[0], "name", "write")).toBe(false);
    expect(projection.inspect(turn).tools[0].name).toBe("read");
  });

  it("hydrates interrupted tails without creating execution authority and rejects foreign turn handles", () => {
    const { projection, turn } = setup();
    projection.observe(snapshot([user(), assistant([
      { type: "text", text: "Partial" },
      { type: "data-systemsculpt-run-terminal", data: terminal() },
    ])]), null);
    expect(projection.hydratedTail("open")).toMatchObject({ status: "cancelled", turnId: "user-1" });
    expect(() => new ConversationProjection().present(turn, facts())).toThrow("another conversation");
  });
});
