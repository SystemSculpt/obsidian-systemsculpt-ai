import type { PlatformRequestInput } from "../../../../services/PlatformRequestClient";
import {
  parseThinAgentDataPart,
  type ThinAgentBootstrapRequest,
} from "../../../../services/managed/ThinAgentV1Contract";
import type { ToolCallResult } from "../../../../types/toolCalls";
import {
  THIN_AGENT_EVENT_TYPE,
  type AgentUserMessage,
} from "../Protocol";
import {
  AgentChatSession,
  type AgentRunResult,
} from "../ChatSession";
import { AgentMutationJournal } from "../MutationJournal";

const CONVERSATION_ID = `conversation_${"a".repeat(32)}`;
const CLIENT_ID = `client_${"b".repeat(32)}`;
const SESSION_ID = `session_${"c".repeat(32)}`;
const RUN_ID = `run_${"d".repeat(32)}`;
const PLUGIN_BUILD_ID = `sha256:${"e".repeat(64)}`;
const ACCESS_TOKEN = "access_token_agent_session_1234567890";

type WireMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly Readonly<Record<string, unknown> & { type: string }>[];
}>;

function userMessage(id: string, text: string): AgentUserMessage {
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
    type: THIN_AGENT_EVENT_TYPE,
    version: 1,
    kind,
    conversation_id: CONVERSATION_ID,
    ...fields,
  };
}

function sessionSnapshot(
  messages: readonly WireMessage[],
  runState: ReturnType<typeof idle> | ReturnType<typeof active>,
  queue: Readonly<{
    queued?: readonly string[];
    cancelled?: readonly string[];
  }> = {},
) {
  return event("session_snapshot", {
    messages,
    run_state: runState,
    queued_request_ids: queue.queued ?? [],
    cancelled_queued_request_ids: queue.cancelled ?? [],
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

function cancelledTerminal(requestId: string, rootMessageId: string) {
  return event("terminal", {
    request_id: requestId,
    terminal: {
      version: 1,
      run_id: RUN_ID,
      root_message_id: rootMessageId,
      outcome: "cancelled",
      code: "cancelled",
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

function bootstrapRequest(
  conversationId = CONVERSATION_ID,
): ThinAgentBootstrapRequest {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: conversationId,
    client_id: CLIENT_ID,
    plugin_build_id: PLUGIN_BUILD_ID,
    capability_manifest: {
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{ id: "obsidian.vault", version: 1 }],
    },
  };
}

function bootstrapResponse(
  conversationId = CONVERSATION_ID,
  sessionId = SESSION_ID,
  accessToken = ACCESS_TOKEN,
) {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: conversationId,
    session: { id: sessionId },
    access: {
      token: accessToken,
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

/**
 * The agent server as the streaming client sees it.
 *
 * It delivers frames through the body of the command request that produced
 * them. It closes a turn where the real server closes one: at a terminal or
 * when the run parks for a client tool.
 */
class FakeAgentServer {
  public readonly sent: string[] = [];

  public constructor(
    public readonly conversationId = CONVERSATION_ID,
    private readonly sessionId = SESSION_ID,
    private readonly accessToken = ACCESS_TOKEN,
  ) {}
  public snapshotMessages: readonly WireMessage[] = [];
  public snapshotRunState: unknown = idle(0);
  public snapshotQueuedRequestIds: readonly string[] = [];
  public snapshotCancelledQueuedRequestIds: readonly string[] = [];
  public turnStatus = 200;
  /**
   * Lets a test decide one command's delivery outcome. Call deliver() to let
   * the turn proceed. Throw to make the HTTP delivery outcome uncertain.
   */
  public commandBehavior:
    | ((command: Record<string, unknown>, deliver: () => void) => void)
    | null = null;
  public turnRequests = 0;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private buffered: string[] = [];
  private readonly encoder = new TextEncoder();

  public readonly request = jest.fn(
    async (input: PlatformRequestInput): Promise<Response> => {
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) {
        return jsonResponse(bootstrapResponse(
          this.conversationId,
          this.sessionId,
          this.accessToken,
        ));
      }
      if (url.includes("/get-messages")) {
        return jsonResponse({
          ...sessionSnapshot(
            this.snapshotMessages,
            this.snapshotRunState as never,
            {
              queued: this.snapshotQueuedRequestIds,
              cancelled: this.snapshotCancelledQueuedRequestIds,
            },
          ),
          conversation_id: this.conversationId,
        });
      }
      if (url.includes("/agent/context")) {
        return jsonResponse({ context_ref: "context_ref_test" });
      }
      if (url.includes("/agent/turn")) {
        this.turnRequests += 1;
        const raw = typeof input.body === "string"
          ? input.body
          : JSON.stringify(input.body);
        const behavior = this.commandBehavior;
        if (behavior) {
          let delivered = false;
          behavior(
            JSON.parse(raw) as Record<string, unknown>,
            () => { delivered = true; this.sent.push(raw); },
          );
          if (!delivered) {
            throw new Error("SystemSculpt could not run this message (0).");
          }
          return this.openTurn();
        }
        this.sent.push(raw);
        return this.openTurn();
      }
      throw new Error(`unexpected request url: ${url}`);
    },
  );

  private openTurn(): Response {
    // The client only sends its next command because the previous segment
    // finished, so starting a turn closes the one before it.
    this.endTurn();
    if (this.turnStatus !== 200) {
      return new Response("{}", { status: this.turnStatus });
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        for (const frame of this.buffered.splice(0)) this.write(frame);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  private write(frame: string): void {
    this.controller?.enqueue(this.encoder.encode(`data: ${frame}\n\n`));
    if (endsTurn(frame)) this.endTurn();
  }

  /** Delivers one authoritative frame on the turn it belongs to. */
  public serverMessage(value: unknown): void {
    const frame = typeof value === "string" ? value : JSON.stringify(value);
    if (this.controller) this.write(frame);
    else this.buffered.push(frame);
  }

  public endTurn(): void {
    const controller = this.controller;
    this.controller = null;
    try { controller?.close(); } catch { /* already closed */ }
  }
}

/**
 * A turn ends where the server ends it: a terminal, or the run parking on the
 * client for a tool result.
 */
function endsTurn(frame: string): boolean {
  // Only a terminal ends a turn on its own. A run that parks on a client tool
  // ends when the client answers, which openTurn handles: frames the server
  // still has to send after announcing the park must not be cut off.
  try {
    return (JSON.parse(frame) as Record<string, unknown>).kind === "terminal";
  } catch {
    return false;
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
    journal: new AgentMutationJournal(
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
  request?: jest.Mock<Promise<Response>, [PlatformRequestInput]>;
  runStallGraceMs?: number;
  resynchronizationDelayMs?: (attempt: number) => number;
  conversationId?: string;
}> = {}) {
  const conversationId = input.conversationId ?? CONVERSATION_ID;
  const identitySuffix = conversationId.slice("conversation_".length);
  const server = new FakeAgentServer(
    conversationId,
    `session_${identitySuffix}`,
    `access_token_${identitySuffix}`,
  );
  const request = input.request ?? server.request;
  const mutation = journalHarness();
  const executeLocalTool = jest.fn(input.executeLocalTool ?? (async () => ({
    success: true,
    data: { ok: true },
  })));
  const persistAssistant = jest.fn(async () => undefined);
  const reconcileHistory = jest.fn(async () => undefined);
  const reportError = jest.fn();
  const onLifecycle = jest.fn();
  const agent = new AgentChatSession({
    baseUrl: "https://systemsculpt.test",
    pluginVersion: "6.2.7",
    licenseKey: () => "license_test",
    bootstrapRequest: () => bootstrapRequest(conversationId),
    mutationJournal: mutation.journal,
    executeLocalTool,
    persistAssistant,
    reconcileHistory,
    reportError,
    onLifecycle,
    requestClient: { request },
    ...(input.runStallGraceMs
      ? { runStallGraceMs: input.runStallGraceMs }
      : {}),
    resynchronizationDelayMs: input.resynchronizationDelayMs ?? (() => 0),
    now: () => 10_000,
  });

  return {
    agent,
    server,
    request,
    executeLocalTool,
    persistAssistant,
    reconcileHistory,
    reportError,
    onLifecycle,
    mutationAdapter: mutation.adapter,
    async open(messages: readonly WireMessage[] = []): Promise<FakeAgentServer> {
      // Hydration is a request now, so the snapshot is what the server answers
      // with rather than a frame pushed before synchronization.
      server.snapshotMessages = messages;
      await agent.hydrate(conversationId);
      return server;
    },
    commands(target: FakeAgentServer = server): Record<string, unknown>[] {
      return target.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
    },
  };
}

/** Lets streamed frames reach the client before a synchronous assertion. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the agent session test state.");
}

async function waitForResult(
  pending: Promise<AgentRunResult>,
): Promise<AgentRunResult> {
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

const sessions: AgentChatSession[] = [];

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

describe("AgentChatSession", () => {
  it("isolates overlapping turns in independent conversations", async () => {
    const firstConversationId = `conversation_${"1".repeat(32)}`;
    const secondConversationId = `conversation_${"2".repeat(32)}`;
    const first = trackedHarness({ conversationId: firstConversationId });
    const second = trackedHarness({ conversationId: secondConversationId });
    const [firstServer, secondServer] = await Promise.all([
      first.open(),
      second.open(),
    ]);
    const firstTurnId = "user_independent_first";
    const secondTurnId = "user_independent_second";

    const firstRun = first.agent.start({
      conversationId: firstConversationId,
      turnId: firstTurnId,
      message: userMessage(firstTurnId, "First independent turn"),
    });
    const secondRun = second.agent.start({
      conversationId: secondConversationId,
      turnId: secondTurnId,
      message: userMessage(secondTurnId, "Second independent turn"),
    });
    await waitFor(() => first.commands().length === 1);
    await waitFor(() => second.commands().length === 1);

    firstServer.serverMessage({
      ...runState(active(1, firstTurnId, firstTurnId)),
      conversation_id: firstConversationId,
    });
    firstServer.serverMessage({
      ...assistantSnapshot(
        firstTurnId,
        wireAssistant("assistant_independent_first", "First answer"),
      ),
      conversation_id: firstConversationId,
    });
    firstServer.serverMessage({
      ...succeededTerminal(firstTurnId, firstTurnId),
      conversation_id: firstConversationId,
    });

    await expect(firstRun).resolves.toMatchObject({ kind: "completed" });
    expect(JSON.stringify(second.agent.getSnapshot()))
      .not.toContain("First answer");
    expect(second.persistAssistant).not.toHaveBeenCalled();

    secondServer.serverMessage({
      ...runState(active(1, secondTurnId, secondTurnId)),
      conversation_id: secondConversationId,
    });
    secondServer.serverMessage({
      ...assistantSnapshot(
        secondTurnId,
        wireAssistant("assistant_independent_second", "Second answer"),
      ),
      conversation_id: secondConversationId,
    });
    secondServer.serverMessage({
      ...succeededTerminal(secondTurnId, secondTurnId),
      conversation_id: secondConversationId,
    });

    await expect(secondRun).resolves.toMatchObject({ kind: "completed" });
    expect(first.persistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ content: "First answer" }),
    );
    expect(second.persistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Second answer" }),
    );
    expect(JSON.stringify(first.agent.getSnapshot()))
      .not.toContain("Second answer");
  });

  it("reconciles and replays an uncertain cancel until the server confirms it", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_uncertain_cancel";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Stop this run safely"),
    });
    await waitFor(() => harness.commands().some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();
    server.snapshotMessages = [wireUser(turnId, "Stop this run safely")];
    server.snapshotRunState = active(1, turnId, turnId);
    server.commandBehavior = (command, deliver) => {
      deliver();
      if (command.kind !== "cancel") return;
      server.commandBehavior = null;
      throw new Error("Cancel response was interrupted after admission.");
    };

    await harness.agent.cancel();

    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "running",
      statusLabel: "Stopping",
    });
    await waitFor(() => harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length >= 2);
    await waitFor(() => harness.commands().filter((command) =>
      command.kind === "cancel").length === 2);
    const cancelCommands = harness.commands().filter((command) =>
      command.kind === "cancel");
    expect(cancelCommands.map((command) => command.request_id))
      .toEqual([turnId, turnId]);

    server.serverMessage(cancelledTerminal(turnId, turnId));

    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("waits for a durable queued-cancel snapshot after acknowledgement", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_queued_cancel";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Cancel this queued response"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(event("queue_snapshot", {
      queue: {
        version: 1,
        cursor: 1,
        items: [{
          kind: "submit",
          request_id: turnId,
          user_message: userMessage(turnId, "Cancel this queued response"),
        }],
      },
    }));
    await waitFor(() => harness.agent.getSnapshot().statusLabel === "Queued");

    const cancellation = harness.agent.cancel();
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "cancel"));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "cancel",
      status: "accepted",
    }));
    await tick();
    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "running",
      statusLabel: "Stopping",
    });
    server.serverMessage(sessionSnapshot([], idle(2), {
      cancelled: [turnId],
    }));
    server.endTurn();

    await cancellation;
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "cancelled",
      statusLabel: "Stopped",
    });
  });

  it("restores and cancels a queued turn after its response disconnects", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_restarted_queue";
    const otherRequestId = "request_other_active";
    server.commandBehavior = (command, deliver) => {
      deliver();
      if (command.kind !== "submit") return;
      server.commandBehavior = null;
      server.snapshotRunState = active(
        2,
        otherRequestId,
        "user_other_active",
      );
      server.snapshotQueuedRequestIds = [turnId];
      throw new Error("The queued response disconnected after admission.");
    };

    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep this queued across restart"),
    });

    await waitFor(() => harness.agent.getSnapshot().statusLabel === "Queued");
    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "running",
      statusLabel: "Queued",
    });

    const cancellation = harness.agent.cancel();
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "cancel"));
    server.snapshotQueuedRequestIds = [];
    server.snapshotCancelledQueuedRequestIds = [turnId];
    server.snapshotRunState = idle(3);
    server.endTurn();

    await cancellation;
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "idle",
      turnId: null,
    });
  });

  it("accepts a persisted terminal before a cancellation receipt or another request", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_terminal_before_mismatch";
    const assistant = wireAssistant("assistant_terminal_before_mismatch", [{
      type: "text",
      text: "Completed before the response disconnected.",
      state: "done",
    }, {
      type: "data-systemsculpt-run-terminal",
      data: {
        version: 1,
        run_id: RUN_ID,
        root_message_id: turnId,
        outcome: "succeeded",
        code: "completed",
      },
    }]);
    server.commandBehavior = (command, deliver) => {
      deliver();
      if (command.kind !== "submit") return;
      server.commandBehavior = null;
      server.snapshotMessages = [
        wireUser(turnId, "Finish before another request starts"),
        assistant,
      ];
      server.snapshotCancelledQueuedRequestIds = [turnId];
      server.snapshotRunState = active(
        3,
        "request_later_active",
        "user_later_active",
      );
      throw new Error("The completed response disconnected.");
    };

    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Finish before another request starts"),
    });

    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.persistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: assistant.id,
        content: "Completed before the response disconnected.",
      }),
    );
    expect(harness.reportError).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "response_state_mismatch" }),
    );
  });

  it("cancels locally before any server admission is possible", async () => {
    const harness = trackedHarness();
    await harness.open();
    const turnId = "user_cancel_before_admission";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Do not submit this"),
      buildBody: async (signal) => await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(
          new DOMException("Aborted", "AbortError"),
        ), { once: true });
      }),
    });
    await waitFor(() => harness.agent.getSnapshot().turnId === turnId);

    await harness.agent.cancel();

    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    expect(harness.commands().some((command) => command.kind === "submit"))
      .toBe(false);
  });

  it("resynchronizes an uncertain submit without duplicating an accepted user message", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_uncertain_submit";
    const user = wireUser(turnId, "Recover this exact request");
    const assistant = wireAssistant("assistant_uncertain_submit", [{
      type: "text",
      text: "Recovered answer",
      state: "done",
    }, {
      type: "data-systemsculpt-run-terminal",
      data: {
        version: 1,
        run_id: RUN_ID,
        root_message_id: turnId,
        outcome: "succeeded",
        code: "completed",
      },
    }]);
    server.commandBehavior = (command, deliver) => {
      if (command.kind !== "submit") {
        deliver();
        return;
      }
      deliver();
      server.commandBehavior = null;
      server.snapshotMessages = [user, assistant];
      server.snapshotRunState = idle(3);
      throw new Error("Submit response was interrupted after admission.");
    };

    const result = await harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Recover this exact request"),
    });

    expect(result).toMatchObject({ kind: "completed" });
    expect(harness.commands(server).filter((command) =>
      command.kind === "submit" && command.request_id === turnId)).toHaveLength(1);
    expect(harness.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({
      message_id: assistant.id,
      content: "Recovered answer",
    }));
  });

  it("orders the optimistic user before full assistant replacements and coalesces presentation", async () => {
    const harness = trackedHarness();
    const baseUser = wireUser("user_base", "Earlier question");
    const baseAssistant = wireAssistant("assistant_base", "Earlier answer");
    const server = await harness.open([baseUser, baseAssistant]);
    harness.reconcileHistory.mockClear();

    const turnId = "user_optimistic";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Research this carefully"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const presented: ReturnType<AgentChatSession["getSnapshot"]>[] = [];
    harness.agent.subscribe((snapshot) => presented.push(snapshot));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_new", [{
      type: "reasoning",
      text: "Checking",
      state: "streaming",
    }, {
      type: "text",
      text: "Fir",
      state: "streaming",
    }])));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_new", [{
      type: "reasoning",
      text: "Checking trusted sources",
      state: "streaming",
    }, {
      type: "text",
      text: "Final",
      state: "streaming",
    }])));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_new", [{
      type: "reasoning",
      text: "Checked trusted sources",
      state: "done",
    }, {
      type: "tool-web_search",
      toolCallId: "call_web_search",
      state: "output-available",
      input: { query: "agent session isolation" },
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
    await tick();

    expect(presented.length).toBeLessThanOrEqual(1);
    await waitFor(() => presented.length === 1);
    expect(presented).toHaveLength(1);
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

    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
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

  it("labels a failed server web search without calling it a vault action", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_failed_web_search";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Search the web"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_failed_search", [{
      type: "tool-web_search",
      toolCallId: "call_failed_web_search",
      state: "output-available",
      input: { query: "current release" },
      output: { success: false },
    }, {
      type: "text",
      text: "I could not verify this result.",
      state: "done",
    }])));

    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === "call_failed_web_search"));
    const tool = harness.agent.getSnapshot().parts.find((part) =>
      part.kind === "tool" && part.callId === "call_failed_web_search");
    expect(tool).toMatchObject({
      kind: "tool",
      location: "server",
      state: "failed",
      output: { summary: "Web search failed." },
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "Web search failed.",
      },
    });

    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(waitForResult(run)).resolves.toMatchObject({ kind: "completed" });
  });

  it("never lets an empty authoritative snapshot erase cache and keeps cache failures nonterminal", async () => {
    const harness = trackedHarness();
    const server = await harness.open([
      wireUser("user_saved", "Saved question"),
      wireAssistant("assistant_saved", "Saved answer"),
    ]);
    harness.reconcileHistory.mockClear();

    server.serverMessage(sessionSnapshot([], idle(1)));
    await tick();
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
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    expect(harness.reportError).toHaveBeenCalledWith(cacheFailure);
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "history_sync_failed",
      phase: "persistence",
    }));

    server.serverMessage(runState(active(2, turnId, turnId)));
    await tick();
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_after_empty_snapshot", "The response still ran."),
    ));
    await tick();
    expect(harness.reconcileHistory).not.toHaveBeenCalled();
    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();

    await expect(run).resolves.toMatchObject({
      kind: "completed",
      message: {
        message_id: "assistant_after_empty_snapshot",
        content: "The response still ran.",
      },
    });
  });


  it("authorizes a vault tool whose request part arrives after the tool part", async () => {
    // The provider assembly creates the tool part when input starts streaming
    // and appends the explicit client-tool request once input completes, so
    // the authoritative message orders the tool part FIRST. That order must
    // still authorize the vault tool instead of demoting it to server-owned.
    const harness = trackedHarness();
    const server = await harness.open([]);

    const turnId = "user_late_request_part";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Write the note"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();

    const input = { path: "Ordered.md", content: "ordered request" };
    server.serverMessage(assistantSnapshot(turnId, {
      id: "assistant_late_request",
      role: "assistant",
      parts: [
        { type: "text", text: "Creating the note.", state: "done" },
        {
          type: "tool-write",
          toolCallId: "call_late_request",
          state: "input-available",
          input,
        },
        clientToolRequest("call_late_request", "write", input),
      ],
    }));
    await tick();
    server.serverMessage(runState(active(2, turnId, turnId, "waiting_for_client")));
    await tick();

    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.state === "approval-required"));
    const tool = harness.agent.getSnapshot().parts.find((part) =>
      part.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      name: "write",
      location: "vault",
      state: "approval-required",
    });
    expect(harness.executeLocalTool).not.toHaveBeenCalled();

    const approvalId = (tool as { approvalId?: string }).approvalId;
    expect(typeof approvalId).toBe("string");
    expect(harness.agent.respondToApproval(approvalId!, true)).toBe(true);
    await waitFor(() => harness.executeLocalTool.mock.calls.length === 1);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"));

    server.serverMessage(assistantSnapshot(turnId, {
      id: "assistant_late_request",
      role: "assistant",
      parts: [
        { type: "text", text: "Creating the note.", state: "done" },
        {
          type: "tool-write",
          toolCallId: "call_late_request",
          state: "output-available",
          input,
          output: { success: true, data: { path: input.path } },
        },
        clientToolRequest("call_late_request", "write", input),
      ],
    }));
    await tick();
    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("serializes a tool result full of legal-JS-but-not-JSON values instead of failing delivery", async () => {
    // Local tool implementations return idiomatic JavaScript: optional fields
    // set to undefined (every folder listing does this), NaN durations, Dates,
    // even accidental cycles. The delivery boundary must mirror JSON.stringify
    // semantics instead of erroring the whole tool call.
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    const harness = trackedHarness({
      executeLocalTool: async () => ({
        success: true,
        data: {
          modified: undefined,
          files: [{ path: "A.md", created: undefined }, undefined],
          duration: Number.NaN,
          ratio: Number.POSITIVE_INFINITY,
          when: new Date(1_700_000_000_000),
          onDone: () => "not serializable",
          poison: { toJSON() { throw new Error("hostile toJSON"); } },
          cycle: cyclic,
          negativeZero: -0,
        },
      }),
    });
    const server = await harness.open();
    const turnId = "user_hostile_result";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "List the folder"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [wireUser(turnId, "List the folder")],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, wireAssistant("assistant_hostile_result", [
      clientToolRequest("call_hostile", "read", { paths: ["QA"] }),
      {
        type: "tool-read",
        toolCallId: "call_hostile",
        state: "input-available",
        input: { paths: ["QA"] },
      },
    ])));
    await tick();

    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"));
    const command = harness.commands(server).find((candidate) =>
      candidate.kind === "client_tool_result");
    expect(command).toMatchObject({
      tool_call_id: "call_hostile",
      state: "output-available",
    });
    expect(command!.output).toStrictEqual({
      success: true,
      data: {
        files: [{ path: "A.md" }, null],
        duration: null,
        ratio: null,
        when: "2023-11-14T22:13:20.000Z",
        cycle: { name: "cycle" },
        negativeZero: 0,
      },
    });

    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });


  it("stops claiming progress when a healthy connection produces no server activity", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);

    const turnId = "user_stalled_run";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Do a long job"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();
    await waitFor(() => harness.agent.getSnapshot().statusLabel === "Thinking");

    // The stream stays healthy while the server goes quiet. Transport health
    // cannot detect this, which is exactly the eternal-spinner case.
    await waitFor(() =>
      harness.agent.getSnapshot().statusLabel === "Still waiting on the server");
    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "running",
      phase: "retrying",
    });
    // A silent stall must leave a trace; the whole failure was invisibility.
    expect(harness.reportError).toHaveBeenCalled();
    expect(harness.onLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ code: "run_stalled" }),
    );

    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("clears a stall as soon as the server produces new content", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);

    const turnId = "user_recovering_run";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Recover from a quiet patch"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();
    await waitFor(() =>
      harness.agent.getSnapshot().statusLabel === "Still waiting on the server");

    server.serverMessage(sessionSnapshot(
      [
        wireUser(turnId, "Recover from a quiet patch"),
        wireAssistant("assistant_recovered", "Back with you"),
      ],
      active(2, turnId, turnId),
    ));
    await tick();
    await waitFor(() =>
      harness.agent.getSnapshot().statusLabel !== "Still waiting on the server");

    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("does not call a run stalled while the client owes the server a tool result", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);

    const turnId = "user_waiting_client";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Wait on me"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    // waiting_for_client is the client's turn, not the server's: the user (or
    // a local tool) bounds it, so the server-liveness bound must stay disarmed.
    server.serverMessage(runState(active(1, turnId, turnId, "waiting_for_client")));
    await tick();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.agent.getSnapshot().statusLabel)
      .not.toBe("Still waiting on the server");
    expect(harness.onLifecycle).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "run_stalled" }),
    );

    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("regenerates an exact authoritative root without sending client history", async () => {
    const harness = trackedHarness();
    const rootMessageId = "user_retry_root";
    const server = await harness.open([
      wireUser(rootMessageId, "Try this again"),
      wireAssistant("assistant_old", "Old answer"),
    ]);
    server.sent.length = 0;

    const requestId = "request_regenerate";
    const run = harness.agent.regenerate({
      conversationId: CONVERSATION_ID,
      requestId,
      rootMessageId,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "regenerate"));
    const command = harness.commands(server).find((candidate) =>
      candidate.kind === "regenerate");
    expect(command).toEqual({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "regenerate",
      request_id: requestId,
      root_message_id: rootMessageId,
    });
    expect(JSON.stringify(command)).not.toMatch(/messages|transcript|history|user_message/u);

    server.serverMessage(runState(active(1, requestId, rootMessageId)));
    await tick();
    server.serverMessage(assistantSnapshot(
      requestId,
      wireAssistant("assistant_regenerated", "New authoritative answer"),
    ));
    await tick();
    server.serverMessage(succeededTerminal(requestId, rootMessageId));
    await tick();

    await expect(run).resolves.toMatchObject({
      kind: "completed",
      message: {
        message_id: "assistant_regenerated",
        content: "New authoritative answer",
      },
    });
  });

  it("fails a definitively rejected regeneration without replaying it", async () => {
    const harness = trackedHarness();
    const rootMessageId = "user_retry_rejected_root";
    const server = await harness.open([
      wireUser(rootMessageId, "Reject this retry"),
      wireAssistant("assistant_retry_rejected_old", "Old answer"),
    ]);
    server.turnStatus = 400;

    await expect(harness.agent.regenerate({
      conversationId: CONVERSATION_ID,
      requestId: "request_regenerate_rejected",
      rootMessageId,
    })).resolves.toMatchObject({ kind: "failed" });

    expect(server.turnRequests).toBe(1);
    expect(harness.agent.getSnapshot().status).toBe("failed");
  });

  it("replays an uncertain regeneration with its original request identity", async () => {
    const harness = trackedHarness();
    const rootMessageId = "user_retry_uncertain_root";
    const server = await harness.open([
      wireUser(rootMessageId, "Try this safely"),
      wireAssistant("assistant_retry_uncertain_old", [
        { type: "text", text: "Old answer", state: "done" },
        {
          type: "data-systemsculpt-run-terminal",
          id: "terminal:old-regeneration-run",
          data: {
            version: 1,
            run_id: `run_${"e".repeat(32)}`,
            root_message_id: rootMessageId,
            outcome: "succeeded",
            code: "completed",
          },
        },
      ]),
    ]);
    let attempts = 0;
    const attemptedCommands: Record<string, unknown>[] = [];
    server.commandBehavior = (command, deliver) => {
      if (command.kind !== "regenerate") {
        deliver();
        return;
      }
      attempts += 1;
      attemptedCommands.push(command);
      if (attempts === 1) throw new Error("delivery uncertain");
      deliver();
    };
    const requestId = "request_regenerate_uncertain";

    const run = harness.agent.regenerate({
      conversationId: CONVERSATION_ID,
      requestId,
      rootMessageId,
    });
    await waitFor(() => attempts === 2);
    expect(attemptedCommands).toHaveLength(2);
    expect(attemptedCommands).toEqual(attemptedCommands.map(() =>
      expect.objectContaining({
        kind: "regenerate",
        request_id: requestId,
        root_message_id: rootMessageId,
      })));
    expect(harness.commands(server).filter((command) =>
      command.kind === "regenerate")).toHaveLength(1);

    server.serverMessage(runState(active(1, requestId, rootMessageId)));
    await tick();
    server.serverMessage(succeededTerminal(requestId, rootMessageId));
    await tick();

    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("executes marked vault tools, waits for approval acknowledgement, and preserves denial", async () => {
    const harness = trackedHarness({
      executeLocalTool: async (call) => call.name === "read"
        ? { success: true, data: { content: "Vault contents" } }
        : { success: true, data: { path: "Approved.md" } },
    });
    const server = await harness.open();
    const turnId = "user_tool_flow";
    const assistantId = "assistant_tool_flow";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read, write, and leave the denied file alone"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [wireUser(turnId, "Read, write, and leave the denied file alone")],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();

    const readRequest = clientToolRequest("call_read", "read", {
      paths: ["Notes.md"],
    });
    expect(parseThinAgentDataPart(readRequest)).toMatchObject({
      kind: "known",
      data: { tool_call_id: "call_read", tool_name: "read" },
    });
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      readRequest,
      {
        type: "tool-read",
        toolCallId: "call_read",
        state: "input-available",
        input: { paths: ["Notes.md"] },
      },
    ])));
    await tick();
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
    await waitFor(() => harness.commands(server).some((command) =>
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
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
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
    await tick();
    expect(harness.agent.respondToApproval("approval_write", true)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === "call_write"
      && command.approved === true));
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.name === "write")).toBe(false);

    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
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
    await tick();
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === "call_write"));
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.name === "write")).toHaveLength(1);
    expect(harness.mutationAdapter.write).toHaveBeenCalledTimes(2);

    const deniedRequest = clientToolRequest("call_denied", "write", {
      path: "Denied.md",
      content: "Do not write",
    });
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
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
    await tick();
    expect(harness.agent.respondToApproval("approval_denied", false)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === "call_denied"
      && command.approved === false));

    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
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
    await tick();
    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();

    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === "call_denied")).toBe(false);
    expect(harness.commands(server).filter((command) =>
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
      const server = await harness.open();
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
      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "submit"));
      server.serverMessage(sessionSnapshot(
        [user],
        active(1, requestId, turnId, "waiting_for_client"),
      ));
      await tick();
      server.serverMessage(assistantSnapshot(requestId, requested));
      await tick();
      await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
        part.kind === "tool"
        && part.callId === callId
        && part.state === "approval-required"));

      // A streaming turn loses a decision when its request fails. "before"
      // never reaches the server, "during" has an unknown outcome, and
      // "after" reaches the server before the response is interrupted.
      server.snapshotMessages = [user, requested];
      server.snapshotRunState = active(2, requestId, turnId, "waiting_for_client");
      server.commandBehavior = (command, deliver) => {
        if (command.kind !== "client_tool_approval") {
          deliver();
          return;
        }
        server.commandBehavior = null;
        if (boundary === "before") return;
        deliver();
        if (boundary === "during") {
          throw new Error("Approval delivery outcome is uncertain.");
        }
        throw new Error("The turn ended before it could settle.");
      };

      expect(harness.agent.respondToApproval(`approval_${callId}`, approved)).toBe(true);
      const pendingBeforeReconnect = (harness.agent as unknown as {
        pendingApprovalDeliveries: ReadonlyMap<string, {
          decision: Readonly<{ requestId: string; callId: string; approved: boolean }>;
        }>;
      }).pendingApprovalDeliveries.get(callId);
      expect(pendingBeforeReconnect?.decision).toEqual({ requestId, callId, approved });
      expect(Object.isFrozen(pendingBeforeReconnect?.decision)).toBe(true);
      const deliveredBeforeRecovery = boundary === "before" ? 0 : 1;

      // Recovery obtains a fresh snapshot before it replays the same command.
      await waitFor(() => harness.commands(server).filter((command) =>
        command.kind === "client_tool_approval"
        && command.tool_call_id === callId
        && command.approved === approved).length > deliveredBeforeRecovery);

      expect(harness.commands(server).filter((command) =>
        command.kind === "client_tool_approval"
        && command.tool_call_id === callId
        && command.approved === approved)).toHaveLength(
          boundary === "before" ? 1 : 2);
      expect(harness.onLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({
        code: "run_finished_failed",
      }));

      const acknowledged = wireAssistant(
        assistantId,
        writeApprovalParts(callId, "approval-responded", approved),
      );
      server.serverMessage(assistantSnapshot(requestId, acknowledged));
      await tick();
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
        await waitFor(() => harness.commands(server).some((command) =>
          command.kind === "client_tool_result"
          && command.tool_call_id === callId));
        expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
          call.callId === callId)).toHaveLength(1);
      } else {
        await Promise.resolve();
        expect(harness.executeLocalTool.mock.calls.some(([call]) =>
          call.callId === callId)).toBe(false);
        expect(harness.commands(server).some((command) =>
          command.kind === "client_tool_result"
          && command.tool_call_id === callId)).toBe(false);
      }

      const settled = wireAssistant(
        assistantId,
        writeApprovalParts(callId, approved ? "output-available" : "output-denied", approved),
      );
      server.serverMessage(assistantSnapshot(requestId, settled));
      await tick();
      server.serverMessage(succeededTerminal(requestId, turnId));
      await tick();
      await expect(run).resolves.toMatchObject({ kind: "completed" });
      expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
        call.callId === callId)).toHaveLength(approved ? 1 : 0);
    },
  );

  it("uses a command acknowledgement to settle approval delivery without executing early", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
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
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, requested));
    await tick();
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required"));

    expect(harness.agent.respondToApproval(`approval_${callId}`, true)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    await tick();
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    await tick();
    await waitFor(() => !(harness.agent as unknown as {
      pendingApprovalDeliveries: ReadonlyMap<string, unknown>;
    }).pendingApprovalDeliveries.has(callId));
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "approval_acknowledged_approved"
      && record.toolCallId === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === callId)).toBe(false);

    server.serverMessage(sessionSnapshot(
      [user, requested],
      active(2, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Delivery already settled, so the snapshot must not provoke a resend.
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === callId)).toBe(false);

    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-responded", true)),
    ));
    await tick();
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId));
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "output-available", true)),
    ));
    await tick();
    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it("replays an uncertain tool result once without executing the local tool again", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
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
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    server.snapshotMessages = [user, pendingAssistant];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.commandBehavior = (command, deliver) => {
      deliver();
      if (command.kind !== "client_tool_result") return;
      server.commandBehavior = null;
      throw new Error("Tool result delivery outcome is uncertain.");
    };
    server.serverMessage(assistantSnapshot(turnId, pendingAssistant));

    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 2);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toHaveLength(2);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await tick();
    await waitFor(() => !(harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, unknown>;
    }).pendingDeliveries.has(callId));

    const secondRecovery = server;
    const deliveredOnce = harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length;
    secondRecovery.serverMessage(sessionSnapshot(
      [user, pendingAssistant],
      active(3, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Delivery already settled, so a later snapshot adds no further send.
    expect(harness.commands(secondRecovery).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toHaveLength(deliveredOnce);
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
    await tick();
    secondRecovery.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it("fails closed when server approval contradicts an acknowledged local denial", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
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
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, requested));
    await tick();
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId));
    expect(harness.agent.respondToApproval(`approval_${callId}`, false)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    await tick();
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-responded", true)),
    ));
    await tick();

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "approval_state_mismatch" },
    });
    expect(harness.executeLocalTool.mock.calls.some(([call]) =>
      call.callId === callId)).toBe(false);
  });

  it("does not replay an approval already acknowledged by the recovery snapshot", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_approval_acknowledged_on_recovery";
    const assistantId = "assistant_approval_acknowledged_on_recovery";
    const callId = "call_acknowledged_on_recovery";
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
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, requested));
    await tick();
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId));
    const acknowledged = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-responded", true),
    );
    server.snapshotMessages = [user, acknowledged];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.commandBehavior = (command, deliver) => {
      deliver();
      if (command.kind !== "client_tool_approval") return;
      server.commandBehavior = null;
      throw new Error("Approval acknowledgement response was interrupted.");
    };

    expect(harness.agent.respondToApproval(`approval_${callId}`, true)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    // Exactly one approval delivery survives the acknowledged snapshot.
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "output-available", true)),
    ));
    await tick();
    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });
});
