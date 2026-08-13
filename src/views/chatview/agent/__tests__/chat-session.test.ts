import {
  PlatformRequestClient,
  type PlatformRequestInput,
} from "../../../../services/PlatformRequestClient";
import {
  parseThinAgentDataPart,
  type ThinAgentBootstrapRequest,
} from "../../../../services/managed/ThinAgentV1Contract";
import type { ChatMessage } from "../../../../types";
import type { ToolCall, ToolCallResult } from "../../../../types/toolCalls";
import {
  presentAgentTool,
  presentAgentToolFailure,
} from "../../AgentToolPresentation";
import { AgentConversationRenderer } from "../../AgentConversationRenderer";
import type { AgentToolPart } from "../../AgentConversation";
import { ChatMarkdownSerializer } from "../../storage/ChatMarkdownSerializer";
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

function reloadSavedMessage(message: ChatMessage): ChatMessage {
  const parsed = (ChatMarkdownSerializer as unknown as {
    parseSequentialFormat(content: string): {
      success: boolean;
      messages: ChatMessage[];
    };
  }).parseSequentialFormat(ChatMarkdownSerializer.serializeMessages([message]));
  expect(parsed.success).toBe(true);
  expect(parsed.messages).toHaveLength(1);
  return parsed.messages[0]!;
}

function projectReloadedTool(tool: ToolCall): AgentToolPart {
  const prototype = AgentConversationRenderer.prototype as unknown as {
    historicalToolPart(input: ToolCall): AgentToolPart;
  };
  return prototype.historicalToolPart(tool);
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

function failedTerminal(
  requestId: string,
  rootMessageId: string,
  code: string,
  retryable: boolean,
) {
  return event("terminal", {
    request_id: requestId,
    terminal: {
      version: 1,
      run_id: RUN_ID,
      root_message_id: rootMessageId,
      outcome: "failed",
      code,
      message: "SystemSculpt is temporarily busy.",
      incident_id: `incident_${"f".repeat(32)}`,
      retryable,
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
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
  public turnHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
  };
  public transformTurnResponse:
    | ((response: Response) => Promise<Response>)
    | null = null;
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
        return jsonResponse({
          contract_version: "thin-agent-v1",
          context_ref: `ctx1_${"a".repeat(43)}.${"b".repeat(43)}`,
          expires_at: "2030-01-01T02:00:00.000Z",
          bytes: 2,
          sha256: `sha256:${"f".repeat(64)}`,
        }, 201);
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
          const response = this.openTurn();
          return this.transformTurnResponse
            ? await this.transformTurnResponse(response)
            : response;
        }
        this.sent.push(raw);
        const response = this.openTurn();
        return this.transformTurnResponse
          ? await this.transformTurnResponse(response)
          : response;
      }
      throw new Error(`unexpected request url: ${url}`);
    },
  );

  private openTurn(): Response {
    // The client only sends its next command because the previous segment
    // finished, so starting a turn closes the one before it.
    this.endTurn();
    if (this.turnStatus !== 200) {
      return new Response(JSON.stringify({
        error: { code: "insufficient_credits" },
        incident_id: `incident_${"e".repeat(32)}`,
      }), {
        status: this.turnStatus,
        headers: { "content-type": "application/json" },
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        for (const frame of this.buffered.splice(0)) this.write(frame);
      },
    });
    return new Response(body, {
      status: 200,
      headers: this.turnHeaders,
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

  /**
   * Models an event broadcast by another live response sink. Its terminal must
   * not close the command stream that still owns a later acknowledgement.
   */
  public parallelServerMessage(value: unknown): void {
    const controller = this.controller;
    if (!controller) throw new Error("No agent turn is open for a parallel event.");
    const frame = typeof value === "string" ? value : JSON.stringify(value);
    controller.enqueue(this.encoder.encode(`data: ${frame}\n\n`));
  }

  public endTurn(): void {
    const controller = this.controller;
    this.controller = null;
    try { controller?.close(); } catch { /* already closed */ }
  }

  public failTurn(error: Error): void {
    const controller = this.controller;
    this.controller = null;
    try { controller?.error(error); } catch { /* already closed */ }
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
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const adapter = {
    exists: jest.fn(async (path: string) =>
      files.has(path) || directories.has(path)),
    read: jest.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing ${path}`);
      return content;
    }),
    write: jest.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    mkdir: jest.fn(async (path: string) => {
      directories.add(path);
    }),
    list: jest.fn(async (path: string) => ({
      files: [...files.keys()].filter((candidate) =>
        candidate.startsWith(`${path}/`)),
      folders: [],
    })),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
    }),
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
  persistAssistant?: (message: ChatMessage) => Promise<void>;
  request?: jest.Mock<Promise<Response>, [PlatformRequestInput]>;
  runStallGraceMs?: number;
  resynchronizationDelayMs?: (attempt: number) => number;
  conversationId?: string;
  refreshCredits?: (
    reason: "post_terminal" | "billing_failure",
    correlation: Readonly<{ requestId: string; serverRunId?: string }>,
  ) => Promise<void>;
  monotonicNow?: () => number;
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
  const persistAssistant = jest.fn(
    input.persistAssistant ?? (async () => undefined),
  );
  const reconcileHistory = jest.fn(async () => undefined);
  const reportError = jest.fn();
  const onLifecycle = jest.fn();
  const refreshCredits = jest.fn(input.refreshCredits ?? (async () => undefined));
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
    refreshCredits,
    requestClient: { request },
    ...(input.runStallGraceMs
      ? { runStallGraceMs: input.runStallGraceMs }
      : {}),
    resynchronizationDelayMs: input.resynchronizationDelayMs ?? (() => 0),
    now: () => 10_000,
    monotonicNow: input.monotonicNow ?? (() => 0),
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
    refreshCredits,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
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
  it("bootstraps and stages selected context before the chat session is hydrated", async () => {
    const harness = createHarness();
    const rootMessageId = "user_context_before_hydration";

    await expect(harness.agent.stageContext(rootMessageId, []))
      .resolves.toMatchObject({
        contract_version: "thin-agent-v1",
        context_ref: expect.stringMatching(/^ctx1_/u),
        bytes: 2,
      });

    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.request.mock.calls[0]?.[0]).toMatchObject({
      url: "https://systemsculpt.test/api/plugin/agent/bootstrap",
      method: "POST",
      licenseKey: "license_test",
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
    });
    expect(harness.request.mock.calls[1]?.[0]).toMatchObject({
      url: "https://systemsculpt.test/api/plugin/agent/context",
      method: "POST",
      headers: {
        Authorization: `Bearer access_token_${"a".repeat(32)}`,
        "x-plugin-version": "6.2.7",
      },
      body: {
        contract_version: "thin-agent-v1",
        root_message_id: rootMessageId,
        context_sources: [],
      },
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
    });
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "context_prepare_completed",
      phase: "start",
      conversationId: CONVERSATION_ID,
      requestId: rootMessageId,
    }));
  });

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

  it("preserves the server failure classifier for safe support diagnostics", async () => {
    let now = 1_000;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    const turnId = "user_classified_failure";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Classify this failure"),
      clientStartedAtMonotonicMs: 900,
    });
    await waitFor(() => harness.commands().some((command) => command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_classified_failure", "Partial failed response"),
    ));
    now = 1_750;
    server.serverMessage(failedTerminal(
      turnId,
      turnId,
      "response_capacity_unavailable",
      true,
    ));

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "response_capacity_unavailable",
        requestId: `incident_${"f".repeat(32)}`,
        retryable: true,
      },
    });
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "response_result_received_failed",
      failureCode: "response_capacity_unavailable",
      incidentId: `incident_${"f".repeat(32)}`,
    }));
    const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0] as
      readonly ChatMessage[];
    expect(reconciled.find((message) =>
      message.message_id === "assistant_classified_failure"))
      .toMatchObject({ responseDurationMs: 850 });
  });

  it("releases a fast failure terminal before running is observed and admits the next turn", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const firstTurnId = "user_fast_terminal_failure";
    const firstRun = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId: firstTurnId,
      message: userMessage(firstTurnId, "Fail before publishing running"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));

    // A rejected provider request may publish terminal authority without a
    // preceding running observation. That ordering must still finish and
    // release the local run immediately.
    server.serverMessage(failedTerminal(
      firstTurnId,
      firstTurnId,
      "response_capacity_unavailable",
      true,
    ));

    await expect(firstRun).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "response_capacity_unavailable",
        retryable: true,
      },
    });
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "run_finished_failed",
      requestId: firstTurnId,
    }));
    expect((harness.agent as unknown as { active: unknown }).active).toBeNull();
    expect(harness.refreshCredits).not.toHaveBeenCalled();

    server.snapshotMessages = [wireUser(firstTurnId, "Fail before publishing running")];
    server.snapshotRunState = idle(1);
    const secondTurnId = "user_after_fast_terminal_failure";
    const secondRun = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId: secondTurnId,
      message: userMessage(secondTurnId, "Recover immediately"),
    });
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "submit").length === 2);
    server.serverMessage(assistantSnapshot(
      secondTurnId,
      wireAssistant("assistant_after_fast_terminal_failure", "Recovered immediately"),
    ));
    server.serverMessage(succeededTerminal(secondTurnId, secondTurnId));

    await expect(secondRun).resolves.toMatchObject({ kind: "completed" });
    expect(harness.refreshCredits).toHaveBeenCalledTimes(1);
    expect(harness.refreshCredits).toHaveBeenCalledWith("post_terminal", {
      requestId: secondTurnId,
      serverRunId: RUN_ID,
    });
  });

  it("releases a provider-timeout failure delivered after only queue and placeholder traffic", async () => {
    // Pins the live incident wire order for a provider timeout: the turn
    // stream carried a queue snapshot, the submit acknowledgement, and a
    // streaming assistant placeholder — never a running run_state — before the
    // failed terminal arrived and the stream closed. That terminal must still
    // release the run as failed instead of leaving a live "Thinking" turn.
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_provider_timeout_failure";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Time out at the provider"),
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
          user_message: userMessage(turnId, "Time out at the provider"),
        }],
      },
    }));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "submit",
      status: "accepted",
    }));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_provider_timeout", [
        { type: "text", text: "", state: "streaming" },
      ]),
    ));
    await tick();
    server.serverMessage(failedTerminal(
      turnId,
      turnId,
      "response_service_unavailable",
      true,
    ));

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "response_service_unavailable",
        retryable: true,
      },
    });
    expect(harness.agent.getSnapshot()).toMatchObject({ status: "failed" });
    expect((harness.agent as unknown as { active: unknown }).active).toBeNull();
  });

  it("does not let a stalled balance refresh hold terminal completion or follow-up work", async () => {
    const refreshStarted = deferred<void>();
    const neverRefreshes = deferred<void>();
    const harness = createHarness({
      refreshCredits: async () => {
        refreshStarted.resolve();
        await neverRefreshes.promise;
      },
    });
    const server = await harness.open();
    const firstTurnId = "user_stalled_refresh_first";
    const firstRun = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId: firstTurnId,
      message: userMessage(firstTurnId, "Complete before refreshing credits"),
    });
    await waitFor(() => harness.commands().some((command) => command.kind === "submit"));
    server.serverMessage(runState(active(1, firstTurnId, firstTurnId)));
    server.serverMessage(assistantSnapshot(
      firstTurnId,
      wireAssistant("assistant_stalled_refresh_first", "First answer"),
    ));
    // Production publishes idle immediately before terminal. The completed
    // run must release even when the best-effort balance request never does.
    server.serverMessage(sessionSnapshot([
      wireUser(firstTurnId, "Complete before refreshing credits"),
      wireAssistant("assistant_stalled_refresh_first", "First answer"),
    ], idle(2)));
    server.serverMessage(succeededTerminal(firstTurnId, firstTurnId));

    await expect(firstRun).resolves.toMatchObject({ kind: "completed" });
    await refreshStarted.promise;
    expect(harness.refreshCredits).toHaveBeenCalledWith("post_terminal", {
      requestId: firstTurnId,
      serverRunId: RUN_ID,
    });
    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "completed",
      turnId: firstTurnId,
    });
    expect(harness.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({
      message_id: "assistant_stalled_refresh_first",
      content: "First answer",
    }));
    expect(harness.reportError).not.toHaveBeenCalled();

    // hydrate() reconnects before a same-conversation follow-up, so its GET
    // snapshot must expose the same terminal authority the live server does.
    server.snapshotMessages = [
      wireUser(firstTurnId, "Complete before refreshing credits"),
      wireAssistant("assistant_stalled_refresh_first", "First answer"),
    ];
    server.snapshotRunState = idle(2);
    const secondTurnId = "user_stalled_refresh_second";
    const secondRun = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId: secondTurnId,
      message: userMessage(secondTurnId, "Start while credits still refresh"),
    });
    await waitFor(() => harness.commands().filter((command) =>
      command.kind === "submit").length === 2);
    server.serverMessage(runState(active(3, secondTurnId, secondTurnId)));
    server.serverMessage(assistantSnapshot(
      secondTurnId,
      wireAssistant("assistant_stalled_refresh_second", "Second answer"),
    ));
    server.serverMessage(sessionSnapshot([
      wireUser(firstTurnId, "Complete before refreshing credits"),
      wireAssistant("assistant_stalled_refresh_first", "First answer"),
      wireUser(secondTurnId, "Start while credits still refresh"),
      wireAssistant("assistant_stalled_refresh_second", "Second answer"),
    ], idle(4)));
    server.serverMessage(succeededTerminal(secondTurnId, secondTurnId));

    await expect(secondRun).resolves.toMatchObject({ kind: "completed" });
    await waitFor(() => harness.refreshCredits.mock.calls.length === 2);
    expect(harness.refreshCredits.mock.calls).toEqual([
      ["post_terminal", { requestId: firstTurnId, serverRunId: RUN_ID }],
      ["post_terminal", { requestId: secondTurnId, serverRunId: RUN_ID }],
    ]);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("refreshes credits after an authoritative billing failure", async () => {
    const refreshFailure = new Error("balance refresh failed");
    const completionOrder: string[] = [];
    const harness = createHarness({
      refreshCredits: async () => {
        completionOrder.push("session_refresh");
        throw refreshFailure;
      },
    });
    const server = await harness.open();
    const turnId = "user_billing_terminal";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Use the remaining credits"),
    });
    void run.then(() => { completionOrder.push("run_consumer"); });
    await waitFor(() => harness.commands().some((command) => command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(failedTerminal(turnId, turnId, "insufficient_credits", false));

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "insufficient_credits" },
    });
    expect(harness.refreshCredits).toHaveBeenCalledTimes(1);
    expect(harness.refreshCredits).toHaveBeenCalledWith("billing_failure", {
      requestId: turnId,
      serverRunId: RUN_ID,
    });
    await tick();
    expect(completionOrder).toEqual(["session_refresh", "run_consumer"]);
    expect(harness.reportError).toHaveBeenCalledWith(refreshFailure);
  });

  it("contains a synchronous billing balance refresh failure after releasing the run", async () => {
    const refreshFailure = new Error("synchronous balance refresh failed");
    const harness = createHarness({
      refreshCredits: (() => { throw refreshFailure; }) as (
        reason: "post_terminal" | "billing_failure",
        correlation: Readonly<{ requestId: string; serverRunId?: string }>,
      ) => Promise<void>,
    });
    const server = await harness.open();
    const turnId = "user_sync_billing_refresh_failure";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Finish despite refresh failure"),
    });
    await waitFor(() => harness.commands().some((command) => command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(failedTerminal(turnId, turnId, "insufficient_credits", false));

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "insufficient_credits" },
    });
    await tick();
    expect(harness.refreshCredits).toHaveBeenCalledTimes(1);
    expect(harness.refreshCredits).toHaveBeenCalledWith("billing_failure", {
      requestId: turnId,
      serverRunId: RUN_ID,
    });
    expect(harness.reportError).toHaveBeenCalledWith(refreshFailure);
  });

  it("settles a queued command billing failure and refreshes credits", async () => {
    const harness = createHarness();
    const server = await harness.open();
    const turnId = "user_billing_queued_command";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Start after reconnecting"),
    });
    await waitFor(() => harness.commands().some((command) => command.kind === "submit"));

    (harness.agent as any).handleCommandDeliveryError(Object.assign(
      new Error("Not enough credits are available."),
      {
        code: "insufficient_credits",
        status: 402,
        retryable: false,
        serverAdmissionPossible: false,
      },
    ), (harness.agent as any).generation);
    server.endTurn();

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "insufficient_credits", status: 402, retryable: false },
    });
    expect(server.turnRequests).toBe(1);
    expect(harness.refreshCredits).toHaveBeenCalledTimes(1);
  });

  it("treats a 402 submit as definite non-admission without replay", async () => {
    const harness = createHarness();
    const server = await harness.open();
    server.turnStatus = 402;
    const turnId = "user_billing_submit";

    await expect(harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Start a billed response"),
    })).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "insufficient_credits",
        requestId: `incident_${"e".repeat(32)}`,
        status: 402,
        retryable: false,
      },
    });

    await tick();
    await tick();
    expect(server.turnRequests).toBe(1);
    expect(harness.refreshCredits).toHaveBeenCalledTimes(1);
  });

  it("treats a 402 regeneration as definite non-admission without replay", async () => {
    const harness = createHarness();
    const rootMessageId = "user_billing_regeneration_root";
    const server = await harness.open([
      wireUser(rootMessageId, "Retry this response"),
      wireAssistant("assistant_billing_regeneration_old", "Old answer"),
    ]);
    server.turnStatus = 402;

    await expect(harness.agent.regenerate({
      conversationId: CONVERSATION_ID,
      requestId: "request_billing_regeneration",
      rootMessageId,
    })).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "insufficient_credits",
        requestId: `incident_${"e".repeat(32)}`,
        status: 402,
        retryable: false,
      },
    });

    await tick();
    await tick();
    expect(server.turnRequests).toBe(1);
    expect(harness.refreshCredits).toHaveBeenCalledTimes(1);
  });

  it("does not confirm detach while terminal persistence can still call the outgoing view", async () => {
    const releasePersistence = deferred<void>();
    const persistenceStarted = deferred<void>();
    const harness = trackedHarness({
      persistAssistant: async () => {
        persistenceStarted.resolve();
        await releasePersistence.promise;
      },
    });
    const server = await harness.open();
    const turnId = "user_detach_persistence_barrier";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Wait for the outgoing persistence callback"),
    });
    await waitFor(() => harness.commands().some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_detach_persistence_barrier", "Saved answer"),
    ));
    server.serverMessage(succeededTerminal(turnId, turnId));
    await persistenceStarted.promise;

    let detached = false;
    const detaching = harness.agent.detach().then(() => { detached = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(detached).toBe(false);

    releasePersistence.resolve();
    await detaching;
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.persistAssistant).toHaveBeenCalledTimes(1);
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

  it("keeps the cancelled partial in durable history when the post-cancel snapshot omits it", async () => {
    let now = 1_000;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    const turnId = "user_cancel_partial_snapshot_race";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Stream a long response"),
      clientStartedAtMonotonicMs: 900,
    });
    await waitFor(() => harness.commands().some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant("message_cancel_partial_race", [
      { type: "text", text: "PARTIAL-STREAM-START\n1\n2\n3", state: "streaming" },
    ])));
    await tick();

    const cancellation = harness.agent.cancel();
    await waitFor(() => harness.commands().some((command) =>
      command.kind === "cancel"));
    // The server broadcast racing the durable write of the partial: the
    // snapshot still carries only the user root when the terminal lands.
    server.serverMessage(sessionSnapshot(
      [wireUser(turnId, "Stream a long response")],
      active(2, turnId, turnId),
    ));
    now = 1_750;
    server.serverMessage(cancelledTerminal(turnId, turnId));
    server.endTurn();

    await cancellation;
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    await harness.agent.detach();
    const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0] as
      readonly ChatMessage[];
    const restored = reconciled.find((message) =>
      message.role === "assistant"
      && String(message.content).includes("PARTIAL-STREAM-START"));
    expect(restored).toBeDefined();
    expect(restored?.terminalOutcome).toBe("cancelled");
    expect(restored?.responseDurationMs).toBe(850);
  });

  it("never rewrites durable history to a bare prefix while the run is finalizing", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_finalizing_prefix";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Answer briefly"),
    });
    await waitFor(() => harness.commands().some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(
      "message_finalizing_prefix",
      [{ type: "text", text: "SETTLED-ANSWER", state: "done" }],
    )));
    await tick();
    server.serverMessage(succeededTerminal(turnId, turnId));
    // A late snapshot lands between terminal acceptance and finalization,
    // carrying only the turn's user root. It must not rewrite durable
    // history without the finished assistant turn.
    server.serverMessage(sessionSnapshot(
      [wireUser(turnId, "Answer briefly")],
      idle(2),
    ));
    server.endTurn();

    await expect(run).resolves.toMatchObject({ kind: "completed" });
    await harness.agent.detach();
    const rewrites = harness.reconcileHistory.mock.calls.map((call) =>
      call[0] as readonly ChatMessage[]);
    expect(rewrites.length).toBeGreaterThan(0);
    const droppedFinishedTurn = rewrites.some((messages) =>
      messages.some((message) =>
        message.role === "user" && message.message_id === turnId)
      && !messages.some((message) =>
        message.role === "assistant"
        && String(message.content).includes("SETTLED-ANSWER")));
    expect(droppedFinishedTurn).toBe(false);
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

  it("resynchronizes a clean EOF without a terminal instead of inventing an outcome", async () => {
    let now = 100;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    server.turnHeaders = {
      "content-type": "text/event-stream",
      "x-systemsculpt-agent-latency-trace": "1".repeat(32),
    };
    server.turnHeaders = {
      "content-type": "text/event-stream",
      "x-systemsculpt-agent-latency-trace": "1".repeat(32),
      "server-timing": "app;dur=8.5, auth;dur=1.25",
    };
    const turnId = "user_clean_eof_recovery";
    const user = wireUser(turnId, "Recover a clean EOF");
    const assistant = wireAssistant("assistant_clean_eof_recovery", [{
      type: "text",
      text: "Recovered from durable authority",
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
    const initialSnapshotReads = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;

    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Recover a clean EOF"),
      clientStartedAtMonotonicMs: 90,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    now = 120;
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();
    server.snapshotMessages = [user, assistant];
    server.snapshotRunState = idle(2);
    now = 130;
    server.endTurn();

    await expect(run).resolves.toMatchObject({ kind: "completed" });
    const snapshotReads = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;
    expect(snapshotReads).toBeGreaterThan(initialSnapshotReads);
    expect(harness.commands(server).filter((command) =>
      command.kind === "submit" && command.request_id === turnId)).toHaveLength(1);
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "response_stream_ended_incomplete",
      requestId: turnId,
      failureCode: "turn_stream_incomplete",
      retryable: true,
      clientClockDomain: "client_turn_monotonic",
    }));
    expect(harness.onLifecycle).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "run_stalled" }),
    );
    expect(harness.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({
      message_id: assistant.id,
      content: "Recovered from durable authority",
    }));
  });

  it("accepts clean EOF at a waiting-for-client segment boundary", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_waiting_segment_eof";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Pause at the client boundary"),
      clientStartedAtMonotonicMs: 0,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(
      1,
      turnId,
      turnId,
      "waiting_for_client",
    )));
    await tick();
    server.endTurn();
    await tick();

    expect(harness.onLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "response_stream_ended_incomplete",
    }));
    expect(harness.agent.getSnapshot()).toMatchObject({
      turnId,
      status: "running",
    });

    server.serverMessage(cancelledTerminal(turnId, turnId));
    await harness.agent.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("does not switch authoritative conversations while a response is active", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_active_conversation_guard";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep this response in its original chat"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();

    await expect(harness.agent.hydrate(`conversation_${"9".repeat(32)}`))
      .rejects.toThrow("Wait for the current response to finish");

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("preserves an explicit client lifecycle offset without run latency state", () => {
    const harness = trackedHarness();
    const requestId = "user_explicit_client_lifecycle_offset";

    harness.agent.recordClientRequestLifecycle({
      code: "composer_unlocked",
      phase: "render",
      requestId,
      clientMonotonicOffsetMs: 37.5,
    });

    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "composer_unlocked",
      phase: "render",
      requestId,
      clientMonotonicOffsetMs: 37.5,
      clientClockDomain: "client_turn_monotonic",
    }));
  });

  it("bounds retained latency state while preserving current delivery metadata", async () => {
    const harness = trackedHarness({
      monotonicNow: () => {
        throw new Error("A diagnostic clock is unavailable.");
      },
    });
    const server = await harness.open();
    const platformRequestClient = new PlatformRequestClient();
    server.transformTurnResponse = async (response) => {
      const fetchRequest = jest.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(response);
      try {
        return await platformRequestClient.request({
          url: "https://systemsculpt.test/test-only-mark-stream",
          method: "POST",
          body: {},
          stream: true,
          preserveResponseHeaders: true,
          allowTransportFallback: false,
          transport: "fetch",
        });
      } finally {
        fetchRequest.mockRestore();
      }
    };
    server.turnStatus = 402;
    const turnIds = Array.from(
      { length: 9 },
      (_, index) => `user_latency_retention_${index}`,
    );

    for (const turnId of turnIds) {
      await expect(harness.agent.start({
        conversationId: CONVERSATION_ID,
        turnId,
        message: userMessage(turnId, "Reject this turn without losing diagnostics"),
      })).resolves.toMatchObject({
        kind: "failed",
        error: { code: "insufficient_credits" },
      });
    }

    harness.onLifecycle.mockClear();
    const observedAt = performance.now();
    harness.agent.recordClientRenderMilestone(
      "response_first_dom_committed",
      turnIds[0],
      observedAt,
    );
    harness.agent.recordClientRenderMilestone(
      "response_first_dom_committed",
      turnIds.at(-1)!,
      observedAt,
    );

    expect(harness.onLifecycle).toHaveBeenCalledTimes(1);
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "response_first_dom_committed",
      requestId: turnIds.at(-1),
      clientClockDomain: "client_turn_monotonic",
    }));
  });

  it("records first transport, assistant, projection, and terminal timing once", async () => {
    let now = 200;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    server.turnHeaders = {
      "content-type": "text/event-stream",
      "x-systemsculpt-agent-latency-trace": "2".repeat(32),
      "server-timing": "app;dur=11.5, auth;dur=3",
    };
    const turnId = "user_latency_waterfall";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Measure this response"),
      clientStartedAtMonotonicMs: 150,
      beforeSend: async () => undefined,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    now = 220;
    server.serverMessage(runState(active(1, turnId, turnId)));
    await tick();
    now = 230;
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_latency", [{
        type: "text",
        text: "First delta",
        state: "streaming",
      }]),
    ));
    await tick();
    now = 240;
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_latency", [{
        type: "text",
        text: "Later delta",
        state: "streaming",
      }]),
    ));
    now = 250;
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    now = 260;
    harness.agent.recordClientRenderMilestone(
      "response_first_dom_committed",
      turnId,
      now,
    );
    harness.agent.recordClientRenderMilestone(
      "response_first_dom_committed",
      turnId,
      now + 1,
    );
    now = 270;
    harness.agent.recordClientRenderMilestone(
      "response_first_paint_opportunity",
      turnId,
      now,
    );

    const records = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.requestId === turnId);
    for (const code of [
      "response_prepare_started",
      "response_prepare_completed",
      "response_available",
      "response_first_body_chunk_observed",
      "response_first_sse_frame_parsed",
      "response_first_assistant_sse_frame_parsed",
      "response_first_assistant_snapshot_received",
      "response_first_assistant_snapshot_projected",
      "response_first_content_projected",
      "response_result_received_succeeded",
      "response_save_started",
      "response_save_completed",
      "response_first_dom_committed",
      "response_first_paint_opportunity",
    ]) {
      expect(records.filter((record) => record.code === code)).toHaveLength(1);
    }
    expect(records.find((record) => record.code === "response_available"))
      .toMatchObject({
        latencyTraceId: "2".repeat(32),
        serverTimingAppMs: 11.5,
        serverTimingAuthMs: 3,
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        serverTimingClockDomain: "server_response_headers_monotonic_duration",
      });
    const preparationAndRun = records.filter((record) => [
      "response_prepare_started",
      "response_prepare_completed",
      "run_started",
    ].includes(String(record.code)));
    expect(preparationAndRun).toHaveLength(3);
    expect(preparationAndRun.every((record) =>
      typeof record.clientMonotonicOffsetMs === "number"
      && record.clientMonotonicOffsetMs >= 50)).toBe(true);
    const history = records.filter((record) =>
      String(record.code).startsWith("history_sync_"));
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "history_sync_started",
        historySyncKind: "before_send",
        historySyncOrdinal: 1,
      }),
      expect.objectContaining({
        code: "history_sync_completed",
        historySyncKind: "before_send",
        historySyncOrdinal: 1,
      }),
      expect.objectContaining({
        code: "history_sync_started",
        historySyncKind: "terminal",
        historySyncOrdinal: expect.any(Number),
      }),
      expect.objectContaining({
        code: "history_sync_completed",
        historySyncKind: "terminal",
        historySyncOrdinal: expect.any(Number),
      }),
    ]));
    const offsets = records
      .map((record) => record.clientMonotonicOffsetMs)
      .filter((value): value is number => typeof value === "number");
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(records.filter((record) => "clientMonotonicOffsetMs" in record)
      .every((record) => record.clientClockDomain === "client_turn_monotonic"))
      .toBe(true);
  });

  it("projects elapsed response time and freezes it when the terminal arrives", async () => {
    let now = 1_000;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    const turnId = "user_response_duration";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Measure the complete response"),
      clientStartedAtMonotonicMs: 900,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));

    now = 1_200;
    server.serverMessage(runState(active(1, turnId, turnId)));
    await waitFor(() => harness.agent.getSnapshot().elapsedMs === 300);
    expect(harness.agent.getSnapshot().elapsedMs).toBe(300);

    now = 1_500;
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_response_duration", "Measured answer"),
    ));
    await waitFor(() => harness.agent.getSnapshot().elapsedMs === 600);
    expect(harness.agent.getSnapshot().elapsedMs).toBe(600);

    now = 1_750;
    server.serverMessage(succeededTerminal(turnId, turnId));
    const result = await run;
    expect(result.snapshot.elapsedMs).toBe(850);
    expect(harness.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({
      responseDurationMs: 850,
    }));

    now = 9_000;
    expect(harness.agent.getSnapshot().elapsedMs).toBe(850);
  });

  it("omits an invalid retained response clock and keeps the terminal value frozen", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_non_finite_response_duration";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Ignore an invalid response clock"),
      clientStartedAtMonotonicMs: 900,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_non_finite_duration", "Answer without a duration"),
    ));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "text"));
    const internals = harness.agent as any;
    const activeRun = internals.active;
    activeRun.elapsedMs = null;
    internals.clientLatency.get(turnId).startedAtMonotonicMs = Number.POSITIVE_INFINITY;

    server.serverMessage(succeededTerminal(turnId, turnId));
    const result = await run;
    expect(result.snapshot.elapsedMs).toBeUndefined();
    const persisted = harness.persistAssistant.mock.calls.at(-1)?.[0];
    expect(persisted?.responseDurationMs).toBeUndefined();

    internals.updateActiveElapsed(activeRun);
    expect(activeRun.elapsedMs).toBeNull();
  });

  it.each(["failed", "cancelled"] as const)(
    "reconciles duration for a locally %s turn only after durable partial work exists",
    async (outcome) => {
      let now = 1_000;
      const harness = trackedHarness({ monotonicNow: () => now });
      const server = await harness.open();
      const turnId = `user_local_duration_${outcome}`;
      const assistantId = `assistant_local_duration_${outcome}`;
      const run = harness.agent.start({
        conversationId: CONVERSATION_ID,
        turnId,
        message: userMessage(turnId, "Keep the partial work duration"),
        clientStartedAtMonotonicMs: 900,
      });
      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "submit"));
      server.serverMessage(runState(active(1, turnId, turnId)));
      server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [{
        type: "reasoning",
        text: "Durable partial reasoning",
        state: "done",
      }])));
      await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
        part.kind === "reasoning"));
      await tick();
      harness.reconcileHistory.mockClear();

      now = 1_750;
      const internals = harness.agent as any;
      const activeRun = internals.active;
      if (outcome === "failed") {
        internals.finishLocalFailure(activeRun, {
          code: "local_duration_failure",
          message: "The local response stopped.",
          retryable: false,
        });
      } else {
        internals.finishLocalCancellation(activeRun);
      }
      expect(internals.active).toBeNull();
      server.endTurn();
      await expect(run).resolves.toMatchObject({ kind: outcome });
      await waitFor(() => harness.reconcileHistory.mock.calls.length > 0);

      const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0] as
        readonly ChatMessage[];
      expect(reconciled.find((message) => message.message_id === assistantId))
        .toMatchObject({ responseDurationMs: 850 });
    },
  );

  it("does not reconcile local terminal duration for an empty assistant placeholder", async () => {
    let now = 1_000;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    const turnId = "user_empty_local_duration";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Do not persist an empty response"),
      clientStartedAtMonotonicMs: 900,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_empty_local_duration", [{
        type: "text",
        text: "",
        state: "streaming",
      }]),
    ));
    await tick();
    await tick();
    harness.reconcileHistory.mockClear();

    now = 1_750;
    const internals = harness.agent as any;
    internals.finishLocalFailure(internals.active, {
      code: "local_empty_failure",
      message: "The local response stopped.",
      retryable: false,
    });
    server.endTurn();
    await expect(run).resolves.toMatchObject({ kind: "failed" });
    await tick();

    expect(harness.reconcileHistory).not.toHaveBeenCalled();
  });

  it("reconciles partial-work duration before detach releases the conversation", async () => {
    let now = 1_000;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    const turnId = "user_detach_duration";
    const assistantId = "assistant_detach_duration";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep work when this chat detaches"),
      clientStartedAtMonotonicMs: 900,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [{
      type: "reasoning",
      text: "Partial work before detach",
      state: "done",
    }])));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "reasoning"));
    await tick();
    harness.reconcileHistory.mockClear();

    now = 1_750;
    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });

    const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0] as
      readonly ChatMessage[];
    expect(reconciled.find((message) => message.message_id === assistantId))
      .toMatchObject({ responseDurationMs: 850 });
  });

  it("keeps a cold response preparation failure on the original request clock", async () => {
    let now = 100;
    const request = jest.fn<Promise<Response>, [PlatformRequestInput]>(async () => {
      now = 125;
      throw Object.assign(new Error("cold preparation failed"), { status: 503 });
    });
    const harness = trackedHarness({ request, monotonicNow: () => now });
    const turnId = "user_cold_prepare_failure";

    await expect(harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep the failed preparation correlated"),
      clientStartedAtMonotonicMs: 75,
    })).resolves.toMatchObject({ kind: "failed" });

    const preparation = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.requestId === turnId
        && String(record.code).startsWith("response_prepare_"));
    expect(preparation).toEqual([
      expect.objectContaining({
        code: "response_prepare_started",
        clientMonotonicOffsetMs: 25,
        clientClockDomain: "client_turn_monotonic",
      }),
      expect.objectContaining({
        code: "response_prepare_failed",
        clientMonotonicOffsetMs: 50,
        clientClockDomain: "client_turn_monotonic",
        status: 503,
      }),
    ]);
  });

  it("keeps a rejected response save on the original request clock", async () => {
    let now = 200;
    const harness = trackedHarness({
      monotonicNow: () => now,
      persistAssistant: async () => {
        now = 275;
        throw new Error("save rejected");
      },
    });
    const server = await harness.open();
    const turnId = "user_response_save_rejected";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep the failed save correlated"),
      clientStartedAtMonotonicMs: 150,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    now = 220;
    server.serverMessage(runState(active(1, turnId, turnId)));
    now = 230;
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant("assistant_save_rejected", "Save this authoritative answer"),
    ));
    await tick();
    now = 240;
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });

    const saves = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.requestId === turnId
        && String(record.code).startsWith("response_save_"));
    expect(saves).toEqual([
      expect.objectContaining({
        code: "response_save_started",
        clientMonotonicOffsetMs: 90,
        clientClockDomain: "client_turn_monotonic",
      }),
      expect.objectContaining({
        code: "response_save_failed",
        clientMonotonicOffsetMs: 125,
        clientClockDomain: "client_turn_monotonic",
      }),
    ]);
  });

  it("retains every command-segment trace and attributes later render work to the latest", async () => {
    let now = 300;
    const harness = trackedHarness({ monotonicNow: () => now });
    const server = await harness.open();
    server.turnHeaders = {
      "content-type": "text/event-stream",
      "x-systemsculpt-agent-latency-trace": "3".repeat(32),
    };
    const turnId = "user_segment_trace_stability";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Keep the first segment trace"),
      clientStartedAtMonotonicMs: 290,
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));

    const internal = harness.agent as unknown as {
      handleTransportTiming: (event: Readonly<Record<string, unknown>>) => void;
    };
    internal.handleTransportTiming({
      milestone: "response_available",
      requestId: turnId,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 2,
      observedAtMonotonicMs: 302,
      latencyTraceId: "4".repeat(32),
      responseDeliveryMode: "request_url_buffered",
      status: 200,
    });
    internal.handleTransportTiming({
      milestone: "first_body_chunk",
      requestId: turnId,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 2,
      observedAtMonotonicMs: 303,
      latencyTraceId: "4".repeat(32),
      responseDeliveryMode: "request_url_buffered",
    });
    // A callback from the older submit stream arrives after segment 2. It must
    // remain bound to segment 1 and cannot relabel later logical UI milestones.
    internal.handleTransportTiming({
      milestone: "first_body_chunk",
      requestId: turnId,
      commandKind: "submit",
      commandSegmentOrdinal: 1,
      observedAtMonotonicMs: 304,
      latencyTraceId: "3".repeat(32),
    });

    now = 310;
    harness.agent.recordClientRenderMilestone(
      "response_first_dom_committed",
      turnId,
      now,
    );
    const responseAvailable = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.code === "response_available"
        && record.requestId === turnId);
    expect(responseAvailable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        latencyTraceId: "3".repeat(32),
        commandKind: "submit",
        commandSegmentOrdinal: 1,
      }),
      expect.objectContaining({
        latencyTraceId: "4".repeat(32),
        commandKind: "client_tool_result",
        commandSegmentOrdinal: 2,
        responseDeliveryMode: "request_url_buffered",
      }),
    ]));
    expect(responseAvailable).toHaveLength(2);
    const bodyChunks = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.code === "response_first_body_chunk_observed"
        && record.requestId === turnId);
    expect(bodyChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        latencyTraceId: "3".repeat(32),
        commandKind: "submit",
        commandSegmentOrdinal: 1,
      }),
      expect.objectContaining({
        latencyTraceId: "4".repeat(32),
        commandKind: "client_tool_result",
        commandSegmentOrdinal: 2,
      }),
    ]));
    const dom = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .find((record) => record.code === "response_first_dom_committed"
        && record.requestId === turnId);
    expect(dom).toEqual(expect.objectContaining({
      code: "response_first_dom_committed",
      requestId: turnId,
      clientClockDomain: "client_turn_monotonic",
    }));
    expect(dom).not.toEqual(expect.objectContaining({
      latencyTraceId: expect.any(String),
    }));
    expect(dom).not.toEqual(expect.objectContaining({
      commandSegmentOrdinal: expect.any(Number),
    }));

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("does not allocate a tool execution ordinal from an unknown transport ID", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_unknown_transport_tool_id";
    void harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Ignore an unestablished transport tool identity"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));

    const internal = harness.agent as unknown as {
      handleTransportTiming: (event: Readonly<Record<string, unknown>>) => void;
    };
    internal.handleTransportTiming({
      milestone: "command_dispatch_started",
      requestId: turnId,
      commandKind: "client_tool_result",
      commandSegmentOrdinal: 99,
      toolCallId: "call_unestablished_transport_only",
      observedAtMonotonicMs: 1,
    });

    const dispatch = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .find((record) => record.code === "command_segment_dispatch_started"
        && record.commandSegmentOrdinal === 99);
    expect(dispatch).toMatchObject({
      requestId: turnId,
      commandKind: "client_tool_result",
      toolCallId: "call_unestablished_transport_only",
    });
    expect(dispatch).not.toHaveProperty("toolExecutionOrdinal");
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

    // Leading-edge presentation: the first streamed snapshot paints
    // immediately and follow-ups inside the 16ms window coalesce. Under load
    // a window can expire mid-burst, so pin the leading paint and the final
    // frame rather than an exact frame count.
    await waitFor(() => presented.length >= 1);
    expect(presented[0]).toMatchObject({
      status: "running",
      phase: "working",
      messages: [{ id: "assistant_new", role: "assistant" }],
    });
    await waitFor(() =>
      presented[presented.length - 1]!.parts.length === 4);
    expect(presented.length).toBeLessThanOrEqual(3);
    const settled = presented[presented.length - 1]!;
    expect(settled).toMatchObject({
      status: "running",
      phase: "working",
      messages: [{ id: "assistant_new", role: "assistant" }],
    });
    expect(settled.parts).toEqual([
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
      output: {
        success: false,
        data: { provider: "upstream-provider-sentinel" },
        error: {
          code: "UPSTREAM_PROVIDER_SENTINEL",
          message: "The upstream provider rejected this search.",
        },
      },
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
    const persisted = harness.persistAssistant.mock.calls.at(-1)?.[0];
    expect(persisted).toMatchObject({
      tool_calls: [expect.objectContaining({
        id: "call_failed_web_search",
        executedOn: "server",
        result: {
          success: false,
          error: {
            code: "TOOL_EXECUTION_FAILED",
            message: "Web search failed.",
          },
        },
      })],
    });
    expect(JSON.stringify(persisted)).not.toMatch(
      /upstream-provider-sentinel|UPSTREAM_PROVIDER_SENTINEL|upstream provider rejected/i,
    );
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

    // The synthetic approval id binds on the waiting_for_client pass, one
    // frame after the tool first projects as approval-required. Wait for the
    // actionable frame; polling can otherwise catch the id-less one.
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.state === "approval-required"
      && typeof (part as { approvalId?: string }).approvalId === "string"));
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

  it("settles a completed vault tool before continuation text starts streaming", async () => {
    const harness = trackedHarness({
      executeLocalTool: async () => ({
        success: true,
        data: { files: [{ path: "Notes/Ready.md", content: "Ready" }] },
      }),
    });
    const server = await harness.open([]);
    const turnId = "user_tool_settles_before_continuation";
    const callId = "call_tool_settles_before_continuation";
    const input = { paths: ["Notes/Ready.md"] };
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read the note and summarize it"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId)));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(
      "assistant_tool_settles_before_continuation",
      [
        clientToolRequest(callId, "read", input),
        {
          type: "tool-read",
          toolCallId: callId,
          state: "input-available",
          input,
        },
      ],
    )));
    server.serverMessage(runState(active(
      2,
      turnId,
      turnId,
      "waiting_for_client",
    )));

    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));
    await tick();
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    server.serverMessage(runState(active(3, turnId, turnId)));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(
      "assistant_tool_settles_before_continuation",
      [
        clientToolRequest(callId, "read", input),
        {
          type: "tool-read",
          toolCallId: callId,
          state: "output-available",
          input,
          output: { success: true, data: { files: [{ path: "Notes/Ready.md" }] } },
          // A client tool is not a generator. If an intermediate projection
          // still carries the SDK marker, local completion truth must win.
          preliminary: true,
        },
        {
          type: "text",
          text: "The note is ready.",
          state: "streaming",
        },
      ],
    )));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "text" && part.markdown === "The note is ready."));

    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "running",
      phase: "working",
      statusLabel: "Responding",
      parts: expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          callId,
          state: "succeeded",
        }),
        expect.objectContaining({
          kind: "text",
          state: "streaming",
          markdown: "The note is ready.",
        }),
      ]),
    });
    expect(harness.agent.getSnapshot().waitingReason).toBeUndefined();

    server.serverMessage(assistantSnapshot(turnId, wireAssistant(
      "assistant_tool_settles_before_continuation",
      [
        clientToolRequest(callId, "read", input),
        {
          type: "tool-read",
          toolCallId: callId,
          state: "output-available",
          input,
          output: { success: true, data: { files: [{ path: "Notes/Ready.md" }] } },
          preliminary: false,
        },
        { type: "text", text: "The note is ready.", state: "done" },
      ],
    )));
    await waitFor(() =>
      (harness.agent as any).active.completedLocalToolResults.size === 0);
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it.each(["input", "name"] as const)(
    "never projects a completed local result onto a same-ID tool with changed $change identity",
    async (change) => {
      const localResult: ToolCallResult = {
        success: true,
        data: { authority: "original-local-result" },
      };
      const harness = trackedHarness({
        executeLocalTool: async () => localResult,
      });
      const server = await harness.open([]);
      const turnId = `user_completed_result_identity_${change}`;
      const assistantId = `assistant_completed_result_identity_${change}`;
      const callId = `call_completed_result_identity_${change}`;
      const originalInput = { paths: ["Original.md"] };
      const changedInput = change === "input"
        ? { paths: ["Changed.md"] }
        : originalInput;
      const changedName = change === "name" ? "find" : "read";
      const run = harness.agent.start({
        conversationId: CONVERSATION_ID,
        turnId,
        message: userMessage(turnId, "Run one stable vault action"),
      });
      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "submit"));
      server.serverMessage(runState(active(
        1,
        turnId,
        turnId,
        "waiting_for_client",
      )));
      server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
        clientToolRequest(callId, "read", originalInput),
        {
          type: "tool-read",
          toolCallId: callId,
          state: "input-available",
          input: originalInput,
        },
      ])));
      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "client_tool_result" && command.tool_call_id === callId));
      await waitFor(() =>
        (harness.agent as any).active.completedLocalToolResults.has(callId));
      expect(harness.agent.getSnapshot().parts).toContainEqual(expect.objectContaining({
        kind: "tool",
        callId,
        state: "succeeded",
        output: expect.objectContaining({ data: localResult.data }),
      }));

      const projectedAfterIdentityChange: Array<
        ReturnType<typeof harness.agent.getSnapshot>
      > = [];
      const unsubscribe = harness.agent.subscribe((snapshot) => {
        projectedAfterIdentityChange.push(snapshot);
      });
      try {
        server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
          clientToolRequest(callId, changedName, changedInput),
          {
            type: `tool-${changedName}`,
            toolCallId: callId,
            state: "input-available",
            input: changedInput,
          },
        ])));

        await expect(run).resolves.toMatchObject({
          kind: "failed",
          error: { code: "client_tool_identity_mismatch", retryable: false },
        });
      } finally {
        unsubscribe();
      }

      const changedToolProjections = projectedAfterIdentityChange.flatMap(
        (snapshot) => snapshot.parts.filter(
          (part): part is AgentToolPart => part.kind === "tool"
            && part.callId === callId
            && part.name === changedName
            && JSON.stringify(part.input) === JSON.stringify(changedInput),
        ),
      );
      expect(changedToolProjections.length).toBeGreaterThan(0);
      expect(changedToolProjections.every((part) =>
        part.state !== "succeeded" && part.output === undefined)).toBe(true);
    },
  );

  it.each(["input-available", "preliminary"] as const)(
    "overlays locally settled success, partial, and failed results into a %s terminal before save, reconcile, and reload",
    async (terminalBoundary) => {
      const privateFailure = "/Users/private/SecretVault terminal overlay sentinel";
      const outcomes: readonly Readonly<{
        label: string;
        localResult: ToolCallResult;
        expectedResult: ToolCallResult;
        expectedToolState: ToolCall["state"];
        expectedProjectedState: AgentToolPart["state"];
        expectedDisplayState: ReturnType<typeof presentAgentTool>["displayState"];
        expectedIcon: string;
        expectedSummary: string;
      }>[] = [
        {
          label: "success",
          localResult: {
            success: true,
            data: {
              requestedFiles: 2,
              appliedFiles: 2,
              results: [
                { path: "Notes/First.md", success: true, appliedCount: 1 },
                { path: "Notes/Second.md", success: true, appliedCount: 1 },
              ],
            },
          },
          expectedResult: {
            success: true,
            data: {
              requestedFiles: 2,
              appliedFiles: 2,
              results: [
                { path: "Notes/First.md", success: true, appliedCount: 1 },
                { path: "Notes/Second.md", success: true, appliedCount: 1 },
              ],
            },
          },
          expectedToolState: "completed",
          expectedProjectedState: "succeeded",
          expectedDisplayState: "succeeded",
          expectedIcon: "check",
          expectedSummary: "Notes/First.md, Notes/Second.md",
        },
        {
          label: "mixed-partial",
          localResult: {
            success: false,
            data: {
              requestedFiles: 2,
              appliedFiles: 1,
              results: [
                { path: "Notes/Changed.md", success: true, appliedCount: 1 },
                {
                  path: "Notes/Failed.md",
                  success: false,
                  appliedCount: 0,
                  error: privateFailure,
                },
              ],
            },
            error: { code: "TOOL_PARTIAL_FAILURE", message: privateFailure },
          },
          expectedResult: {
            success: false,
            data: {
              requestedFiles: 2,
              appliedFiles: 1,
              results: [
                { path: "Notes/Changed.md", success: true, appliedCount: 1 },
                {
                  path: "Notes/Failed.md",
                  success: false,
                  appliedCount: 0,
                  error: "The vault action failed.",
                },
              ],
            },
            error: {
              code: "TOOL_EXECUTION_FAILED",
              message: "The vault action failed.",
            },
          },
          expectedToolState: "failed",
          expectedProjectedState: "failed",
          expectedDisplayState: "partial",
          expectedIcon: "x",
          expectedSummary: "1 completed, 1 failed",
        },
        {
          label: "all-failed",
          localResult: {
            success: false,
            data: {
              requestedFiles: 2,
              appliedFiles: 0,
              results: [
                {
                  path: "Notes/First.md",
                  success: false,
                  appliedCount: 0,
                  error: `${privateFailure} first`,
                },
                {
                  path: "Notes/Second.md",
                  success: false,
                  appliedCount: 0,
                  error: `${privateFailure} second`,
                },
              ],
            },
            error: { code: "TOOL_OPERATION_FAILED", message: privateFailure },
          },
          expectedResult: {
            success: false,
            data: {
              requestedFiles: 2,
              appliedFiles: 0,
              results: [
                {
                  path: "Notes/First.md",
                  success: false,
                  appliedCount: 0,
                  error: "The vault action failed.",
                },
                {
                  path: "Notes/Second.md",
                  success: false,
                  appliedCount: 0,
                  error: "The vault action failed.",
                },
              ],
            },
            error: {
              code: "TOOL_EXECUTION_FAILED",
              message: "The vault action failed.",
            },
          },
          expectedToolState: "failed",
          expectedProjectedState: "failed",
          expectedDisplayState: "failed",
          expectedIcon: "x",
          expectedSummary: "0 completed, 2 failed",
        },
      ];

      for (const outcome of outcomes) {
        const harness = trackedHarness({
          executeLocalTool: async () => outcome.localResult,
        });
        const server = await harness.open([]);
        const turnId = `user_durable_overlay_${terminalBoundary}_${outcome.label}`;
        const assistantId = `assistant_durable_overlay_${terminalBoundary}_${outcome.label}`;
        const callId = `call_durable_overlay_${terminalBoundary}_${outcome.label}`;
        const input = {
          files: [
            {
              path: "Notes/First.md",
              edits: [{ oldText: "before", newText: "after" }],
            },
            {
              path: "Notes/Second.md",
              edits: [{ oldText: "before", newText: "after" }],
            },
          ],
        };
        const request = clientToolRequest(callId, "multi_edit", input);
        const inputAvailable = {
          type: "tool-multi_edit",
          toolCallId: callId,
          state: "input-available",
          input,
        } as const;
        const run = harness.agent.start({
          conversationId: CONVERSATION_ID,
          turnId,
          message: userMessage(turnId, "Apply this batch and retain its exact outcome"),
          approvalPolicy: { requireDestructiveApproval: false },
        });
        await waitFor(() => harness.commands(server).some((command) =>
          command.kind === "submit"));
        server.serverMessage(sessionSnapshot(
          [wireUser(turnId, "Apply this batch and retain its exact outcome")],
          active(1, turnId, turnId, "waiting_for_client"),
        ));
        server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
          request,
          inputAvailable,
          { type: "text", text: "The batch is settled.", state: "done" },
        ])));
        await waitFor(() => harness.commands(server).some((command) =>
          command.kind === "client_tool_result" && command.tool_call_id === callId));

        const outbound = harness.commands(server).find((command) =>
          command.kind === "client_tool_result" && command.tool_call_id === callId);
        expect(outbound).toMatchObject({
          tool_call_id: callId,
          tool_name: "multi_edit",
          output: outcome.expectedResult,
        });
        expect(JSON.stringify(outbound)).not.toContain(privateFailure);

        if (terminalBoundary === "preliminary") {
          server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
            request,
            {
              ...inputAvailable,
              state: "output-available",
              output: {
                success: true,
                data: { staleServerPreliminaryResult: true },
              },
              preliminary: true,
            },
            { type: "text", text: "The batch is settled.", state: "done" },
          ])));
        }
        server.serverMessage(succeededTerminal(turnId, turnId));

        const result = await waitForResult(run);
        expect(result).toMatchObject({ kind: "completed" });
        const persisted = harness.persistAssistant.mock.calls.at(-1)?.[0];
        const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0];
        const reconciledAssistant = reconciled?.find((message) =>
          message.message_id === assistantId);
        const persistedTool = persisted?.tool_calls?.find((tool) => tool.id === callId);
        const reconciledTool = reconciledAssistant?.tool_calls?.find((tool) =>
          tool.id === callId);

        expect(persistedTool).toMatchObject({
          id: callId,
          messageId: assistantId,
          state: outcome.expectedToolState,
          request: {
            id: callId,
            type: "function",
            function: {
              name: "multi_edit",
              arguments: expect.any(String),
            },
          },
          result: outcome.expectedResult,
        });
        expect(JSON.parse(persistedTool!.request.function.arguments)).toEqual(input);
        expect(persistedTool).not.toHaveProperty("executedOn");
        expect(reconciledTool).toMatchObject({
          id: callId,
          messageId: assistantId,
          state: outcome.expectedToolState,
          result: outcome.expectedResult,
        });
        expect(persisted?.messageParts?.find((part) =>
          part.type === "tool_call" && part.data.id === callId)?.data.result)
          .toEqual(outcome.expectedResult);
        expect(reconciledAssistant?.messageParts?.find((part) =>
          part.type === "tool_call" && part.data.id === callId)?.data.result)
          .toEqual(outcome.expectedResult);
        expect(JSON.stringify({ persisted, reconciledAssistant }))
          .not.toContain(privateFailure);
        expect(JSON.stringify({ persisted, reconciledAssistant }))
          .not.toContain("staleServerPreliminaryResult");

        const reloaded = reloadSavedMessage(persisted!);
        const reloadedTool = reloaded.tool_calls?.find((tool) => tool.id === callId);
        expect(reloadedTool?.result).toEqual(outcome.expectedResult);
        const projected = projectReloadedTool(reloadedTool!);
        expect(projected).toMatchObject({
          callId,
          name: "multi_edit",
          location: "vault",
          state: outcome.expectedProjectedState,
          output: { data: outcome.expectedResult.data },
        });
        expect(presentAgentTool(projected)).toMatchObject({
          displayState: outcome.expectedDisplayState,
          icon: outcome.expectedIcon,
          summary: outcome.expectedSummary,
        });
      }
    },
  );

  it("keeps structured error arrays private without losing their safe shape", async () => {
    const privateFailure = "/Users/private/SecretVault open failure sentinel";
    const expectedResult: ToolCallResult = {
      success: false,
      data: {
        opened: ["Visible.md"],
        errors: ["The vault action failed."],
        nested: {
          messages: ["The vault action failed."],
          paths: ["Visible.md"],
        },
      },
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "The vault action failed.",
      },
    };
    const harness = trackedHarness({
      executeLocalTool: async () => ({
        success: false,
        data: {
          opened: ["Visible.md"],
          errors: [privateFailure],
          nested: {
            messages: [`${privateFailure} nested`],
            paths: ["Visible.md"],
          },
        },
        error: { code: "TOOL_OPERATION_FAILED", message: privateFailure },
      }),
    });
    const server = await harness.open([]);
    const turnId = "user_structured_error_array_privacy";
    const assistantId = "assistant_structured_error_array_privacy";
    const callId = "call_structured_error_array_privacy";
    const input = { files: [{ path: "Visible.md" }, { path: "Private.md" }] };
    const request = clientToolRequest(callId, "open", input);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Open the visible note"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId, "waiting_for_client")));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      request,
      {
        type: "tool-open",
        toolCallId: callId,
        state: "input-available",
        input,
      },
    ])));
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    const outbound = harness.commands(server).find((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId);
    expect(outbound).toMatchObject({ output: expectedResult });
    const liveTool = harness.agent.getSnapshot().parts.find(
      (part): part is AgentToolPart => part.kind === "tool" && part.callId === callId,
    );
    expect(liveTool?.output?.data).toEqual(expectedResult.data);
    expect(JSON.stringify({ outbound, liveTool })).not.toContain(privateFailure);

    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    const persisted = harness.persistAssistant.mock.calls.at(-1)?.[0];
    const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0];
    expect(persisted?.tool_calls?.[0]?.result).toEqual(expectedResult);
    expect(reconciled?.find((message) => message.message_id === assistantId)
      ?.tool_calls?.[0]?.result).toEqual(expectedResult);
    expect(JSON.stringify({ persisted, reconciled })).not.toContain(privateFailure);
  });

  it("never replaces a final server-owned outcome with a same-ID local result", async () => {
    const harness = trackedHarness({
      executeLocalTool: async () => ({
        success: true,
        data: { authority: "locally-settled-result" },
      }),
    });
    const server = await harness.open([]);
    const turnId = "user_server_outcome_remains_authoritative";
    const assistantId = "assistant_server_outcome_remains_authoritative";
    const callId = "call_server_outcome_remains_authoritative";
    const input = { paths: ["Authority.md"] };
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read the authority note"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(runState(active(1, turnId, turnId, "waiting_for_client")));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "read", input),
      {
        type: "tool-read",
        toolCallId: callId,
        state: "input-available",
        input,
      },
    ])));
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    // Removing the explicit client-tool request makes this replacement a
    // server-owned action. Its final wire result must win even though a local
    // result with the same call ID remains in the active-run cache.
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      {
        type: "tool-read",
        toolCallId: callId,
        state: "output-available",
        input,
        output: {
          success: true,
          data: { authority: "final-server-owned-result" },
        },
      },
      { type: "text", text: "The authoritative result is settled.", state: "done" },
    ])));
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });

    const persisted = harness.persistAssistant.mock.calls.at(-1)?.[0];
    const persistedTool = persisted?.tool_calls?.find((tool) => tool.id === callId);
    expect(persistedTool).toMatchObject({
      id: callId,
      executedOn: "server",
      state: "completed",
      result: {
        success: true,
        data: { authority: "final-server-owned-result" },
      },
    });
    expect(JSON.stringify(persistedTool)).not.toContain("locally-settled-result");
    const reconciled = harness.reconcileHistory.mock.calls.at(-1)?.[0];
    expect(reconciled?.find((message) => message.message_id === assistantId)
      ?.tool_calls?.[0]).toMatchObject({
      executedOn: "server",
      result: {
        success: true,
        data: { authority: "final-server-owned-result" },
      },
    });
  });

  it.each([
    {
      outcome: "mixed",
      appliedFiles: 1,
      results: [
        { path: "Notes/Changed.md", success: true, appliedCount: 1 },
        {
          path: "Notes/Failed.md",
          success: false,
          appliedCount: 0,
          error: "/Users/private/SecretVault conflict sentinel",
        },
      ],
      resultCode: "TOOL_PARTIAL_FAILURE",
      expectedDisplayState: "partial",
      expectedIcon: "x",
      expectedSummary: "1 completed, 1 failed",
      expectedFailureCopy: "Some requested items failed; successful items were kept.",
    },
    {
      outcome: "all-failed",
      appliedFiles: 0,
      results: [
        {
          path: "Notes/First failed.md",
          success: false,
          appliedCount: 0,
          error: "/Users/private/SecretVault first failure sentinel",
        },
        {
          path: "Notes/Second failed.md",
          success: false,
          appliedCount: 0,
          error: "/Users/private/SecretVault second failure sentinel",
        },
      ],
      resultCode: "TOOL_OPERATION_FAILED",
      expectedDisplayState: "failed",
      expectedIcon: "x",
      expectedSummary: "0 completed, 2 failed",
      expectedFailureCopy: "This vault action could not be completed.",
    },
  ])(
    "presents a sanitized $outcome mutation batch honestly without failing the run",
    async ({
      outcome,
      appliedFiles,
      results,
      resultCode,
      expectedDisplayState,
      expectedIcon,
      expectedSummary,
      expectedFailureCopy,
    }) => {
      const privateFailure = "/Users/private/SecretVault";
      const input = {
        files: results.map(({ path }) => ({
          path,
          edits: [{ oldText: "before", newText: "after" }],
        })),
      };
      const harness = trackedHarness({
        executeLocalTool: async () => ({
          success: false,
          data: {
            success: false,
            requestedFiles: results.length,
            appliedFiles,
            preflightFailed: appliedFiles === 0,
            results,
          },
          error: {
            code: resultCode,
            message: `${privateFailure} ${outcome} failure sentinel`,
          },
        }),
      });
      const server = await harness.open([]);
      const turnId = `user_sanitized_multi_edit_${outcome}`;
      const callId = `call_sanitized_multi_edit_${outcome}`;
      const assistantId = `assistant_sanitized_multi_edit_${outcome}`;
      const request = clientToolRequest(callId, "multi_edit", input);
      const toolPart = {
        type: "tool-multi_edit",
        toolCallId: callId,
        state: "input-available",
        input,
      } as const;
      const run = harness.agent.start({
        conversationId: CONVERSATION_ID,
        turnId,
        message: userMessage(turnId, "Update both notes, then continue"),
        approvalPolicy: { requireDestructiveApproval: false },
      });
      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "submit"));
      server.serverMessage(runState(active(1, turnId, turnId)));
      server.serverMessage(assistantSnapshot(
        turnId,
        wireAssistant(assistantId, [request, toolPart]),
      ));
      server.serverMessage(runState(active(2, turnId, turnId, "waiting_for_client")));

      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "client_tool_result" && command.tool_call_id === callId));
      const outbound = harness.commands(server).find((command) =>
        command.kind === "client_tool_result" && command.tool_call_id === callId);
      expect(JSON.stringify(outbound)).not.toContain(privateFailure);

      const projectedTool = harness.agent.getSnapshot().parts.find(
        (part): part is AgentToolPart => part.kind === "tool" && part.callId === callId,
      );
      expect(projectedTool).toBeDefined();
      const presentation = presentAgentTool(projectedTool!);
      expect(presentation).toMatchObject({
        displayState: expectedDisplayState,
        icon: expectedIcon,
        summary: expectedSummary,
      });
      expect(presentAgentToolFailure(projectedTool!)).toBe(expectedFailureCopy);
      expect(JSON.stringify({ presentation, error: presentAgentToolFailure(projectedTool!) }))
        .not.toContain(privateFailure);

      server.serverMessage(event("command_ack", {
        request_id: turnId,
        command_kind: "client_tool_result",
        tool_call_id: callId,
        status: "accepted",
      }));
      server.serverMessage(runState(active(3, turnId, turnId)));
      server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
        request,
        toolPart,
        { type: "text", text: "The batch is settled.", state: "done" },
      ])));
      server.serverMessage(succeededTerminal(turnId, turnId));

      await expect(run).resolves.toMatchObject({ kind: "completed" });
      const completed = harness.agent.getSnapshot();
      expect(completed).toMatchObject({
        status: "completed",
        parts: expect.arrayContaining([
          expect.objectContaining({
            kind: "text",
            markdown: "The batch is settled.",
          }),
        ]),
      });
      expect(completed.terminalError).toBeUndefined();
      expect(completed.parts.some((part) => part.kind === "error")).toBe(false);
      const completedTool = completed.parts.find(
        (part): part is AgentToolPart => part.kind === "tool" && part.callId === callId,
      );
      expect(completedTool).toBeDefined();
      expect(presentAgentTool(completedTool!)).toMatchObject({
        displayState: expectedDisplayState,
        icon: expectedIcon,
        summary: expectedSummary,
      });
    },
  );

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


  it.each([
    [
      "returned failure details",
      async () => ({
        success: false as const,
        data: {
          results: [{
            path: "Notes/failure.md",
            success: false,
            error: "/Users/alice/SecretVault private credential sentinel",
          }],
        },
        error: {
          code: "RAW_ADAPTER_FAILURE",
          message: "/Users/alice/SecretVault private credential sentinel",
        },
      }),
    ],
    [
      "thrown failure details",
      async () => {
        throw new Error("/Users/alice/SecretVault private credential sentinel");
      },
    ],
  ])("keeps %s out of the tool-result wire command", async (_case, executeLocalTool) => {
    const harness = trackedHarness({ executeLocalTool });
    const server = await harness.open();
    const turnId = `user_redacted_vault_failure_${_case.replaceAll(" ", "_")}`;
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read the note"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [wireUser(turnId, "Read the note")],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    await tick();
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(
      `assistant_${turnId}`,
      [
        clientToolRequest(`call_${turnId}`, "read", { paths: ["Notes"] }),
        {
          type: "tool-read",
          toolCallId: `call_${turnId}`,
          state: "input-available",
          input: { paths: ["Notes"] },
        },
      ],
    )));

    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"));
    const command = harness.commands(server).find((candidate) =>
      candidate.kind === "client_tool_result");
    expect(JSON.stringify(command)).not.toMatch(
      /\/Users\/alice\/SecretVault|private credential sentinel|RAW_ADAPTER_FAILURE/,
    );
    expect(JSON.stringify(command)).toContain("The vault action failed.");

    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("recovers a terminal snapshot when a healthy-looking turn stream dies open", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);

    const turnId = "user_stalled_run";
    const user = wireUser(turnId, "Do a long job");
    const assistant = wireAssistant("assistant_stalled_run", [
      { type: "text", text: "The durable response completed.", state: "done" },
      {
        type: "data-systemsculpt-run-terminal",
        data: {
          version: 1,
          run_id: RUN_ID,
          root_message_id: turnId,
          outcome: "succeeded",
          code: "completed",
        },
      },
    ]);
    const initialSnapshotReads = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Do a long job"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot([user], active(1, turnId, turnId)));
    await tick();
    await waitFor(() => harness.agent.getSnapshot().statusLabel === "Thinking");
    server.snapshotMessages = [user, assistant];
    server.snapshotRunState = idle(2);

    // The turn response never closes and never publishes another byte. The
    // watchdog must replace it with a fresh authoritative snapshot instead of
    // waiting forever for fetch to notice the dead upstream.
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "run_stalled" && record.requestId === turnId));
    await expect(run).resolves.toMatchObject({
      kind: "completed",
      message: expect.objectContaining({
        message_id: assistant.id,
        content: "The durable response completed.",
      }),
    });
    const snapshotReads = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;
    expect(snapshotReads).toBeGreaterThan(initialSnapshotReads);
    expect(harness.commands(server).filter((command) =>
      command.kind === "submit" && command.request_id === turnId)).toHaveLength(1);
    expect(harness.reportError).toHaveBeenCalled();
    expect(harness.onLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ code: "run_stalled" }),
    );
    expect(harness.onLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "run_finished_failed",
      requestId: turnId,
    }));
    expect(harness.agent.getSnapshot().terminalError).toBeUndefined();
  });

  it("cancels a scheduled stall reconnect across a terminal and the next run", async () => {
    const harness = trackedHarness({
      runStallGraceMs: 20,
      resynchronizationDelayMs: () => 30,
    });
    const server = await harness.open([]);
    const firstTurnId = "user_stall_timer_first";
    const firstUser = wireUser(firstTurnId, "Finish before recovery polls");
    const firstRun = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId: firstTurnId,
      message: userMessage(firstTurnId, "Finish before recovery polls"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit" && command.request_id === firstTurnId));
    server.serverMessage(sessionSnapshot(
      [firstUser],
      active(1, firstTurnId, firstTurnId),
    ));
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "run_stalled" && record.requestId === firstTurnId));

    // The terminal arrives on the still-live response before the delayed
    // recovery poll. Completing the run must remove that scheduled reconnect.
    server.serverMessage(succeededTerminal(firstTurnId, firstTurnId));
    await expect(firstRun).resolves.toMatchObject({ kind: "completed" });
    server.snapshotMessages = [
      firstUser,
      wireAssistant("assistant_stall_timer_first", [{
        type: "data-systemsculpt-run-terminal",
        data: {
          version: 1,
          run_id: RUN_ID,
          root_message_id: firstTurnId,
          outcome: "succeeded",
          code: "completed",
        },
      }]),
    ];
    server.snapshotRunState = idle(2);

    const secondTurnId = "user_stall_timer_second";
    const secondRun = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId: secondTurnId,
      message: userMessage(secondTurnId, "Start the next response cleanly"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit" && command.request_id === secondTurnId));
    server.serverMessage(runState(active(3, secondTurnId, secondTurnId)));
    server.serverMessage(succeededTerminal(secondTurnId, secondTurnId));
    await expect(secondRun).resolves.toMatchObject({ kind: "completed" });
    const readsAfterSecondRun = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length)
      .toBe(readsAfterSecondRun);
    expect(harness.commands(server).filter((command) =>
      command.kind === "submit" && command.request_id === firstTurnId)).toHaveLength(1);
    expect(harness.commands(server).filter((command) =>
      command.kind === "submit" && command.request_id === secondTurnId)).toHaveLength(1);
  });

  it("retries an unchanged stalled snapshot, then cancels backoff on same-cursor tool progress", async () => {
    const resynchronizationDelayMs = jest.fn((attempt: number) =>
      attempt === 0 ? 0 : 10);
    const harness = trackedHarness({
      runStallGraceMs: 50,
      resynchronizationDelayMs,
    });
    const server = await harness.open([]);

    const turnId = "user_recovering_run";
    const user = wireUser(turnId, "Recover from a quiet patch");
    const assistantId = "assistant_recovering_run";
    const toolCallId = "call_recovering_server_tool";
    const streamingAssistant = wireAssistant(assistantId, [{
      type: "tool-web_search",
      toolCallId,
      state: "input-streaming",
      input: { query: "quiet patch" },
    }]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Recover from a quiet patch"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user, streamingAssistant],
      active(1, turnId, turnId),
    ));
    server.snapshotMessages = [user, streamingAssistant];
    server.snapshotRunState = active(1, turnId, turnId);
    await tick();
    const initialSnapshotReads = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;

    await waitFor(() => resynchronizationDelayMs.mock.calls.some(([attempt]) =>
      attempt === 1));
    expect(harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length)
      .toBe(initialSnapshotReads + 1);

    server.snapshotMessages = [
      user,
      wireAssistant(assistantId, [{
        type: "tool-web_search",
        toolCallId,
        state: "output-available",
        input: { query: "quiet patch" },
        output: { success: true, data: { matches: 1 } },
      }]),
    ];
    // Assistant replacement acceptance does not require a run-cursor change.
    // The semantic tool transition itself is authoritative progress.
    server.snapshotRunState = active(1, turnId, turnId);
    await waitFor(() => harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length
      === initialSnapshotReads + 2);
    await waitFor(() =>
      harness.agent.getSnapshot().statusLabel !== "Still waiting on the server");
    const readsAfterProgress = harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length)
      .toBe(readsAfterProgress);
    expect(harness.commands(server).filter((command) =>
      command.kind === "submit" && command.request_id === turnId)).toHaveLength(1);

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.request.mock.calls.filter(([request]) =>
      String(request.url).includes("/get-messages")).length)
      .toBe(readsAfterProgress);
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

  it("keeps server-wait ownership after an approval ack and unrelated progress", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);
    const turnId = "user_acknowledged_approval_stall";
    const assistantId = "assistant_acknowledged_approval_stall";
    const callId = "call_acknowledged_approval_stall";
    const user = wireUser(turnId, "Approve once and wait for the server");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Approve once and wait for the server"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, requested));
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
    await waitFor(() => (harness.agent as unknown as {
      pendingApprovalDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingApprovalDeliveries.get(callId)?.acknowledged === true);

    // A separate assistant detail can advance without changing the requested
    // approval. The accepted delivery still means the server owns the wait.
    const progressed = wireAssistant(assistantId, [
      { type: "reasoning", text: "Approval received", state: "done" },
      ...writeApprovalParts(callId, "approval-requested"),
    ]);
    server.snapshotMessages = [user, progressed];
    server.snapshotRunState = active(1, turnId, turnId, "waiting_for_client");
    server.serverMessage(assistantSnapshot(turnId, progressed));

    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "run_stalled" && record.requestId === turnId));
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId)).toHaveLength(1);

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("recovers when a sent local mutation result stream dies without repeating the mutation", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);
    const turnId = "user_result_stream_stalled";
    const assistantId = "assistant_result_stream_stalled";
    const callId = "call_result_stream_stalled";
    const input = { path: "Result recovery.md", content: "Apply exactly once" };
    const request = clientToolRequest(callId, "write", input);
    const tool = {
      type: "tool-write",
      toolCallId: callId,
      state: "input-available",
      input,
    } as const;
    const user = wireUser(turnId, "Write this once, then finish");
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Write this once, then finish"),
      approvalPolicy: { requireDestructiveApproval: false },
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit" && command.request_id === turnId));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, [request, tool]),
    ));
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));
    expect(harness.executeLocalTool).toHaveBeenCalledTimes(1);

    server.snapshotMessages = [
      user,
      wireAssistant(assistantId, [
        request,
        tool,
        { type: "text", text: "The one mutation is durable.", state: "done" },
        {
          type: "data-systemsculpt-run-terminal",
          data: {
            version: 1,
            run_id: RUN_ID,
            root_message_id: turnId,
            outcome: "succeeded",
            code: "completed",
          },
        },
      ]),
    ];
    server.snapshotRunState = idle(2);

    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "run_stalled" && record.requestId === turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool).toHaveBeenCalledTimes(1);
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId))
      .toHaveLength(1);
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId))
      .toHaveLength(0);
    expect(harness.agent.getSnapshot().terminalError).toBeUndefined();
  });

  it("recovers a sent approval stream without presenting or submitting approval twice", async () => {
    const harness = trackedHarness({ runStallGraceMs: 25 });
    const server = await harness.open([]);
    const turnId = "user_approval_stream_stalled";
    const assistantId = "assistant_approval_stream_stalled";
    const callId = "call_approval_stream_stalled";
    const user = wireUser(turnId, "Approve this once, then write it");
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Approve this once, then write it"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit" && command.request_id === turnId));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-requested")),
    ));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId
      && part.state === "approval-required" && typeof part.approvalId === "string"));
    const approval = harness.agent.getSnapshot().parts.find((part) =>
      part.kind === "tool" && part.callId === callId);
    expect(approval?.kind).toBe("tool");
    expect(harness.agent.respondToApproval(
      approval?.kind === "tool" ? approval.approvalId! : "",
      true,
    )).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId));

    server.snapshotMessages = [
      user,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-responded", true)),
    ];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "run_stalled" && record.requestId === turnId));
    await waitFor(() => harness.executeLocalTool.mock.calls.length === 1);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool).toHaveBeenCalledTimes(1);
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId))
      .toHaveLength(1);
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "approval_presented" && record.toolCallId === callId))
      .toHaveLength(1);
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "approval_submitted_approved_manual" && record.toolCallId === callId))
      .toHaveLength(1);
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
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: "call_read",
      status: "accepted",
    }));
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
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: "call_write",
      status: "accepted",
    }));
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
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: "call_write",
      status: "accepted",
    }));
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
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: "call_denied",
      status: "accepted",
    }));

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
    harness.agent.recordClientToolRenderMilestone(
      "local_tool_terminal_dom_committed",
      turnId,
      "call_write",
      1,
    );
    harness.agent.recordClientToolRenderMilestone(
      "continuation_content_dom_committed",
      turnId,
      "call_write",
      2,
    );
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
    const lifecycle = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.requestId === turnId);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "local_tool_terminal_dom_committed",
        toolExecutionOrdinal: 2,
      }),
      expect.objectContaining({
        code: "continuation_content_dom_committed",
        toolExecutionOrdinal: 2,
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
      }),
    ]));
    expect(lifecycle.filter((record) => [
      "local_tool_terminal_dom_committed",
      "continuation_content_dom_committed",
    ].includes(String(record.code))).every((record) =>
      !("toolCallId" in record))).toBe(true);
    const toolLifecycle = lifecycle.filter((record) =>
      typeof record.toolCallId === "string"
      && [
        "approval_presented",
        "approval_submitted_approved_manual",
        "approval_submitted_denied",
        "approval_acknowledged_approved",
        "approval_acknowledged_denied",
        "local_tool_started",
        "local_tool_completed_succeeded",
        "tool_result_sent_succeeded",
      ].includes(String(record.code)));
    expect(toolLifecycle.length).toBeGreaterThan(0);
    expect(toolLifecycle.every((record) =>
      typeof record.clientMonotonicOffsetMs === "number"
      && record.clientClockDomain === "client_turn_monotonic")).toBe(true);
    // Local/UI milestones never borrow a trace from whichever overlapping
    // stream spoke last. Exact ACKs now carry their own command segment.
    expect(toolLifecycle.filter((record) =>
      !String(record.code).startsWith("approval_acknowledged_")).every((record) =>
      !("latencyTraceId" in record)
      && !("commandSegmentOrdinal" in record))).toBe(true);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tool_result_acknowledged_succeeded",
        toolCallId: "call_read",
        toolExecutionOrdinal: 1,
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
      }),
      expect.objectContaining({
        code: "tool_result_acknowledged_succeeded",
        toolCallId: "call_write",
        toolExecutionOrdinal: 2,
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
      }),
    ]));
    const toolCommandSegments = lifecycle.filter((record) =>
      record.code === "command_segment_dispatch_started"
      && typeof record.toolCallId === "string");
    expect(toolCommandSegments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolCallId: "call_read",
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
      }),
      expect.objectContaining({
        toolCallId: "call_write",
        commandKind: "client_tool_approval",
        commandSegmentOrdinal: expect.any(Number),
      }),
      expect.objectContaining({
        toolCallId: "call_write",
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
      }),
    ]));
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
      expect(pendingBeforeReconnect?.decision).toMatchObject({
        requestId,
        callId,
        approved,
        approvalId: `approval_${callId}`,
        source: "manual",
        identity: {
          toolName: "write",
          canonicalInput: "{\"content\":\"Approved once\",\"path\":\"Recovered approval.md\"}",
        },
      });
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

      server.serverMessage(event("command_ack", {
        request_id: requestId,
        command_kind: "client_tool_approval",
        tool_call_id: callId,
        status: "accepted",
      }));
      await tick();
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
    await waitFor(() => (harness.agent as unknown as {
      pendingApprovalDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingApprovalDeliveries.get(callId)?.acknowledged === true);
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
    // The ACK is retained with the in-flight stream, so an unrelated snapshot
    // must not provoke a resend in the same connection epoch.
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

  it("replays an acknowledged tool result after its continuation stream fails", async () => {
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
    server.serverMessage(assistantSnapshot(turnId, pendingAssistant));

    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 1);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await tick();
    await waitFor(() => (harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingDeliveries.get(callId)?.acknowledged === true);
    expect((harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, unknown>;
    }).pendingDeliveries.has(callId)).toBe(true);
    const beforeStreamFailure = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.requestId === turnId);
    expect(beforeStreamFailure).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tool_result_acknowledged_succeeded",
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
        toolExecutionOrdinal: 1,
      }),
    ]));
    expect(beforeStreamFailure.some((record) => String(record.code).startsWith(
      "tool_result_command_stream_",
    ))).toBe(false);

    server.failTurn(new Error(
      "The acknowledged continuation stream failed before a clean close.",
    ));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 2);

    const deliveries = harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "tool_result_command_stream_failed",
      commandKind: "client_tool_result",
      commandSegmentOrdinal: expect.any(Number),
      failureCode: "command_stream_failed",
      toolExecutionOrdinal: 1,
    }));

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => (harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingDeliveries.get(callId)?.acknowledged === true);
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "tool_result_acknowledged_succeeded"
      && record.toolCallId === callId)).toHaveLength(1);

    server.serverMessage(assistantSnapshot(
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
    server.serverMessage(succeededTerminal(turnId, turnId));
    await tick();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "tool_result_command_stream_completed_output_available"
      && record.toolExecutionOrdinal === 1));
  });

  it("replays an acknowledged tool result after clean EOF without authoritative projection", async () => {
    const resynchronizationDelayMs = jest.fn(() => 10);
    const harness = trackedHarness({ resynchronizationDelayMs });
    const server = await harness.open();
    const turnId = "user_tool_result_ack_clean_eof_pending";
    const assistantId = "assistant_tool_result_ack_clean_eof_pending";
    const callId = "call_tool_result_ack_clean_eof_pending";
    const input = { paths: ["ACK pending.md"] };
    const user = wireUser(turnId, "Read this note once and recover after ACK-only EOF");
    const request = clientToolRequest(callId, "read", input);
    const pendingAssistant = wireAssistant(assistantId, [
      request,
      { type: "tool-read", toolCallId: callId, state: "input-available", input },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read this note once and recover after ACK-only EOF"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.snapshotMessages = [user, pendingAssistant];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.serverMessage(assistantSnapshot(turnId, pendingAssistant));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 1);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => (harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingDeliveries.get(callId)?.acknowledged === true);
    server.endTurn();

    await waitFor(() => resynchronizationDelayMs.mock.calls.some(([attempt]) =>
      attempt === 0));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 2);
    const deliveries = harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "tool_result_acknowledged_succeeded"
      && record.toolCallId === callId)).toHaveLength(1);

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("replays an acknowledged output error after clean EOF without authoritative projection", async () => {
    const resynchronizationDelayMs = jest.fn(() => 10);
    const harness = trackedHarness({
      resynchronizationDelayMs,
      executeLocalTool: async () => {
        throw new Error("Exact output-error fixture");
      },
    });
    const server = await harness.open();
    const turnId = "user_tool_error_ack_clean_eof_pending";
    const assistantId = "assistant_tool_error_ack_clean_eof_pending";
    const callId = "call_tool_error_ack_clean_eof_pending";
    const input = { paths: ["ACK error.md"] };
    const user = wireUser(turnId, "Fail this read once and recover after ACK-only EOF");
    const pendingAssistant = wireAssistant(assistantId, [
      clientToolRequest(callId, "read", input),
      { type: "tool-read", toolCallId: callId, state: "input-available", input },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Fail this read once and recover after ACK-only EOF"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.snapshotMessages = [user, pendingAssistant];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.serverMessage(assistantSnapshot(turnId, pendingAssistant));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId
      && command.state === "output-error").length === 1);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => (harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingDeliveries.get(callId)?.acknowledged === true);
    server.endTurn();

    await waitFor(() => resynchronizationDelayMs.mock.calls.some(([attempt]) =>
      attempt === 0));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId
      && command.state === "output-error").length === 2);
    const deliveries = harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "tool_result_acknowledged_failed"
      && record.toolCallId === callId)).toHaveLength(1);

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it.each([
    {
      scenario: "retains and replays an acknowledged result after mismatched payload authority",
      localOutcome: "output-available",
      authority: "mismatched",
      shouldReplay: true,
    },
    {
      scenario: "retires an acknowledged result after matching payload authority",
      localOutcome: "output-available",
      authority: "matching",
      shouldReplay: false,
    },
    {
      scenario: "retains and replays an acknowledged error after mismatched error authority",
      localOutcome: "output-error",
      authority: "mismatched",
      shouldReplay: true,
    },
    {
      scenario: "retires an acknowledged error after matching error authority",
      localOutcome: "output-error",
      authority: "matching",
      shouldReplay: false,
    },
  ] as const)("$scenario", async ({ localOutcome, authority, shouldReplay }) => {
    const resynchronizationDelayMs = jest.fn(() => 10);
    const harness = trackedHarness({
      resynchronizationDelayMs,
      ...(localOutcome === "output-error"
        ? {
            executeLocalTool: async () => {
              throw new Error("Exact local output-error fixture");
            },
          }
        : {}),
    });
    const server = await harness.open();
    const kind = localOutcome === "output-available" ? "payload" : "error";
    const suffix = `${kind}_${authority}`;
    const turnId = `user_tool_authority_${suffix}`;
    const assistantId = `assistant_tool_authority_${suffix}`;
    const callId = `call_tool_authority_${suffix}`;
    const input = { paths: [`Authority ${suffix}.md`] };
    const user = wireUser(turnId, `Verify ${suffix} authority once`);
    const request = clientToolRequest(callId, "read", input);
    const pendingAssistant = wireAssistant(assistantId, [
      request,
      { type: "tool-read", toolCallId: callId, state: "input-available", input },
    ]);
    const authoritativeAssistant = wireAssistant(assistantId, [
      request,
      localOutcome === "output-available"
        ? {
            type: "tool-read",
            toolCallId: callId,
            state: "output-available",
            input,
            output: {
              success: true,
              data: { ok: authority === "matching" },
            },
          }
        : {
            type: "tool-read",
            toolCallId: callId,
            state: "output-error",
            input,
            errorText: authority === "matching"
              ? "The vault action failed."
              : "A different sanitized vault failure.",
          },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, `Verify ${suffix} authority once`),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.snapshotMessages = [user, pendingAssistant];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.serverMessage(assistantSnapshot(turnId, pendingAssistant));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 1);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => (harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
    }).pendingDeliveries.get(callId)?.acknowledged === true);
    server.snapshotMessages = [user, authoritativeAssistant];
    server.serverMessage(assistantSnapshot(turnId, authoritativeAssistant));
    server.endTurn();

    const expectedDeliveryCount = shouldReplay ? 2 : 1;
    if (shouldReplay) {
      await waitFor(() => resynchronizationDelayMs.mock.calls.some(([attempt]) =>
        attempt === 0));
      await waitFor(() => harness.commands(server).filter((command) =>
        command.kind === "client_tool_result"
        && command.tool_call_id === callId).length === expectedDeliveryCount);
      expect((harness.agent as unknown as {
        pendingDeliveries: ReadonlyMap<string, { acknowledged: boolean }>;
      }).pendingDeliveries.get(callId)?.acknowledged).toBe(false);
    } else {
      await waitFor(() => !(harness.agent as unknown as {
        pendingDeliveries: ReadonlyMap<string, unknown>;
      }).pendingDeliveries.has(callId));
      const transport = (harness.agent as unknown as {
        transport: { forceReconnect(): Promise<void> } | null;
      }).transport;
      if (!transport) throw new Error("Expected an active test transport.");
      await transport.forceReconnect();
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
    const deliveries = harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId);
    expect(deliveries).toHaveLength(expectedDeliveryCount);
    if (shouldReplay) expect(deliveries[1]).toEqual(deliveries[0]);
    expect(resynchronizationDelayMs.mock.calls.map(([attempt]) => attempt))
      .toEqual(shouldReplay ? [0] : []);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    const acknowledgementCode = localOutcome === "output-available"
      ? "tool_result_acknowledged_succeeded"
      : "tool_result_acknowledged_failed";
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === acknowledgementCode
      && record.toolCallId === callId)).toHaveLength(1);

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("reconnects and replays an unacknowledged tool result after clean EOF", async () => {
    const resynchronizationDelayMs = jest.fn(() => 10);
    const harness = trackedHarness({ resynchronizationDelayMs });
    const server = await harness.open();
    const turnId = "user_tool_result_clean_eof_without_ack";
    const assistantId = "assistant_tool_result_clean_eof_without_ack";
    const callId = "call_tool_result_clean_eof_without_ack";
    const input = { paths: ["Clean EOF.md"] };
    const user = wireUser(turnId, "Read once and recover from an ownerless clean EOF");
    const request = clientToolRequest(callId, "read", input);
    const pending = wireAssistant(assistantId, [
      request,
      { type: "tool-read", toolCallId: callId, state: "input-available", input },
    ]);
    const settled = wireAssistant(assistantId, [
      request,
      {
        type: "tool-read",
        toolCallId: callId,
        state: "output-available",
        input,
        output: { success: true, data: { ok: true } },
      },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read once and recover from an ownerless clean EOF"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.snapshotMessages = [user, pending];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.serverMessage(assistantSnapshot(turnId, pending));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 1);

    server.endTurn();
    await waitFor(() => resynchronizationDelayMs.mock.calls.some(([attempt]) =>
      attempt === 0));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId).length === 2);

    const deliveries = harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect((harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, unknown>;
    }).pendingDeliveries.has(callId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toHaveLength(2);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    server.serverMessage(runState(active(3, turnId, turnId, "running")));
    server.serverMessage(assistantSnapshot(turnId, settled));
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    const toolSegmentLifecycle = harness.onLifecycle.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.requestId === turnId);
    expect(toolSegmentLifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "response_first_assistant_snapshot_projected",
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
        toolExecutionOrdinal: 1,
      }),
      expect.objectContaining({
        code: "response_result_received_succeeded",
        commandKind: "client_tool_result",
        commandSegmentOrdinal: expect.any(Number),
        toolExecutionOrdinal: 1,
      }),
    ]));
  });

  it("reconnects and replays an unacknowledged denial after clean EOF", async () => {
    const resynchronizationDelayMs = jest.fn(() => 10);
    const harness = trackedHarness({ resynchronizationDelayMs });
    const server = await harness.open();
    const turnId = "user_denial_clean_eof_without_ack";
    const assistantId = "assistant_denial_clean_eof_without_ack";
    const callId = "call_denial_clean_eof_without_ack";
    const user = wireUser(turnId, "Deny once and recover from an ownerless clean EOF");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const denied = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "output-denied", false),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Deny once and recover from an ownerless clean EOF"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, requested));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required"));
    expect(harness.agent.respondToApproval(`approval_${callId}`, false)).toBe(true);
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false).length === 1);

    server.snapshotMessages = [user, denied];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.endTurn();
    await waitFor(() => resynchronizationDelayMs.mock.calls.some(([attempt]) =>
      attempt === 0));
    await waitFor(() => harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false).length === 2);

    const denials = harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false);
    expect(denials[1]).toEqual(denials[0]);
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false)).toHaveLength(2);

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    server.serverMessage(runState(active(3, turnId, turnId, "running")));
    server.serverMessage(assistantSnapshot(turnId, denied));
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
  });

  it("records one delayed tool-result ACK after idle terminal authority wins", async () => {
    const persistence = deferred<void>();
    const harness = trackedHarness({
      persistAssistant: async () => await persistence.promise,
    });
    const server = await harness.open();
    const turnId = "user_tool_result_ack_after_terminal";
    const assistantId = "assistant_tool_result_ack_after_terminal";
    const callId = "call_tool_result_ack_after_terminal";
    const input = { paths: ["Terminal first.md"] };
    const user = wireUser(turnId, "Read once even when terminal arrives first");
    const request = clientToolRequest(callId, "read", input);
    const pending = wireAssistant(assistantId, [
      request,
      { type: "tool-read", toolCallId: callId, state: "input-available", input },
    ]);
    const settled = wireAssistant(assistantId, [
      request,
      {
        type: "tool-read",
        toolCallId: callId,
        state: "output-available",
        input,
        output: { success: true, data: { ok: true } },
      },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read once even when terminal arrives first"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, pending));
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId));

    server.serverMessage(assistantSnapshot(turnId, settled));
    server.serverMessage(runState(idle(2)));
    server.parallelServerMessage(succeededTerminal(turnId, turnId));
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "response_result_received_succeeded"
      && record.requestId === turnId));
    expect((harness.agent as unknown as {
      session: { current: { runState: { state: string } } } | null;
    }).session?.current.runState.state).toBe("idle");
    expect((harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, { inFlight: boolean }>;
    }).pendingDeliveries.get(callId)?.inFlight).toBe(true);

    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      server.serverMessage(event("command_ack", {
        request_id: turnId,
        command_kind: "client_tool_result",
        tool_call_id: callId,
        status: "accepted",
      }));
    }
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "tool_result_acknowledged_succeeded"
      && record.toolCallId === callId));
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "tool_result_acknowledged_succeeded"
      && record.toolCallId === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    server.endTurn();
    await waitFor(() => harness.persistAssistant.mock.calls.length === 1);
    persistence.resolve();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it("records one delayed denial ACK after idle terminal authority without reprompting", async () => {
    const persistence = deferred<void>();
    const harness = trackedHarness({
      persistAssistant: async () => await persistence.promise,
    });
    const server = await harness.open();
    const turnId = "user_denial_ack_after_terminal";
    const assistantId = "assistant_denial_ack_after_terminal";
    const callId = "call_denial_ack_after_terminal";
    const user = wireUser(turnId, "Deny once even when terminal arrives first");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const denied = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "output-denied", false),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Deny once even when terminal arrives first"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, requested));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required"));
    expect(harness.agent.respondToApproval(`approval_${callId}`, false)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false));

    server.serverMessage(assistantSnapshot(turnId, denied));
    server.serverMessage(runState(idle(2)));
    server.parallelServerMessage(succeededTerminal(turnId, turnId));
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "response_result_received_succeeded"
      && record.requestId === turnId));
    expect((harness.agent as unknown as {
      session: { current: { runState: { state: string } } } | null;
    }).session?.current.runState.state).toBe("idle");
    expect((harness.agent as unknown as {
      pendingApprovalDeliveries: ReadonlyMap<string, { inFlight: boolean }>;
    }).pendingApprovalDeliveries.get(callId)?.inFlight).toBe(true);

    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      server.serverMessage(event("command_ack", {
        request_id: turnId,
        command_kind: "client_tool_approval",
        tool_call_id: callId,
        status: "accepted",
      }));
    }
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "approval_acknowledged_denied"
      && record.toolCallId === callId));
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "approval_acknowledged_denied"
      && record.toolCallId === callId)).toHaveLength(1);
    expect(harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required")).toBe(false);
    expect(harness.executeLocalTool).not.toHaveBeenCalled();

    server.endTurn();
    await waitFor(() => harness.persistAssistant.mock.calls.length === 1);
    persistence.resolve();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId)).toHaveLength(1);
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
  });

  it("does not replay an acknowledged exact tool result when recovery supersedes its stream", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_tool_result_post_ack_recovery";
    const assistantId = "assistant_tool_result_post_ack_recovery";
    const callId = "call_tool_result_post_ack_recovery";
    const input = { paths: ["Post ACK.md"] };
    const user = wireUser(turnId, "Read once and recover after the ACK");
    const request = clientToolRequest(callId, "read", input);
    const pending = wireAssistant(assistantId, [
      request,
      { type: "tool-read", toolCallId: callId, state: "input-available", input },
    ]);
    const settled = wireAssistant(assistantId, [
      request,
      {
        type: "tool-read",
        toolCallId: callId,
        state: "output-available",
        input,
        output: { success: true, data: { ok: true } },
      },
    ]);
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Read once and recover after the ACK"),
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, pending));
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId));

    server.snapshotMessages = [user, settled];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    // Durable projection precedes the explicit ACK, matching the real server.
    server.serverMessage(assistantSnapshot(turnId, settled));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "tool_result_acknowledged_succeeded"
      && record.toolCallId === callId));
    expect((harness.agent as unknown as {
      pendingDeliveries: ReadonlyMap<string, unknown>;
    }).pendingDeliveries.has(callId)).toBe(false);
    const transport = (harness.agent as unknown as {
      transport: { forceReconnect(): Promise<void> } | null;
    }).transport;
    if (!transport) throw new Error("Expected an active test transport.");
    await transport.forceReconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_result"
      && command.tool_call_id === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "tool_result_acknowledged_succeeded"
      && record.toolCallId === callId)).toHaveLength(1);
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it.each([
    { scenario: "after its continuation stream fails", supersede: false },
    { scenario: "when recovery supersedes its open stream", supersede: true },
  ])("does not replay an acknowledged exact denial $scenario", async ({ supersede }) => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_denial_post_ack_recovery";
    const assistantId = "assistant_denial_post_ack_recovery";
    const callId = "call_denial_post_ack_recovery";
    const user = wireUser(turnId, "Deny once and recover after the ACK");
    const requested = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "approval-requested"),
    );
    const denied = wireAssistant(
      assistantId,
      writeApprovalParts(callId, "output-denied", false),
    );
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Deny once and recover after the ACK"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, requested));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool"
      && part.callId === callId
      && part.state === "approval-required"));
    expect(harness.agent.respondToApproval(`approval_${callId}`, false)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false));

    server.snapshotMessages = [user, denied];
    server.snapshotRunState = active(2, turnId, turnId, "waiting_for_client");
    server.serverMessage(assistantSnapshot(turnId, denied));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    await waitFor(() => harness.onLifecycle.mock.calls.some(([record]) =>
      record.code === "approval_acknowledged_denied"
      && record.toolCallId === callId));
    expect((harness.agent as unknown as {
      pendingApprovalDeliveries: ReadonlyMap<string, unknown>;
    }).pendingApprovalDeliveries.has(callId)).toBe(false);
    if (supersede) {
      const transport = (harness.agent as unknown as {
        transport: { forceReconnect(): Promise<void> } | null;
      }).transport;
      if (!transport) throw new Error("Expected an active test transport.");
      await transport.forceReconnect();
    } else {
      server.failTurn(new Error("Actor stopped after writing the denial ACK."));
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.commands(server).filter((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === false)).toHaveLength(1);
    expect(harness.executeLocalTool).not.toHaveBeenCalled();

    await harness.agent.detach();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    expect(harness.onLifecycle.mock.calls.filter(([record]) =>
      record.code === "approval_acknowledged_denied"
      && record.toolCallId === callId)).toHaveLength(1);
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
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

  it("binds approval to canonical tool input and executes the exact call once", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_canonical_approval_identity";
    const assistantId = "assistant_canonical_approval_identity";
    const callId = "call_canonical_approval_identity";
    const approvalId = "approval_canonical_identity";
    const user = wireUser(turnId, "Apply the exact approved write once");
    const requestedInput = { path: "Canonical.md", content: "approved" };
    const reorderedInput = { content: "approved", path: "Canonical.md" };
    const parts = (input: Readonly<Record<string, unknown>>, state: string) => [
      clientToolRequest(callId, "write", input),
      {
        type: "tool-write",
        toolCallId: callId,
        state,
        input,
        approval: {
          id: approvalId,
          ...(state === "approval-responded" ? { approved: true } : {}),
        },
      },
    ] as const;
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Apply the exact approved write once"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) => command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, parts(requestedInput, "approval-requested")),
    ));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId && part.state === "approval-required"));

    expect(harness.agent.respondToApproval(approvalId, true)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    const approved = assistantSnapshot(
      turnId,
      wireAssistant(assistantId, parts(reorderedInput, "approval-responded")),
    );
    server.serverMessage(approved);
    server.serverMessage(approved);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    expect(harness.executeLocalTool).toHaveBeenCalledWith(
      expect.objectContaining({ input: reorderedInput }),
      expect.any(AbortSignal),
    );
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "write", reorderedInput),
      {
        type: "tool-write",
        toolCallId: callId,
        state: "output-available",
        input: reorderedInput,
        approval: { id: approvalId, approved: true },
        output: { success: true, data: { path: "Canonical.md" } },
      },
    ])));
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
  });

  it.each(["input", "name"] as const)(
    "does not let a stale decision grant a tool call with changed $change identity",
    async (change) => {
      const harness = trackedHarness();
      const server = await harness.open();
      const turnId = `user_changed_approval_${change}`;
      const assistantId = `assistant_changed_approval_${change}`;
      const callId = `call_changed_approval_${change}`;
      const approvalId = `approval_changed_${change}`;
      const user = wireUser(turnId, "Approve one stable write");
      const original = { path: "Original.md", content: "approved" };
      const changed = change === "input"
        ? { path: "Changed.md", content: "not approved" }
        : original;
      const changedName = change === "name" ? "edit" : "write";
      const run = harness.agent.start({
        conversationId: CONVERSATION_ID,
        turnId,
        message: userMessage(turnId, "Approve one stable write"),
        approvalPolicy: { requireDestructiveApproval: true },
      });
      await waitFor(() => harness.commands(server).some((command) => command.kind === "submit"));
      server.serverMessage(sessionSnapshot(
        [user],
        active(1, turnId, turnId, "waiting_for_client"),
      ));
      server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
        clientToolRequest(callId, "write", original),
        {
          type: "tool-write",
          toolCallId: callId,
          state: "approval-requested",
          input: original,
          approval: { id: approvalId },
        },
      ])));
      await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
        part.kind === "tool" && part.callId === callId));
      expect(harness.agent.respondToApproval(approvalId, true)).toBe(true);
      await waitFor(() => harness.commands(server).some((command) =>
        command.kind === "client_tool_approval" && command.tool_call_id === callId));

      server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
        clientToolRequest(callId, changedName, changed),
        {
          type: `tool-${changedName}`,
          toolCallId: callId,
          state: "approval-responded",
          input: changed,
          approval: { id: approvalId, approved: true },
        },
      ])));

      await expect(run).resolves.toMatchObject({
        kind: "failed",
        error: { code: "client_tool_identity_mismatch", retryable: false },
      });
      expect(harness.executeLocalTool).not.toHaveBeenCalled();
      expect(harness.agent.respondToApproval(approvalId, true)).toBe(false);
    },
  );

  it("fails closed when an approval ID changes", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_changed_approval_id";
    const assistantId = "assistant_changed_approval_id";
    const callId = "call_changed_approval_id";
    const input = { path: "Stable.md", content: "stable" };
    const originalApprovalId = "approval_changed_original";
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Reject a changed approval identity"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) => command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [wireUser(turnId, "Reject a changed approval identity")],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "write", input),
      {
        type: "tool-write",
        toolCallId: callId,
        state: "approval-requested",
        input,
        approval: { id: originalApprovalId },
      },
    ])));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId));
    expect(harness.agent.respondToApproval(originalApprovalId, true)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId));

    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "write", input),
      {
        type: "tool-write",
        toolCallId: callId,
        state: "approval-responded",
        input,
        approval: { id: "approval_changed_replacement", approved: true },
      },
    ])));

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "approval_identity_mismatch", retryable: false },
    });
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.agent.respondToApproval(originalApprovalId, true)).toBe(false);
  });

  it("fails closed when two calls duplicate one approval ID", async () => {
    const harness = trackedHarness();
    const turnId = "user_duplicate_approval_id";
    const firstCallId = "call_duplicate_approval_first";
    const secondCallId = "call_duplicate_approval_second";
    const firstInput = { path: "First.md", content: "first" };
    const secondInput = { path: "Second.md", content: "second" };
    const approvalId = "approval_duplicate_shared";
    harness.server.snapshotMessages = [
      wireUser(turnId, "Reject a duplicate approval identity"),
      wireAssistant("assistant_duplicate_approval_id", [
        clientToolRequest(firstCallId, "write", firstInput),
        {
          type: "tool-write",
          toolCallId: firstCallId,
          state: "approval-requested",
          input: firstInput,
          approval: { id: approvalId },
        },
        clientToolRequest(secondCallId, "write", secondInput),
        {
          type: "tool-write",
          toolCallId: secondCallId,
          state: "approval-requested",
          input: secondInput,
          approval: { id: approvalId },
        },
      ]),
    ];
    harness.server.snapshotRunState = active(1, turnId, turnId, "waiting_for_client");

    await harness.agent.hydrate(CONVERSATION_ID);
    await waitFor(() => harness.agent.getSnapshot().status === "failed");

    expect(harness.reportError).toHaveBeenCalledWith(expect.objectContaining({
      code: "approval_identity_mismatch",
      retryable: false,
    }));
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.agent.respondToApproval(approvalId, true)).toBe(false);
  });

  it("does not accept recovered server approval in Ask Approval mode", async () => {
    const harness = trackedHarness();
    const turnId = "user_recovered_server_approval";
    const callId = "call_recovered_server_approval";
    harness.server.snapshotMessages = [
      wireUser(turnId, "Do not recover remote approval as local approval"),
      wireAssistant(
        "assistant_recovered_server_approval",
        writeApprovalParts(callId, "approval-responded", true),
      ),
    ];
    harness.server.snapshotRunState = active(1, turnId, turnId, "waiting_for_client");

    await harness.agent.hydrate(CONVERSATION_ID);
    await waitFor(() => harness.agent.getSnapshot().status === "failed");

    expect(harness.agent.getSnapshot()).toMatchObject({
      status: "failed",
      terminalError: { code: "approval_identity_mismatch", retryable: false },
    });
    expect(harness.reportError).toHaveBeenCalledWith(expect.objectContaining({
      code: "approval_identity_mismatch",
      retryable: false,
    }));
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.mutationAdapter.write).not.toHaveBeenCalled();
    expect(harness.commands().some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId)).toBe(false);
  });

  it("replays a completed local mutation receipt after recovery without new consent", async () => {
    const harness = trackedHarness();
    const turnId = "user_recovered_completed_receipt";
    const callId = "call_recovered_completed_receipt";
    const input = { path: "Recovered approval.md", content: "Approved once" };
    const result = { success: true, data: { path: input.path } };
    const receiptJournal = new AgentMutationJournal(
      harness.mutationAdapter,
      ".systemsculpt/mutations.json",
      () => 1_000,
    );
    await expect(receiptJournal.claim(
      CONVERSATION_ID,
      callId,
      "write",
      input,
    )).resolves.toEqual({ kind: "execute" });
    await receiptJournal.complete(CONVERSATION_ID, callId, "write", input, result);

    harness.server.snapshotMessages = [
      wireUser(turnId, "Recover the completed mutation result"),
      wireAssistant(
        "assistant_recovered_completed_receipt",
        writeApprovalParts(callId, "approval-responded", true),
      ),
    ];
    harness.server.snapshotRunState = active(1, turnId, turnId, "waiting_for_client");

    await harness.agent.hydrate(CONVERSATION_ID);
    await waitFor(() => harness.commands().some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));

    expect(harness.executeLocalTool).not.toHaveBeenCalled();
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "mutation_replay_served",
      toolCallId: callId,
    }));
    expect(harness.commands()).toContainEqual(expect.objectContaining({
      kind: "client_tool_result",
      tool_call_id: callId,
      output: result,
    }));
  });

  it("keeps Always Allow local and executes its bound call once", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_always_allow_bound_call";
    const assistantId = "assistant_always_allow_bound_call";
    const callId = "call_always_allow_bound_call";
    const user = wireUser(turnId, "Apply the trusted write");
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Apply the trusted write"),
      approvalPolicy: {
        requireDestructiveApproval: true,
        trustedToolNames: new Set(["write"]),
      },
    });
    await waitFor(() => harness.commands(server).some((command) => command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-requested")),
    ));
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval"
      && command.tool_call_id === callId
      && command.approved === true));
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_approval",
      tool_call_id: callId,
      status: "accepted",
    }));
    expect(harness.onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      code: "approval_submitted_approved_policy",
      toolCallId: callId,
    }));
    expect(harness.executeLocalTool).not.toHaveBeenCalled();

    const responded = assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "approval-responded", true)),
    );
    server.serverMessage(responded);
    server.serverMessage(responded);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_result" && command.tool_call_id === callId));
    expect(harness.executeLocalTool.mock.calls.filter(([call]) =>
      call.callId === callId)).toHaveLength(1);
    server.serverMessage(event("command_ack", {
      request_id: turnId,
      command_kind: "client_tool_result",
      tool_call_id: callId,
      status: "accepted",
    }));
    server.serverMessage(assistantSnapshot(
      turnId,
      wireAssistant(assistantId, writeApprovalParts(callId, "output-available", true)),
    ));
    server.serverMessage(succeededTerminal(turnId, turnId));
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("rechecks local approval after the mutation claim and before execution", async () => {
    const harness = trackedHarness();
    const server = await harness.open();
    const turnId = "user_immediate_approval_recheck";
    const assistantId = "assistant_immediate_approval_recheck";
    const callId = "call_immediate_approval_recheck";
    const approvalId = "approval_immediate_recheck";
    const user = wireUser(turnId, "Apply only the approved identity");
    const original = { path: "Approved.md", content: "approved" };
    const changed = { path: "Changed.md", content: "changed" };
    let releaseClaim!: () => void;
    const claimBlocked = new Promise<void>((resolve) => { releaseClaim = resolve; });
    harness.mutationAdapter.write.mockImplementationOnce(async () => {
      await claimBlocked;
    });
    const run = harness.agent.start({
      conversationId: CONVERSATION_ID,
      turnId,
      message: userMessage(turnId, "Apply only the approved identity"),
      approvalPolicy: { requireDestructiveApproval: true },
    });
    await waitFor(() => harness.commands(server).some((command) => command.kind === "submit"));
    server.serverMessage(sessionSnapshot(
      [user],
      active(1, turnId, turnId, "waiting_for_client"),
    ));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "write", original),
      {
        type: "tool-write",
        toolCallId: callId,
        state: "approval-requested",
        input: original,
        approval: { id: approvalId },
      },
    ])));
    await waitFor(() => harness.agent.getSnapshot().parts.some((part) =>
      part.kind === "tool" && part.callId === callId));
    expect(harness.agent.respondToApproval(approvalId, true)).toBe(true);
    await waitFor(() => harness.commands(server).some((command) =>
      command.kind === "client_tool_approval" && command.tool_call_id === callId));
    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "write", original),
      {
        type: "tool-write",
        toolCallId: callId,
        state: "approval-responded",
        input: original,
        approval: { id: approvalId, approved: true },
      },
    ])));
    await waitFor(() => harness.mutationAdapter.write.mock.calls.length === 1);
    expect(harness.executeLocalTool).not.toHaveBeenCalled();

    server.serverMessage(assistantSnapshot(turnId, wireAssistant(assistantId, [
      clientToolRequest(callId, "write", changed),
      {
        type: "tool-write",
        toolCallId: callId,
        state: "approval-responded",
        input: changed,
        approval: { id: approvalId, approved: true },
      },
    ])));
    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "client_tool_identity_mismatch", retryable: false },
    });
    releaseClaim();
    await tick();
    expect(harness.executeLocalTool).not.toHaveBeenCalled();
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
