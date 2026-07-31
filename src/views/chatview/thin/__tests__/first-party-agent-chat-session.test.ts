import type { PlatformRequestInput } from "../../../../services/PlatformRequestClient";
import {
  parseThinAgentDataPart,
  type ThinAgentBootstrapRequest,
} from "../../../../services/managed/ThinAgentV1Contract";
import type { ToolCallResult } from "../../../../types/toolCalls";
import {
  FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
  type FirstPartyThinAgentUserMessage,
} from "../FirstPartyThinAgentProtocol";
import {
  FirstPartyAgentChatSession,
  type FirstPartyAgentRunResult,
} from "../FirstPartyAgentChatSession";
import type { FirstPartyThinAgentWebSocket } from "../FirstPartyThinAgentSessionTransport";
import { ThinAgentMutationJournal } from "../ThinAgentMutationJournal";

const CONVERSATION_ID = `conversation_${"a".repeat(32)}`;
const CLIENT_ID = `client_${"b".repeat(32)}`;
const SESSION_ID = `session_${"c".repeat(32)}`;
const RUN_ID = `run_${"d".repeat(32)}`;
const PLUGIN_BUILD_ID = `sha256:${"e".repeat(64)}`;
const ACCESS_TOKEN = "access_token_first_party_session_1234567890";

type WireMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly Readonly<Record<string, unknown> & { type: string }>[];
}>;

function userMessage(id: string, text: string): FirstPartyThinAgentUserMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function wireUser(id: string, text: string): WireMessage {
  return userMessage(id, text);
}

function wireAssistant(
  id: string,
  parts: readonly Readonly<Record<string, unknown> & { type: string }>[] | string,
): WireMessage {
  return {
    id,
    role: "assistant",
    parts: typeof parts === "string"
      ? [{ type: "text", text: parts, state: "done" }]
      : parts,
  };
}

function idle(cursor: number) {
  return { version: 1 as const, cursor, state: "idle" as const };
}

function active(
  cursor: number,
  requestId: string,
  rootMessageId: string,
  state: "running" | "waiting_for_client" = "running",
) {
  return {
    version: 1 as const,
    cursor,
    state,
    request_id: requestId,
    run_id: RUN_ID,
    root_message_id: rootMessageId,
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
    conversation_id: CONVERSATION_ID,
    ...fields,
  };
}

function sessionSnapshot(
  messages: readonly WireMessage[],
  runState: ReturnType<typeof idle> | ReturnType<typeof active>,
) {
  return event("session_snapshot", {
    messages,
    run_state: runState,
  });
}

function assistantSnapshot(requestId: string, message: WireMessage) {
  return event("assistant_snapshot", {
    request_id: requestId,
    message,
  });
}

function runState(value: ReturnType<typeof idle> | ReturnType<typeof active>) {
  return event("run_state", { run_state: value });
}

function succeededTerminal(requestId: string, rootMessageId: string) {
  return event("terminal", {
    request_id: requestId,
    terminal: {
      version: 1,
      run_id: RUN_ID,
      root_message_id: rootMessageId,
      outcome: "succeeded",
      code: "completed",
    },
  });
}

function clientToolRequest(
  callId: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  return {
    type: "data-systemsculpt-client-tool-request",
    id: `request:${callId}`,
    data: {
      version: 1,
      tool_call_id: callId,
      tool_name: name,
      target: { id: "obsidian.vault", version: 1 },
      input,
    },
  } as const;
}

function bootstrapRequest(): ThinAgentBootstrapRequest {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: CONVERSATION_ID,
    client_id: CLIENT_ID,
    plugin_build_id: PLUGIN_BUILD_ID,
    capability_manifest: {
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{ id: "obsidian.vault", version: 1 }],
    },
  };
}

function bootstrapResponse() {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: CONVERSATION_ID,
    session: { id: SESSION_ID },
    access: {
      token: ACCESS_TOKEN,
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

class FakeWebSocket implements FirstPartyThinAgentWebSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  public sendBehavior: ((data: string, commit: () => void) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public send(data: string): void {
    if (this.readyState !== 1) throw new Error("Fake socket is not open.");
    const commit = () => this.sent.push(data);
    if (this.sendBehavior) {
      this.sendBehavior(data, commit);
      return;
    }
    commit();
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  public serverMessage(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  public serverError(): void {
    this.emit("error", {});
  }

  private emit(type: string, eventValue: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(eventValue);
  }
}

function journalHarness() {
  let content: string | undefined;
  const adapter = {
    exists: jest.fn(async (path: string) =>
      path === ".systemsculpt/mutations.json" ? content !== undefined : true),
    read: jest.fn(async () => content ?? ""),
    write: jest.fn(async (_path: string, value: string) => {
      content = value;
    }),
    mkdir: jest.fn(async () => undefined),
  };
  return {
    adapter,
    journal: new ThinAgentMutationJournal(
      adapter,
      ".systemsculpt/mutations.json",
      () => 1_000,
    ),
  };
}

type ExecuteLocalTool = (
  call: Readonly<{ callId: string; name: string; input: unknown }>,
  signal: AbortSignal,
) => Promise<ToolCallResult>;

function createHarness(input: Readonly<{
  executeLocalTool?: ExecuteLocalTool;
}> = {}) {
  const sockets: FakeWebSocket[] = [];
  const request = jest.fn(async (_input: PlatformRequestInput): Promise<Response> =>
    jsonResponse(bootstrapResponse()));
  const mutation = journalHarness();
  const executeLocalTool = jest.fn(input.executeLocalTool ?? (async () => ({
    success: true,
    data: { ok: true },
  })));
  const persistAssistant = jest.fn(async () => undefined);
  const reconcileHistory = jest.fn(async () => undefined);
  const reportError = jest.fn();
  const onLifecycle = jest.fn();
  const agent = new FirstPartyAgentChatSession({
    baseUrl: "https://systemsculpt.test",
    pluginVersion: "6.2.7",
    licenseKey: () => "license_test",
    bootstrapRequest,
    mutationJournal: mutation.journal,
    executeLocalTool,
    persistAssistant,
    reconcileHistory,
    reportError,
    onLifecycle,
    requestClient: { request },
    reconnectDelayMs: () => 0,
    snapshotTimeoutMs: 5_000,
    now: () => 10_000,
    createWebSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  });

  return {
    agent,
    sockets,
    request,
    executeLocalTool,
    persistAssistant,
    reconcileHistory,
    reportError,
    onLifecycle,
    mutationAdapter: mutation.adapter,
    async open(messages: readonly WireMessage[] = []): Promise<FakeWebSocket> {
      const pending = agent.hydrate(CONVERSATION_ID);
      await waitFor(() => sockets.length === 1);
      const socket = sockets[0]!;
      socket.open();
      socket.serverMessage(sessionSnapshot(messages, idle(0)));
      await pending;
      return socket;
    },
    commands(socket: FakeWebSocket): Record<string, unknown>[] {
      return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the first-party session test state.");
}

async function waitForResult(
  pending: Promise<FirstPartyAgentRunResult>,
): Promise<FirstPartyAgentRunResult> {
  return await pending;
}

function writeApprovalParts(
  callId: string,
  state: "approval-requested" | "approval-responded" | "output-available" | "output-denied",
  approved?: boolean,
) {
  const input = { path: "Recovered approval.md", content: "Approved once" };
  return [
    clientToolRequest(callId, "write", input),
    {
      type: "tool-write",
      toolCallId: callId,
      state,
      input,
      ...(state === "approval-requested" || state === "approval-responded"
        ? { approval: { id: `approval_${callId}`, ...(approved === undefined ? {} : { approved }) } }
        : state === "output-denied"
          ? { approval: { id: `approval_${callId}`, approved: false } }
          : {}),
      ...(state === "output-available"
        ? { output: { success: true, data: { path: input.path } } }
        : {}),
    },
  ] as const;
}

const sessions: FirstPartyAgentChatSession[] = [];

function trackedHarness(input: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(input);
  sessions.push(harness.agent);
  return harness;
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.detach();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("FirstPartyAgentChatSession", () => {
  it("orders the optimistic user before full assistant replacements and coalesces presentation", async () => {
    const harness = trackedHarness();
    const baseUser = wireUser("user_base", "Earlier question");
    const baseAssistant = wireAssistant("assistant_base", "Earlier answer");
    const socket = await harness.open([baseUser, baseAssistant]);
    harness.reconcileHistory.mockClear();

    const turnId = "user_optimistic";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Research this carefully"),
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(runState(active(1, turnId, turnId)));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const presented: ReturnType<FirstPartyAgentChatSession["getSnapshot"]>[] = [];
    harness.agent.subscribe((snapshot) => presented.push(snapshot));
    socket.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_new", [{
      type: "reasoning",
      text: "Checking",
      state: "streaming",
    }, {
      type: "text",
      text: "Fir",
      state: "streaming",
    }])));
    socket.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_new", [{
      type: "reasoning",
      text: "Checking trusted sources",
      state: "streaming",
    }, {
      type: "text",
      text: "Final",
      state: "streaming",
    }])));
    socket.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_new", [{
      type: "reasoning",
      text: "Checked trusted sources",
      state: "done",
    }, {
      type: "tool-web_search",
      toolCallId: "call_web_search",
      state: "output-available",
      input: { query: "first-party agent sessions" },
      output: { success: true, data: { matches: 2 } },
    }, {
      type: "text",
      text: "Final researched answer",
      state: "streaming",
    }, {
      type: "source-url",
      url: "https://example.com/research",
      title: "Primary research",
    }])));

    expect(presented).toHaveLength(0);
    await waitFor(() => presented.length === 1);
    expect(presented[0]).toMatchObject({
      status: "running",
      phase: "working",
      messages: [{ id: "assistant_new", role: "assistant" }],
    });
    expect(presented[0]!.parts).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        summary: "Checked trusted sources",
        state: "complete",
      }),
      expect.objectContaining({
        kind: "tool",
        callId: "call_web_search",
        name: "web_search",
        location: "server",
        state: "succeeded",
      }),
      expect.objectContaining({
        kind: "text",
        markdown: "Final researched answer",
        state: "streaming",
      }),
      expect.objectContaining({
        kind: "text",
        markdown: "### Sources\n\n- [Primary research](<https://example.com/research>)",
        state: "complete",
      }),
    ]);
    expect(harness.reconcileHistory).not.toHaveBeenCalled();

    socket.serverMessage(succeededTerminal(turnId, turnId));
    const result = await waitForResult(run);
    expect(result).toMatchObject({
      kind: "completed",
      message: {
        role: "assistant",
        message_id: "assistant_new",
      },
    });
    expect(harness.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({
      message_id: "assistant_new",
      content: expect.stringContaining("### Sources"),
      tool_calls: [expect.objectContaining({
        id: "call_web_search",
        executedOn: "server",
      })],
    }));
    const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0];
    expect(reconciled?.slice(-2)).toEqual([
      expect.objectContaining({ role: "user", message_id: turnId }),
      expect.objectContaining({ role: "assistant", message_id: "assistant_new" }),
    ]);
  });

  it("never lets an empty authoritative snapshot erase cache and keeps cache failures nonterminal", async () => {
    const harness = trackedHarness();
    const socket = await harness.open([
      wireUser("user_saved", "Saved question"),
      wireAssistant("assistant_saved", "Saved answer"),
    ]);
    harness.reconcileHistory.mockClear();

    socket.serverMessage(sessionSnapshot([], idle(1)));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.reconcileHistory).not.toHaveBeenCalled();

    const cacheFailure = new Error("Cannot save empty messages over existing chat content");
    const turnId = "user_after_empty_snapshot";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Continue after the fork"),
      beforeSend: async () => {
        throw cacheFailure;
      },
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    expect(harness.reportError).toHaveBeenCalledWith(cacheFailure);
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "history_sync_failed",
      phase: "persistence",
    }));

    socket.serverMessage(runState(active(2, turnId, turnId)));
    socket.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_after_empty_snapshot", "The response still ran."),
    ));
    expect(harness.reconcileHistory).not.toHaveBeenCalled();
    socket.serverMessage(succeededTerminal(turnId, turnId));

    await expect(run).resolves.toMatchObject({
      kind: "completed",
      message: {
        message_id: "assistant_after_empty_snapshot",
        content: "The response still ran.",
      },
    });
  });

  it("reports a recoverable transport fault only while a run is active", async () => {
    const harness = trackedHarness();
    const socket = await harness.open([]);

    socket.serverError();
    expect(harness.reportError).not.toHaveBeenCalled();

    const turnId = "user_interrupted_run";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep working through the fault"),
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(runState(active(1, turnId, turnId)));

    socket.serverError();
    expect(harness.reportError).toHaveBeenCalledTimes(1);
    const reported = harness.reportError.mock.calls[0]?.[0] as Error;
    expect(reported.message).toBe(
      "Agent session interrupted during an active run (socket_error): "
        + "The first-party agent socket reported an error.",
    );

    socket.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_after_fault", "Recovered and finished."),
    ));
    socket.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({
      kind: "completed",
      message: { message_id: "assistant_after_fault" },
    });
    expect(harness.reportError).toHaveBeenCalledTimes(1);
  });

  it("regenerates an exact authoritative root without sending client history", async () => {
    const harness = trackedHarness();
    const rootMessageId = "user_retry_root";
    const socket = await harness.open([
      wireUser(rootMessageId, "Try this again"),
      wireAssistant("assistant_old", "Old answer"),
    ]);
    socket.sent.length = 0;

    const requestId = "request_regenerate";
    const run = harness.agent.regenerate({
      conversationId: CONVERSATION_ID,
      requestId,
      rootMessageId,
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "regenerate"));
    const command = harness.commands(socket).find((candidate) =>
      candidate.kind === "regenerate");
    expect(command).toEqual({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "regenerate",
      request_id: requestId,
      root_message_id: rootMessageId,
    });
    expect(JSON.stringify(command)).not.toMatch(/messages|transcript|history|user_message/u);

    socket.serverMessage(runState(active(1, requestId, rootMessageId)));
    socket.serverMessage(assistantSnapshot(
      requestId,
      wireAssistant("assistant_regenerated", "New authoritative answer"),
    ));
    socket.serverMessage(succeededTerminal(requestId, rootMessageId));

    await expect(run).resolves.toMatchObject({
      kind: "completed",
      message: {
        message_id: "assistant_regenerated",
        content: "New authoritative answer",
      },
    });
  });

  it("executes marked vault tools, waits for approval acknowledgement, and preserves denial", async () => {
    const harness = trackedHarness({
      executeLocalTool: async (call) => call.name === "read"
        ? { success: true, data: { content: "Vault contents" } }
        : { success: true, data: { path: "Approved.md" } },
    });
    const socket = await harness.open();
    const turnId = "user_tool_flow";
    const assistantId = "assistant_tool_flow";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read, write, and leave the denied file alone"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(sessionSnapshot(
      [wireUser(turnId, "Read, write, and leave the denied file alone")],
      active(1, turnId, turnId, "waiting_for_client"),
    ));

    const readRequest = clientToolRequest("call_read", "read", {
      paths: ["Notes.md"],
    });
    expect(parseThinAgentDataPart(readRequest)).toMatchObject({
      kind: "known",
      data: { tool_call_id: "call_read", tool_name: "read" },
    });
    socket.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      readRequest,
      {
        type: "tool-read",
        toolCallId: "call_read",
        state: "input-available",
        input: { paths: ["Notes.md"] },
      },
    ])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const internal = harness.agent as unknown as {
      presentationMessages: readonly WireMessage[];
    };
    expect(internal.presentationMessages).toHaveLength(2);
    expect(internal.presentationMessages[1]!.parts[0]).toEqual(readRequest);
    expect(parseThinAgentDataPart(internal.presentationMessages[1]!.parts[0]))
      .toMatchObject({ kind: "known" });
    expect(harness.agent.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "tool",
      callId: "call_read",
      name: "read",
      location: "vault",
    }));
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === "call_read"));
    expect(harness.executeLocalTool).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call_read", name: "read" }),
      expect.any(AbortSignal),
    );

    const writeRequest = clientToolRequest("call_write", "write", {
      path: "Approved.md",
      content: "Approved",
    });
    socket.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      readRequest,
      {
        type: "tool-read",
        toolCallId: "call_read",
        state: "output-available",
        input: { paths: ["Notes.md"] },
        output: { success: true, data: { content: "Vault contents" } },
      },
      writeRequest,
      {
        type: "tool-write",
        toolCallId: "call_write",
        state: "approval-requested",
        input: { path: "Approved.md", content: "Approved" },
        approval: { id: "approval_write" },
      },
    ])));
    expect(harness.agent.respondToApproval("approval_write", true)).toBe(true);
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === "call_write"
      && command.approved === true));
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.name === "write")).toBe(false);

    socket.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      readRequest,
      {
        type: "tool-read",
        toolCallId: "call_read",
        state: "output-available",
        input: { paths: ["Notes.md"] },
        output: { success: true, data: { content: "Vault contents" } },
      },
      writeRequest,
      {
        type: "tool-write",
        toolCallId: "call_write",
        state: "approval-responded",
        input: { path: "Approved.md", content: "Approved" },
        approval: { id: "approval_write", approved: true },
      },
    ])));
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === "call_write"));
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.name === "write")).toHaveLength(1);
    expect(harness.mutationAdapter.write).toHaveBeenCalledTimes(2);

    const deniedRequest = clientToolRequest("call_denied", "write", {
      path: "Denied.md",
      content: "Do not write",
    });
    socket.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      readRequest,
      {
        type: "tool-read",
        toolCallId: "call_read",
        state: "output-available",
        input: { paths: ["Notes.md"] },
        output: { success: true, data: { content: "Vault contents" } },
      },
      writeRequest,
      {
        type: "tool-write",
        toolCallId: "call_write",
        state: "output-available",
        input: { path: "Approved.md", content: "Approved" },
        output: { success: true, data: { path: "Approved.md" } },
      },
      deniedRequest,
      {
        type: "tool-write",
        toolCallId: "call_denied",
        state: "approval-requested",
        input: { path: "Denied.md", content: "Do not write" },
        approval: { id: "approval_denied" },
      },
    ])));
    expect(harness.agent.respondToApproval("approval_denied", false)).toBe(true);
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === "call_denied"
      && command.approved === false));

    socket.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      readRequest,
      {
        type: "tool-read",
        toolCallId: "call_read",
        state: "output-available",
        input: { paths: ["Notes.md"] },
        output: { success: true, data: { content: "Vault contents" } },
      },
      writeRequest,
      {
        type: "tool-write",
        toolCallId: "call_write",
        state: "output-available",
        input: { path: "Approved.md", content: "Approved" },
        output: { success: true, data: { path: "Approved.md" } },
      },
      deniedRequest,
      {
        type: "tool-write",
        toolCallId: "call_denied",
        state: "output-denied",
        input: { path: "Denied.md", content: "Do not write" },
        approval: { id: "approval_denied", approved: false },
      },
      { type: "text", text: "Read and approved write complete.", state: "done" },
    ])));
    socket.serverMessage(succeededTerminal(turnId, turnId));

    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === "call_denied")).toBe(false);
    expect(harness.commands(socket).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === "call_denied")).toHaveLength(0);
    expect(harness.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({
      content: "Read and approved write complete.",
      tool_calls: expect.arrayContaining([
        expect.objectContaining({ id: "call_read", state: "completed" }),
        expect.objectContaining({ id: "call_write", state: "completed" }),
        expect.objectContaining({ id: "call_denied", state: "failed" }),
      ]),
    }));
  });

  it.each([
    { boundary: "before", approved: true },
    { boundary: "during", approved: true },
    { boundary: "after", approved: true },
    { boundary: "before", approved: false },
    { boundary: "during", approved: false },
    { boundary: "after", approved: false },
  ] as const)(
    "recovers a $approved approval decision when disconnected $boundary send",
    async ({ boundary, approved }) => {
      const harness = trackedHarness();
      const socket = await harness.open();
      const turnId = `user_approval_${boundary}_${approved ? "allow" : "deny"}`;
      const requestId = turnId;
      const assistantId = `assistant_approval_${boundary}_${approved ? "allow" : "deny"}`;
      const callId = `call_${boundary}_${approved ? "allow" : "deny"}`;
      const user = wireUser(turnId, "Apply the approval exactly once");
      const requested = wireAssistant(
        assistantId,
        writeApprovalParts(callId, "approval-requested"),
      );
      const run = harness.agent.start({
        conversationId: CONVERSATION_ID,
        turnId,
        message: userMessage(turnId, "Apply the approval exactly once"),
        approvalPolicy: { requireDestructiveApproval: true },
      });
      await waitFor(() => harness.commands(socket).some((command) =>
        command.kind === "submit"));
      socket.serverMessage(sessionSnapshot(
        [user],
        active(1, requestId, turnId, "waiting_for_client"),
      ));
      socket.serverMessage(assistantSnapshot(requestId, requested));
      await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
        part.kind === "tool"
        && part.callId === callId
        && part.state === "approval-required"));

      if (boundary === "before") {
        socket.close(1006, "Disconnected before approval send");
      } else {
        socket.sendBehavior = (data, commit) => {
          const command = JSON.parse(data) as Record<string, unknown>;
          commit();
          if (command.kind !== "client_tool_approval") return;
          socket.close(1006, `Disconnected ${boundary} approval send`);
          if (boundary === "during") {
            throw new Error("Approval delivery outcome is uncertain.");
          }
        };
      }

      expect(harness.agent.respondToApproval(`approval_${callId}`, approved)).toBe(true);
      const pendingBeforeReconnect = (harness.agent as unknown as {
        pendingApprovalDeliveries: ReadonlyMap<string, {
          decision: Readonly<{ requestId: string; callId: string; approved: boolean }>;
        }>;
      }).pendingApprovalDeliveries.get(callId);
      expect(pendingBeforeReconnect?.decision).toEqual({ requestId, callId, approved });
      expect(Object.isFrozen(pendingBeforeReconnect?.decision)).toBe(true);
      await waitFor(() => harness.sockets.length === 2);
      const recoveredSocket = harness.sockets[1]!;
      recoveredSocket.open();
      recoveredSocket.serverMessage(sessionSnapshot(
        [user, requested],
        active(2, requestId, turnId, "waiting_for_client"),
      ));
      await waitFor(() => harness.commands(recoveredSocket).some((command) =>
        command.kind === "client_tool_approval"
        && command.tool_call_id === callId
        && command.approved === approved));

      expect(harness.commands(socket).filter((command) =>
        command.kind === "client_tool_approval"
        && command.tool_call_id === callId)).toHaveLength(boundary === "before" ? 0 : 1);
      expect(harness.commands(recoveredSocket).filter((command) =>
        command.kind === "client_tool_approval"
        && command.tool_call_id === callId
        && command.approved === approved)).toHaveLength(1);
      expect(harness.onLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({
        code: "run_finished_failed",
      }));

      const acknowledged = wireAssistant(
        assistantId,
        writeApprovalParts(callId, "approval-responded", approved),
      );
      recoveredSocket.serverMessage(assistantSnapshot(requestId, acknowledged));
      await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
        record.code === (approved
          ? "approval_acknowledged_approved"
          : "approval_acknowledged_denied")
        && record.toolCallId === callId));
      const internal = harness.agent as unknown as {
        pendingApprovalDeliveries: ReadonlyMap<string, unknown>;
      };
      expect(internal.pendingApprovalDeliveries.has(callId)).toBe(false);

      if (approved) {
        await waitFor(() => harness.commands(recoveredSocket).some((command) =>
          command.kind === "client_tool_result"
          && command.tool_call_id === callId));
        expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
          call.callId === callId)).toHaveLength(1);
      } else {
        await Promise.resolve();
        expect(harness.executeLocalTool.mock.calls.some(([call]) =>
          call.callId === callId)).toBe(false);
        expect(harness.commands(recoveredSocket).some((command) =>
          command.kind === "client_tool_result"
          && command.tool_call_id === callId)).toBe(false);
      }

      const settled = wireAssistant(
        assistantId,
        writeApprovalParts(callId, approved ? "output-available" : "output-denied", approved),
      );
      recoveredSocket.serverMessage(assistantSnapshot(requestId, settled));
      recoveredSocket.serverMessage(succeededTerminal(requestId, turnId));
      await expect(run).resolves.toMatchObject({ kind: "completed" });
      expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
        call.callId === callId)).toHaveLength(approved ? 1 : 0);
    },
  );

  it("uses a command acknowledgement to settle approval delivery without executing early", async () => {
    const harness = trackedHarness();
    const socket = await harness.open();
    const turnId = "user_approval_command_ack";
    const assistantId = "assistant_approval_command_ack";
    const callId = "call_approval_command_ack";
    const user = wireUser(turnId, "Approve this write exactly once");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Approve this write exactly once"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    socket.serverMessage(assistantSnapshot(turnId, requested));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required"));

    expect(harness.agent.respondToApproval(`approval_${callId}`, true)).toBe(true);
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId));
    socket.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    socket.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => !(harness.agent as unknown as {
      pendingApprovalDeliveries: ReadonlyMap<string, unknown>;
    }).pendingApprovalDeliveries.has(callId));
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "approval_acknowledged_approved"
      && record.toolCallId === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === callId)).toBe(false);

    socket.close(1006, "Reconnect after durable approval acknowledgement");
    await waitFor(() => harness.sockets.length === 2);
    const recoveredSocket = harness.sockets[1]!;
    recoveredSocket.open();
    recoveredSocket.serverMessage(sessionSnapshot(
      [user, requested],
      active(2, turnId, turnId, "waiting_for_client"),
    ));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.commands(recoveredSocket).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId)).toBe(false);
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === callId)).toBe(false);

    recoveredSocket.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-responded", true)),
    ));
    await waitFor(() => harness.commands(recoveredSocket).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId));
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    recoveredSocket.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "output-available", true)),
    ));
    recoveredSocket.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it("replays an uncertain tool result once without executing the local tool again", async () => {
    const harness = trackedHarness();
    const socket = await harness.open();
    const turnId = "user_tool_result_recovery";
    const assistantId = "assistant_tool_result_recovery";
    const callId = "call_tool_result_recovery";
    const user = wireUser(turnId, "Read this note once");
    const request = clientToolRequest(callId, "read", { paths: ["Once.md"] });
    const pendingAssistant = wireAssistant(assistantId, [
      request,
      {
        type: "tool-read",
        toolCallId: callId,
        state: "input-available",
        input: { paths: ["Once.md"] },
      },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read this note once"),
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    socket.sendBehavior = (data, commit) => {
      const command = JSON.parse(data) as Record<string, unknown>;
      commit();
      if (command.kind !== "client_tool_result") return;
      socket.close(1006, "Tool result outcome is uncertain");
      throw new Error("Tool result delivery outcome is uncertain.");
    };
    socket.serverMessage(assistantSnapshot(turnId, pendingAssistant));

    await waitFor(() => harness.sockets.length === 2);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect(harness.commands(socket).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toHaveLength(1);

    const recoveredSocket = harness.sockets[1]!;
    recoveredSocket.open();
    recoveredSocket.serverMessage(sessionSnapshot(
      [user, pendingAssistant],
      active(2, turnId, turnId, "waiting_for_client"),
    ));
    await waitFor(() => harness.commands(recoveredSocket).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId));
    expect(harness.commands(recoveredSocket).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    recoveredSocket.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => !(harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, unknown>;
    }).pendingDeliveries.has(callId));

    recoveredSocket.close(1006, "Reconnect after durable tool-result acknowledgement");
    await waitFor(() => harness.sockets.length === 3);
    const secondRecovery = harness.sockets[2]!;
    secondRecovery.open();
    secondRecovery.serverMessage(sessionSnapshot(
      [user, pendingAssistant],
      active(3, turnId, turnId, "waiting_for_client"),
    ));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.commands(secondRecovery).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toBe(false);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    secondRecovery.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, [
        request,
        {
          type: "tool-read",
          toolCallId: callId,
          state: "output-available",
          input: { paths: ["Once.md"] },
          output: { success: true, data: { ok: true } },
        },
      ]),
    ));
    secondRecovery.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it("fails closed when server approval contradicts an acknowledged local denial", async () => {
    const harness = trackedHarness();
    const socket = await harness.open();
    const turnId = "user_denial_ack_mismatch";
    const assistantId = "assistant_denial_ack_mismatch";
    const callId = "call_denial_ack_mismatch";
    const user = wireUser(turnId, "Do not apply this write");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Do not apply this write"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    socket.serverMessage(assistantSnapshot(turnId, requested));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId));
    expect(harness.agent.respondToApproval(`approval_${callId}`, false)).toBe(true);
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId));
    socket.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    socket.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-responded", true)),
    ));

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "approval_state_mismatch" },
    });
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === callId)).toBe(false);
  });

  it("does not replay an approval already acknowledged by the reconnect snapshot", async () => {
    const harness = trackedHarness();
    const socket = await harness.open();
    const turnId = "user_approval_acknowledged_on_reconnect";
    const assistantId = "assistant_approval_acknowledged_on_reconnect";
    const callId = "call_acknowledged_on_reconnect";
    const user = wireUser(turnId, "Apply one acknowledged approval");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Apply one acknowledged approval"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(socket).some((command) =>
      command.kind === "submit"));
    socket.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    socket.serverMessage(assistantSnapshot(turnId, requested));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId));
    socket.sendBehavior = (data, commit) => {
      const command = JSON.parse(data) as Record<string, unknown>;
      commit();
      if (command.kind === "client_tool_approval") {
        socket.close(1006, "Approval accepted before disconnect");
      }
    };

    expect(harness.agent.respondToApproval(`approval_${callId}`, true)).toBe(true);
    await waitFor(() => harness.sockets.length === 2);
    const recoveredSocket = harness.sockets[1]!;
    recoveredSocket.open();
    const acknowledged = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-responded", true),
    );
    recoveredSocket.serverMessage(sessionSnapshot(
      [user, acknowledged],
      active(2, turnId, turnId, "waiting_for_client"),
    ));
    await waitFor(() => harness.commands(recoveredSocket).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    expect(harness.commands(socket).filter((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId)).toHaveLength(1);
    expect(harness.commands(recoveredSocket).filter((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId)).toHaveLength(0);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    recoveredSocket.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "output-available", true)),
    ));
    recoveredSocket.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });
});
