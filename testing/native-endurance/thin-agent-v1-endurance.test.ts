/**
 * @jest-environment node
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlatformRequestInput } from "../../src/services/PlatformRequestClient";
import type { ThinAgentBootstrapRequest } from "../../src/services/managed/ThinAgentV1Contract";
import type { ToolCallResult } from "../../src/types/toolCalls";
import {
  FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
  FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
  type FirstPartyThinAgentJsonValue,
  type FirstPartyThinAgentUserMessage,
} from "../../src/views/chatview/thin/FirstPartyThinAgentProtocol";
import {
  FirstPartyAgentChatSession,
  type FirstPartyAgentLifecycleRecord,
  type FirstPartyAgentRunResult,
} from "../../src/views/chatview/thin/FirstPartyAgentChatSession";
import type {
  FirstPartyThinAgentWebSocket,
} from "../../src/views/chatview/thin/FirstPartyThinAgentSessionTransport";
import { ThinAgentMutationJournal } from "../../src/views/chatview/thin/ThinAgentMutationJournal";

type ToolCall = Readonly<{
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
}>;

type EnduranceFixture = Readonly<{
  fixture_version: string;
  conversation_id: string;
  request_id: string;
  run_id: string;
  round_count: number;
  readonly_cycle: readonly string[];
  parallel_batches: readonly Readonly<{
    round: number;
    tool_names: readonly string[];
  }>[];
  web_search_rounds: readonly number[];
  approved_mutation: Readonly<{
    round: number;
    tool_call_id: string;
    tool_name: string;
    approval_id: string;
    approved: boolean;
    input: Readonly<Record<string, unknown>>;
  }>;
  recovery: Readonly<{
    drop_approval_round: number;
    drop_result_round: number;
    expect_fresh_bootstrap_per_connection: boolean;
    expect_snapshot_first_per_connection: boolean;
  }>;
  mutation_replay: Readonly<{
    tool_call_id: string;
    expected_execution_count: number;
    expected_replayed_result_count: number;
    different_input_is_conflict: boolean;
  }>;
  expected: Readonly<{
    vault_tool_calls: number;
    server_web_search_calls: number;
    successful_tool_result_commands: number;
    tool_result_send_attempts: number;
    successful_tool_approval_commands: number;
    tool_approval_send_attempts: number;
    connection_count: number;
    mutation_executions: number;
    hard_client_continuation_limit: null;
  }>;
}>;

type WirePart = Readonly<Record<string, unknown> & { type: string }>;

type WireMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly WirePart[];
}>;

type RunState =
  | Readonly<{ version: 1; cursor: number; state: "idle" }>
  | Readonly<{
      version: 1;
      cursor: number;
      state: "running" | "waiting_for_client";
      request_id: string;
      run_id: string;
      root_message_id: string;
    }>;

type Frame = Record<string, unknown>;

type CommandFailure = Readonly<{
  kind: string;
  toolCallId?: string;
}>;

type ExecuteLocalTool = (
  call: Readonly<{
    callId: string;
    name: string;
    input: FirstPartyThinAgentJsonValue;
  }>,
  signal: AbortSignal,
) => Promise<ToolCallResult>;

const FIXTURE_PATH = resolve(
  "testing/fixtures/agent/thin-agent-v1-endurance.json",
);
const TEST_PATH = resolve(
  "testing/native-endurance/thin-agent-v1-endurance.test.ts",
);
const fixtureBytes = readFileSync(FIXTURE_PATH);
const fixtureText = fixtureBytes.toString("utf8");
const fixture = JSON.parse(fixtureText) as EnduranceFixture;
const CLIENT_ID = "client_" + "c".repeat(32);
const SESSION_ID = "session_" + "d".repeat(32);
const PLUGIN_BUILD_ID = "sha256:" + "e".repeat(64);
const ASSISTANT_ID = "assistant_endurance";
const MUTATION_PATH = ".systemsculpt/agent-mutations.json";

function roundId(round: number, index: number): string {
  return "tool_round_"
    + String(round).padStart(2, "0")
    + "_"
    + String(index).padStart(2, "0");
}

function readonlyInput(
  name: string,
  round: number,
): Readonly<Record<string, unknown>> {
  const path = "Endurance/source-" + String(round).padStart(2, "0") + ".md";
  switch (name) {
    case "read":
      return { paths: [path] };
    case "find":
      return { patterns: ["source-" + String(round)] };
    case "list_items":
      return { paths: ["Endurance"], limit: 25 };
    case "search":
      return {
        patterns: ["endurance-" + String(round)],
        patternMode: "literal",
      };
    case "context":
      return { action: "add", paths: [path] };
    case "open":
      return { files: [{ path }] };
    default:
      throw new Error("Unsupported deterministic vault tool " + name + ".");
  }
}

function callsForRound(round: number): readonly ToolCall[] {
  if (round === fixture.approved_mutation.round) {
    return [{
      id: fixture.approved_mutation.tool_call_id,
      name: fixture.approved_mutation.tool_name,
      input: fixture.approved_mutation.input,
    }];
  }
  const parallel = fixture.parallel_batches.find((batch) =>
    batch.round === round);
  const names = parallel?.tool_names ?? [
    fixture.readonly_cycle[(round - 1) % fixture.readonly_cycle.length]!,
  ];
  return names.map((name, index) => ({
    id: roundId(round, index + 1),
    name,
    input: readonlyInput(name, round),
  }));
}

function deterministicResult(call: ToolCall): ToolCallResult {
  return {
    success: true,
    data: {
      toolCallId: call.id,
      toolName: call.name,
      ...(call.name === "write"
        ? { path: fixture.approved_mutation.input.path }
        : { observed: true }),
    },
  };
}

function userMessage(id: string, text: string): FirstPartyThinAgentUserMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function wireUser(id: string, text: string): WireMessage {
  return userMessage(id, text);
}

function wireAssistant(parts: readonly WirePart[]): WireMessage {
  return {
    id: ASSISTANT_ID,
    role: "assistant",
    parts,
  };
}

function idle(cursor: number): RunState {
  return { version: 1, cursor, state: "idle" };
}

function active(
  cursor: number,
  state: "running" | "waiting_for_client" = "waiting_for_client",
): RunState {
  return {
    version: 1,
    cursor,
    state,
    request_id: fixture.request_id,
    run_id: fixture.run_id,
    root_message_id: fixture.request_id,
  };
}

function event<TFields extends Record<string, unknown>>(
  kind: string,
  fields: TFields,
): Readonly<Record<string, unknown> & TFields> {
  return {
    type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
    version: 1,
    kind,
    conversation_id: fixture.conversation_id,
    ...fields,
  };
}

function sessionSnapshot(
  messages: readonly WireMessage[],
  runState: RunState,
): Readonly<Record<string, unknown>> {
  return event("session_snapshot", {
    messages,
    run_state: runState,
  });
}

function assistantSnapshot(parts: readonly WirePart[]): Readonly<Record<string, unknown>> {
  return event("assistant_snapshot", {
    request_id: fixture.request_id,
    message: wireAssistant(parts),
  });
}

function runState(value: RunState): Readonly<Record<string, unknown>> {
  return event("run_state", { run_state: value });
}

function succeededTerminal(): Readonly<Record<string, unknown>> {
  return event("terminal", {
    request_id: fixture.request_id,
    terminal: {
      version: 1,
      run_id: fixture.run_id,
      root_message_id: fixture.request_id,
      outcome: "succeeded",
      code: "completed",
    },
  });
}

function clientToolRequest(call: ToolCall): WirePart {
  return {
    type: "data-systemsculpt-client-tool-request",
    id: "request:" + call.id,
    data: {
      version: 1,
      tool_call_id: call.id,
      tool_name: call.name,
      target: { id: "obsidian.vault", version: 1 },
      input: call.input,
    },
  };
}

function inputToolPart(
  call: ToolCall,
  approvalRequested: boolean,
): WirePart {
  return {
    type: "tool-" + call.name,
    toolCallId: call.id,
    state: approvalRequested ? "approval-requested" : "input-available",
    input: call.input,
    ...(approvalRequested
      ? { approval: { id: fixture.approved_mutation.approval_id } }
      : {}),
  };
}

function completedToolPart(call: ToolCall): WirePart {
  return {
    type: "tool-" + call.name,
    toolCallId: call.id,
    state: "output-available",
    input: call.input,
    output: deterministicResult(call),
    ...(call.id === fixture.approved_mutation.tool_call_id
      ? {
          approval: {
            id: fixture.approved_mutation.approval_id,
            approved: true,
          },
        }
      : {}),
  };
}

function bootstrapRequest(): ThinAgentBootstrapRequest {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: fixture.conversation_id,
    client_id: CLIENT_ID,
    plugin_build_id: PLUGIN_BUILD_ID,
    capability_manifest: {
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{ id: "obsidian.vault", version: 1 }],
    },
  };
}

function bootstrapResponse(index: number): Readonly<Record<string, unknown>> {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: fixture.conversation_id,
    session: { id: SESSION_ID },
    access: {
      token: "access_token_endurance_" + String(index).padStart(4, "0"),
      expires_at: "2030-01-01T00:01:00.000Z",
    },
    accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
    client_input_limits: {
      image_mime_types: ["image/png", "image/jpeg", "image/webp"],
      max_content_blocks_per_message: 16,
      max_images_per_turn: 6,
      max_image_bytes: 6_291_456,
      max_total_image_bytes: 16_777_216,
      max_text_bytes_per_block: 1_048_576,
      max_total_text_bytes: 2_097_152,
      max_document_bytes: 26_214_400,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isCommand(frame: Frame): boolean {
  return frame.type === FIRST_PARTY_THIN_AGENT_COMMAND_TYPE;
}

function matchesFailure(frame: Frame, failure: CommandFailure): boolean {
  return isCommand(frame)
    && frame.kind === failure.kind
    && (
      failure.toolCallId === undefined
      || frame.tool_call_id === failure.toolCallId
    );
}

class FakeWebSocket implements FirstPartyThinAgentWebSocket {
  public readyState = 0;
  public readonly attempted: Frame[] = [];
  public readonly sent: Frame[] = [];
  public readonly serverFrames: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private failure: CommandFailure | null = null;

  public addEventListener(
    type: string,
    listener: (event: unknown) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public send(data: string): void {
    if (this.readyState !== 1) throw new Error("Fake socket is not open.");
    const frame = JSON.parse(data) as Frame;
    this.attempted.push(frame);
    if (this.failure && matchesFailure(frame, this.failure)) {
      this.failure = null;
      this.serverClose(1006, "Deterministic send-boundary disconnect.");
      throw new Error("Deterministic send-boundary disconnect.");
    }
    this.sent.push(frame);
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  public open(): void {
    if (this.readyState !== 0) throw new Error("Fake socket opened twice.");
    this.readyState = 1;
    this.emit("open", {});
  }

  public serverMessage(value: unknown): void {
    if (this.readyState !== 1) {
      throw new Error("The fake server cannot message a closed socket.");
    }
    this.serverFrames.push(value);
    this.emit("message", { data: JSON.stringify(value) });
  }

  public serverClose(code = 1006, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  public failNextCommand(kind: string, toolCallId?: string): void {
    if (this.failure) throw new Error("A send failure is already armed.");
    this.failure = {
      kind,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    };
  }

  private emit(type: string, eventValue: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(eventValue);
  }
}

class MemoryDataAdapter {
  public readonly files = new Map<string, string>();
  public readonly directories = new Set<string>();

  public async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  public async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("Missing " + path + ".");
    return value;
  }

  public async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  public async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for " + label + ".");
}

const trackedSessions: FirstPartyAgentChatSession[] = [];

function createHarness(options: Readonly<{
  adapter?: MemoryDataAdapter;
  executeLocalTool?: ExecuteLocalTool;
}> = {}) {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const adapter = options.adapter ?? new MemoryDataAdapter();
  const journal = new ThinAgentMutationJournal(
    adapter,
    MUTATION_PATH,
    () => 1_000,
  );
  let bootstrapIndex = 0;
  const request = jest.fn(async (
    _input: PlatformRequestInput,
  ): Promise<Response> => {
    bootstrapIndex += 1;
    return jsonResponse(bootstrapResponse(bootstrapIndex));
  });
  const executeLocalTool = jest.fn(options.executeLocalTool ?? (async (call) => {
    const deterministic = callsForRound(fixture.approved_mutation.round)
      .find((candidate) => candidate.id === call.callId);
    return deterministic
      ? deterministicResult(deterministic)
      : { success: true, data: { toolCallId: call.callId } };
  }));
  const persistAssistant = jest.fn(async () => undefined);
  const reconcileHistory = jest.fn(async () => undefined);
  const reportError = jest.fn();
  const lifecycle: FirstPartyAgentLifecycleRecord[] = [];
  const agent = new FirstPartyAgentChatSession({
    baseUrl: "https://systemsculpt.test",
    pluginVersion: "6.2.7",
    licenseKey: () => "license_endurance",
    bootstrapRequest,
    mutationJournal: journal,
    executeLocalTool,
    persistAssistant,
    reconcileHistory,
    reportError,
    onLifecycle: (record) => lifecycle.push(record),
    requestClient: { request },
    reconnectDelayMs: () => 0,
    snapshotTimeoutMs: 5_000,
    now: () => 10_000,
    createWebSocket: (url) => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      urls.push(url);
      return socket;
    },
  });
  trackedSessions.push(agent);
  let openedSocketCount = 0;

  return {
    adapter,
    agent,
    sockets,
    urls,
    request,
    executeLocalTool,
    persistAssistant,
    reconcileHistory,
    reportError,
    lifecycle,
    successfulCommands(): Frame[] {
      return sockets.flatMap((socket) => socket.sent).filter(isCommand);
    },
    attemptedCommands(): Frame[] {
      return sockets.flatMap((socket) => socket.attempted).filter(isCommand);
    },
    async openNext(
      messages: readonly WireMessage[],
      state: RunState,
    ): Promise<FakeWebSocket> {
      const index = openedSocketCount;
      await waitFor(
        () => sockets.length > index,
        "first-party socket " + String(index + 1),
      );
      const socket = sockets[index]!;
      openedSocketCount += 1;
      socket.open();
      socket.serverMessage(sessionSnapshot(messages, state));
      return socket;
    },
  };
}

function commandsFor(
  commands: readonly Frame[],
  kind: string,
  toolCallId?: string,
): Frame[] {
  return commands.filter((command) =>
    command.kind === kind
    && (
      toolCallId === undefined
      || command.tool_call_id === toolCallId
    ));
}

function currentMessages(
  userText: string,
  parts: readonly WirePart[],
): readonly WireMessage[] {
  return [
    wireUser(fixture.request_id, userText),
    wireAssistant(parts),
  ];
}

async function completeServerRun(
  socket: FakeWebSocket,
  pending: Promise<FirstPartyAgentRunResult>,
): Promise<FirstPartyAgentRunResult> {
  socket.serverMessage(runState(idle(2)));
  socket.serverMessage(succeededTerminal());
  return pending;
}

afterEach(async () => {
  while (trackedSessions.length > 0) {
    await trackedSessions.pop()!.detach();
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("thin-agent-v1 first-party native endurance", () => {
  it("pins a provider-neutral first-party scenario without legacy runtime dependencies", () => {
    const source = readFileSync(TEST_PATH, "utf8");
    expect(createHash("sha256").update(fixtureBytes).digest("hex"))
      .toBe("44281a7859cb5d2403df89d8392e3a577bd44377e338bdda228e6a90ad74321a");
    expect(fixture.fixture_version).toBe("thin-agent-v1-endurance-3");
    expect(fixture.round_count).toBeGreaterThan(30);
    expect(fixture.expected.hard_client_continuation_limit).toBeNull();
    expect(fixtureText).not.toMatch(
      /(?:openrouter|chat.?completions|cloudflare|think_package|agents_package|ai_package)/iu,
    );
    expect(source).not.toContain(["agents", "chat"].join("/"));
    expect(source).not.toContain(["WebSocket", "ChatTransport"].join(""));
    expect(source).not.toContain(["ThinAgent", "Bridge"].join(""));
    expect(FIRST_PARTY_THIN_AGENT_COMMAND_TYPE)
      .toBe("systemsculpt.agent.command.v1");
    expect(FIRST_PARTY_THIN_AGENT_EVENT_TYPE)
      .toBe("systemsculpt.agent.event.v1");
  });

  it("runs forty ordered rounds and recovers pending approval and result delivery", async () => {
    const userText =
      "Complete the deterministic vault research and editing endurance workflow.";
    const outputs = new Map<string, ToolCallResult>();
    const harness = createHarness({
      executeLocalTool: async (rawCall) => {
        const call = Array.from(
          { length: fixture.round_count },
          (_, index) => callsForRound(index + 1),
        ).flat().find((candidate) => candidate.id === rawCall.callId);
        if (!call) throw new Error("Unknown endurance call " + rawCall.callId + ".");
        const result = deterministicResult(call);
        outputs.set(call.id, result);
        return result;
      },
    });
    const run = harness.agent.start({
      conversationId: fixture.conversation_id,
      turnId: fixture.request_id,
      message: userMessage(fixture.request_id, userText),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    let socket = await harness.openNext([], idle(0));
    await waitFor(
      () => commandsFor(harness.successfulCommands(), "submit").length >= 1,
      "the first-party submit command",
    );
    socket.serverMessage(sessionSnapshot(
      [wireUser(fixture.request_id, userText)],
      active(1),
    ));

    const parts: WirePart[] = [];
    const expectedPartIds: string[] = [];
    const observedCalls: ToolCall[] = [];

    for (let round = 1; round <= fixture.round_count; round += 1) {
      const reasoningIndex = parts.length;
      parts.push({
        type: "reasoning",
        text: "Planning endurance round " + String(round) + ".",
        state: "streaming",
      });
      socket.serverMessage(assistantSnapshot(parts));
      parts[reasoningIndex] = {
        type: "reasoning",
        text: "Planned endurance round " + String(round) + ".",
        state: "done",
      };
      expectedPartIds.push(
        "reasoning:" + ASSISTANT_ID + ":" + String(reasoningIndex),
      );

      if (fixture.web_search_rounds.includes(round)) {
        const webCallId =
          "server_web_search_" + String(round).padStart(2, "0");
        const webIndex = parts.length;
        parts.push({
          type: "tool-web_search",
          toolCallId: webCallId,
          state: "input-available",
          input: { query: "endurance research round " + String(round) },
        });
        socket.serverMessage(assistantSnapshot(parts));
        parts[webIndex] = {
          type: "tool-web_search",
          toolCallId: webCallId,
          state: "output-available",
          input: { query: "endurance research round " + String(round) },
          output: {
            success: true,
            data: { matches: 2, round },
          },
        };
        parts.push({
          type: "source-url",
          url: "https://example.com/endurance/" + String(round),
          title: "Endurance source " + String(round),
        });
        expectedPartIds.push("tool:" + webCallId);
      }

      const calls = callsForRound(round);
      observedCalls.push(...calls);
      const indexes = new Map<string, number>();
      for (const call of calls) {
        parts.push(clientToolRequest(call));
        const toolIndex = parts.length;
        indexes.set(call.id, toolIndex);
        parts.push(inputToolPart(
          call,
          call.id === fixture.approved_mutation.tool_call_id,
        ));
        expectedPartIds.push("tool:" + call.id);
      }

      const mutation = calls.find((call) =>
        call.id === fixture.approved_mutation.tool_call_id);
      const droppedResult = round === fixture.recovery.drop_result_round
        ? calls[0]
        : undefined;
      if (mutation) {
        socket.failNextCommand("client_tool_approval", mutation.id);
      } else if (droppedResult) {
        socket.failNextCommand("client_tool_result", droppedResult.id);
      }
      socket.serverMessage(assistantSnapshot(parts));

      if (mutation) {
        expect(harness.agent.respondToApproval(
          fixture.approved_mutation.approval_id,
          fixture.approved_mutation.approved,
        )).toBe(true);
        await waitFor(
          () => commandsFor(
            harness.attemptedCommands(),
            "client_tool_approval",
            mutation.id,
          ).length >= 1 && socket.readyState === 3,
          "the interrupted approval attempt",
        );
        socket = await harness.openNext(
          currentMessages(userText, parts),
          active(1),
        );
        await waitFor(
          () => commandsFor(
            harness.successfulCommands(),
            "client_tool_approval",
            mutation.id,
          ).length >= 1,
          "the recovered approval command",
        );
        expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
          call.callId === mutation.id)).toHaveLength(0);
        const mutationIndex = indexes.get(mutation.id)!;
        parts[mutationIndex] = {
          type: "tool-" + mutation.name,
          toolCallId: mutation.id,
          state: "approval-responded",
          input: mutation.input,
          approval: {
            id: fixture.approved_mutation.approval_id,
            approved: true,
          },
        };
        socket.serverMessage(assistantSnapshot(parts));
      }

      if (droppedResult) {
        await waitFor(
          () => commandsFor(
            harness.attemptedCommands(),
            "client_tool_result",
            droppedResult.id,
          ).length >= 1 && socket.readyState === 3,
          "the interrupted tool result attempt",
        );
        socket = await harness.openNext(
          currentMessages(userText, parts),
          active(1),
        );
      }

      for (const call of calls) {
        await waitFor(
          () => commandsFor(
            harness.successfulCommands(),
            "client_tool_result",
            call.id,
          ).length >= 1,
          "the tool result for " + call.id,
        );
        parts[indexes.get(call.id)!] = completedToolPart(call);
      }
      socket.serverMessage(assistantSnapshot(parts));

      const textIndex = parts.length;
      parts.push({
        type: "text",
        text: "Round " + String(round),
        state: "streaming",
      });
      socket.serverMessage(assistantSnapshot(parts));
      parts[textIndex] = {
        type: "text",
        text: "Round " + String(round) + " complete.",
        state: "done",
      };
      socket.serverMessage(assistantSnapshot(parts));
      expectedPartIds.push(
        "text:" + ASSISTANT_ID + ":" + String(textIndex),
      );
    }

    const result = await completeServerRun(socket, run);
    expect(result.kind).toBe("completed");
    const finalSnapshot = result.snapshot;
    const finalPartIds = [
      ...expectedPartIds,
      "sources:" + ASSISTANT_ID,
    ];
    expect(finalSnapshot.parts.map((part) => part.id)).toEqual(finalPartIds);
    expect(finalSnapshot.parts.map((part) => part.order))
      .toEqual(finalSnapshot.parts.map((_, index) => index));
    expect(finalSnapshot.messages).toEqual([{
      id: ASSISTANT_ID,
      role: "assistant",
      partIds: finalPartIds,
    }]);
    expect(finalSnapshot.parts.filter((part) => part.kind === "tool"))
      .toHaveLength(
        fixture.expected.vault_tool_calls
        + fixture.expected.server_web_search_calls,
      );
    expect(finalSnapshot.parts.filter((part) =>
      part.kind === "tool" && part.location === "vault"))
      .toHaveLength(fixture.expected.vault_tool_calls);
    expect(finalSnapshot.parts.filter((part) =>
      part.kind === "tool"
      && part.location === "server"
      && part.name === "web_search"))
      .toHaveLength(fixture.expected.server_web_search_calls);
    expect(finalSnapshot.parts.filter((part) =>
      part.kind === "tool" && part.state !== "succeeded"))
      .toHaveLength(0);

    const successful = harness.successfulCommands();
    const attempted = harness.attemptedCommands();
    expect(observedCalls).toHaveLength(fixture.expected.vault_tool_calls);
    expect(outputs.size).toBe(fixture.expected.vault_tool_calls);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === fixture.approved_mutation.tool_call_id))
      .toHaveLength(fixture.expected.mutation_executions);
    const successfulResultCounts = new Map<string, number>();
    for (const command of commandsFor(successful, "client_tool_result")) {
      const callId = String(command.tool_call_id);
      successfulResultCounts.set(
        callId,
        (successfulResultCounts.get(callId) ?? 0) + 1,
      );
    }
    expect([...successfulResultCounts].filter(([, count]) => count !== 1))
      .toEqual([]);
    expect(commandsFor(successful, "client_tool_result"))
      .toHaveLength(fixture.expected.successful_tool_result_commands);
    expect(commandsFor(attempted, "client_tool_result"))
      .toHaveLength(fixture.expected.tool_result_send_attempts);
    expect(commandsFor(successful, "client_tool_approval"))
      .toHaveLength(fixture.expected.successful_tool_approval_commands);
    expect(commandsFor(attempted, "client_tool_approval"))
      .toHaveLength(fixture.expected.tool_approval_send_attempts);
    expect(harness.sockets).toHaveLength(fixture.expected.connection_count);
    expect(harness.request).toHaveBeenCalledTimes(
      fixture.expected.connection_count,
    );
    expect(harness.sockets.every((candidate) => {
      const first = candidate.serverFrames[0] as Frame | undefined;
      return first?.kind === "session_snapshot";
    })).toBe(fixture.recovery.expect_snapshot_first_per_connection);
    const accessTokens = harness.urls.map((url) =>
      new URL(url).searchParams.get("access_token"));
    expect(new Set(accessTokens).size).toBe(
      fixture.recovery.expect_fresh_bootstrap_per_connection
        ? fixture.expected.connection_count
        : 1,
    );
    expect(JSON.stringify([...successful, ...attempted]))
      .not.toMatch(/(?:cf_agent|resume|continuation|use_chat)/iu);
    expect(fixture.round_count).toBe(40);
    expect(fixture.expected.hard_client_continuation_limit).toBeNull();
    expect(harness.persistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: ASSISTANT_ID,
        content: expect.stringContaining("Round 40 complete."),
        tool_calls: expect.arrayContaining([
          expect.objectContaining({
            id: fixture.approved_mutation.tool_call_id,
            state: "completed",
          }),
          expect.objectContaining({
            id: "server_web_search_35",
            executedOn: "server",
          }),
        ]),
      }),
    );
    expect(harness.executeLocalTool).toHaveBeenCalledTimes(
      fixture.expected.vault_tool_calls,
    );
  });

  it("replays an approved mutation after client replacement without executing twice", async () => {
    const adapter = new MemoryDataAdapter();
    const mutation = callsForRound(fixture.approved_mutation.round)[0]!;
    const result = deterministicResult(mutation);
    const execute = jest.fn(async () => result);
    const userText = "Apply the approved endurance mutation exactly once.";
    const parts: WirePart[] = [
      clientToolRequest(mutation),
      inputToolPart(mutation, true),
    ];

    const first = createHarness({ adapter, executeLocalTool: execute });
    const firstRun = first.agent.start({
      conversationId: fixture.conversation_id,
      turnId: fixture.request_id,
      message: userMessage(fixture.request_id, userText),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    const firstSocket = await first.openNext([], idle(0));
    await waitFor(
      () => commandsFor(first.successfulCommands(), "submit").length >= 1,
      "the mutation replay setup submit",
    );
    firstSocket.serverMessage(sessionSnapshot(
      [wireUser(fixture.request_id, userText)],
      active(1),
    ));
    firstSocket.serverMessage(assistantSnapshot(parts));
    expect(first.agent.respondToApproval(
      fixture.approved_mutation.approval_id,
      true,
    )).toBe(true);
    await waitFor(
      () => commandsFor(
        first.successfulCommands(),
        "client_tool_approval",
        mutation.id,
      ).length >= 1,
      "the approved mutation decision",
    );
    parts[1] = {
      type: "tool-" + mutation.name,
      toolCallId: mutation.id,
      state: "approval-responded",
      input: mutation.input,
      approval: {
        id: fixture.approved_mutation.approval_id,
        approved: true,
      },
    };
    firstSocket.serverMessage(assistantSnapshot(parts));
    await waitFor(
      () => commandsFor(
        first.successfulCommands(),
        "client_tool_result",
        mutation.id,
      ).length >= 1,
      "the first mutation result",
    );
    const firstResult = commandsFor(
      first.successfulCommands(),
      "client_tool_result",
      mutation.id,
    )[0]!;
    expect(execute).toHaveBeenCalledTimes(
      fixture.mutation_replay.expected_execution_count,
    );

    await first.agent.detach();
    await expect(firstRun).resolves.toMatchObject({ kind: "cancelled" });

    const replacement = createHarness({ adapter, executeLocalTool: execute });
    const hydrate = replacement.agent.hydrate(fixture.conversation_id);
    const replacementSocket = await replacement.openNext(
      currentMessages(userText, parts),
      active(1),
    );
    await hydrate;
    await waitFor(
      () => commandsFor(
        replacement.successfulCommands(),
        "client_tool_result",
        mutation.id,
      ).length >= fixture.mutation_replay.expected_replayed_result_count,
      "the journal-backed mutation replay result",
    );
    const replayedResult = commandsFor(
      replacement.successfulCommands(),
      "client_tool_result",
      mutation.id,
    )[0]!;
    expect(replayedResult.output).toEqual(firstResult.output);
    expect(execute).toHaveBeenCalledTimes(
      fixture.mutation_replay.expected_execution_count,
    );
    expect(replacement.lifecycle).toContainEqual(expect.objectContaining({
      code: "mutation_replay_served",
      toolCallId: mutation.id,
    }));

    if (fixture.mutation_replay.different_input_is_conflict) {
      const conflictJournal = new ThinAgentMutationJournal(
        adapter,
        MUTATION_PATH,
        () => 2_000,
      );
      await expect(conflictJournal.claim(
        fixture.conversation_id,
        mutation.id,
        mutation.name,
        { different: true },
      )).resolves.toEqual({ kind: "conflict" });
    }

    parts[1] = completedToolPart(mutation);
    parts.push({
      type: "text",
      text: "The approved mutation completed exactly once.",
      state: "done",
    });
    replacementSocket.serverMessage(assistantSnapshot(parts));
    replacementSocket.serverMessage(runState(idle(2)));
    replacementSocket.serverMessage(succeededTerminal());
    await waitFor(
      () => replacement.agent.getSnapshot().status === "completed",
      "the recovered mutation run to complete",
    );
    expect(replacement.persistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The approved mutation completed exactly once.",
        tool_calls: [
          expect.objectContaining({
            id: mutation.id,
            state: "completed",
          }),
        ],
      }),
    );
  });

  it("returns a thrown vault failure and lets server authority complete the run", async () => {
    const userText = "Read the failure fixture and continue if the vault rejects it.";
    const call: ToolCall = {
      id: "tool_failure_recovery",
      name: "read",
      input: { paths: ["Endurance/failure.md"] },
    };
    const harness = createHarness({
      executeLocalTool: async () => {
        throw new Error("deterministic vault read failure");
      },
    });
    const run = harness.agent.start({
      conversationId: fixture.conversation_id,
      turnId: fixture.request_id,
      message: userMessage(fixture.request_id, userText),
    });
    const socket = await harness.openNext([], idle(0));
    await waitFor(
      () => commandsFor(harness.successfulCommands(), "submit").length >= 1,
      "the thrown-tool submit",
    );
    socket.serverMessage(sessionSnapshot(
      [wireUser(fixture.request_id, userText)],
      active(1),
    ));
    const parts: WirePart[] = [
      clientToolRequest(call),
      inputToolPart(call, false),
    ];
    socket.serverMessage(assistantSnapshot(parts));
    await waitFor(
      () => commandsFor(
        harness.successfulCommands(),
        "client_tool_result",
        call.id,
      ).length >= 1,
      "the thrown tool error result",
    );
    expect(commandsFor(
      harness.successfulCommands(),
      "client_tool_result",
      call.id,
    )).toEqual([expect.objectContaining({
      state: "output-error",
      error_text: "deterministic vault read failure",
    })]);
    expect(harness.agent.getSnapshot().status).not.toBe("failed");
    expect(commandsFor(harness.successfulCommands(), "cancel")).toHaveLength(0);

    parts[1] = {
      type: "tool-read",
      toolCallId: call.id,
      state: "output-error",
      input: call.input,
      errorText: "deterministic vault read failure",
    };
    parts.push({
      type: "text",
      text: "I could not read that file, so I continued safely.",
      state: "done",
    });
    socket.serverMessage(assistantSnapshot(parts));
    const result = await completeServerRun(socket, run);
    expect(result).toMatchObject({
      kind: "completed",
      message: {
        message_id: ASSISTANT_ID,
        content: "I could not read that file, so I continued safely.",
      },
    });
    expect(harness.executeLocalTool).toHaveBeenCalledTimes(1);
    expect(harness.persistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "I could not read that file, so I continued safely.",
        tool_calls: [
          expect.objectContaining({
            id: call.id,
            state: "failed",
          }),
        ],
      }),
    );
  });
});
