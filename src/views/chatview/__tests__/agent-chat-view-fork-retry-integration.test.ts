import type { ChatMessage } from "../../../types";
import type { AgentConversationSnapshot } from "../AgentConversation";
import { AgentChatView } from "../AgentChatView";
import {
  AgentChatSession,
} from "../agent/ChatSession";
import {
  THIN_AGENT_COMMAND_TYPE,
  THIN_AGENT_EVENT_TYPE,
  type AgentSubmitCommand,
} from "../agent/Protocol";

const SOURCE_CONVERSATION_ID = `conversation_${"1".repeat(32)}`;
const CLIENT_ID = `client_${"2".repeat(32)}`;
const PLUGIN_BUILD_ID = `sha256:${"3".repeat(64)}`;
const SOURCE_RUN_ID = `run_${"4".repeat(32)}`;
const REPLACEMENT_RUN_ID = `run_${"5".repeat(32)}`;
const SOURCE_INCIDENT_ID = `incident_${"6".repeat(32)}`;
const ORIGINAL_USER_ID = "user-original";
const OLD_FAILURE_ID = "assistant-old-failure";
const REPLACEMENT_ASSISTANT_ID = "assistant-replacement";
const CONTEXT_REF =
  "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type BootstrapRequest = Readonly<Record<string, any>>;

function sourceHistory(): readonly Record<string, unknown>[] {
  return [
    {
      id: ORIGINAL_USER_ID,
      role: "user",
      parts: [{ type: "text", text: "Reply exactly stable capacity proof." }],
    },
    {
      id: OLD_FAILURE_ID,
      role: "assistant",
      parts: [{
        type: "data-systemsculpt-run-terminal",
        data: {
          version: 1,
          run_id: SOURCE_RUN_ID,
          root_message_id: ORIGINAL_USER_ID,
          outcome: "failed",
          code: "response_capacity_unavailable",
          message: "SystemSculpt does not currently have enough service capacity.",
          retryable: true,
          incident_id: SOURCE_INCIDENT_ID,
        },
      }],
    },
  ];
}

function idleRunState(cursor: number) {
  return { version: 1, cursor, state: "idle" } as const;
}

function runningRunState(
  cursor: number,
  requestId: string,
  rootMessageId: string,
) {
  return {
    version: 1,
    cursor,
    state: "running",
    request_id: requestId,
    run_id: REPLACEMENT_RUN_ID,
    root_message_id: rootMessageId,
  } as const;
}

function sessionSnapshot(
  conversationId: string,
  cursor: number,
  messages: readonly unknown[],
) {
  return {
    type: THIN_AGENT_EVENT_TYPE,
    version: 1,
    kind: "session_snapshot",
    conversation_id: conversationId,
    messages,
    run_state: idleRunState(cursor),
  } as const;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

/**
 * One conversation's agent server, as the streaming client sees it.
 *
 * Keeps serverMessage so the fork/retry sequences read unchanged, but delivers
 * frames on the turn request that provoked them.
 */
class FakeStreamingServer {
  public readonly sent: unknown[] = [];
  /** Hydration blocks on the first snapshot the test provides. */
  private resolveSnapshot: ((value: unknown) => void) | null = null;
  public readonly snapshot: Promise<unknown> = new Promise((resolve) => {
    this.resolveSnapshot = resolve;
  });
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly buffered: string[] = [];
  private readonly encoder = new TextEncoder();

  public constructor(
    public readonly conversationId: string,
    private readonly onSend: (value: unknown) => void,
  ) {}

  public observe(body: unknown): void {
    const value = typeof body === "string" ? JSON.parse(body) as unknown : body;
    this.sent.push(value);
    this.onSend(value);
  }

  public openTurn(): Response {
    this.endTurn();
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
    try {
      if ((JSON.parse(frame) as { kind?: string }).kind === "terminal") {
        this.endTurn();
      }
    } catch { /* a malformed frame ends nothing */ }
  }

  public endTurn(): void {
    const controller = this.controller;
    this.controller = null;
    try { controller?.close(); } catch { /* already closed */ }
  }

  public open(): void { /* hydration answers the snapshot instead */ }

  public serverMessage(value: unknown): void {
    const resolve = this.resolveSnapshot;
    if (resolve) {
      this.resolveSnapshot = null;
      resolve(value);
      return;
    }
    const frame = JSON.stringify(value);
    if (this.controller) this.write(frame);
    else this.buffered.push(frame);
  }
}

function submitCommands(server: FakeStreamingServer): AgentSubmitCommand[] {
  return server.sent.filter((value): value is AgentSubmitCommand => {
    if (value === null || typeof value !== "object") return false;
    const frame = value as Record<string, unknown>;
    return frame.type === THIN_AGENT_COMMAND_TYPE
      && frame.kind === "submit";
  });
}

describe("AgentChatView historical Retry integration", () => {
  it("does not reconcile an empty fork before sending exactly one edited replacement", async () => {
    const order: string[] = [];
    const bootstrapRequests: BootstrapRequest[] = [];
    const accessRequests = new Map<string, BootstrapRequest>();
    const servers: FakeStreamingServer[] = [];
    const reportedErrors: unknown[] = [];
    let durableMessages: ChatMessage[] = [];
    let durableConversationId: string | null = SOURCE_CONVERSATION_ID;
    let durableVersion = 1;
    let projectedSnapshot: AgentConversationSnapshot | null = null;
    let renderedHistory: readonly ChatMessage[] = [];
    let destinationSynchronized = false;
    let replacementProjectionWasCleanAtSend = false;
    let emptyReconcileAttempts = 0;

    const snapshot = () => ({
      chatId: "chat-fork-retry",
      title: "Fork Retry",
      version: durableVersion,
      messages: durableMessages.map((message) => ({ ...message })),
      contextFiles: [],
      chatFontSize: "medium" as const,
      approvalMode: "ask" as const,
      agentConversationId: durableConversationId,
    });
    const transcript = {
      snapshot: jest.fn(snapshot),
      setTitle: jest.fn(),
      commitUser: jest.fn(async (input: Record<string, any>, conversationId: string) => {
        order.push("commit");
        durableMessages = [
          ...durableMessages.slice(0, input.expectedIndex as number),
          input.message as ChatMessage,
        ];
        durableConversationId = conversationId;
        durableVersion += 1;
        return snapshot();
      }),
      persistAssistant: jest.fn(async (message: ChatMessage) => {
        if (!durableMessages.some((candidate) =>
          candidate.message_id === message.message_id)) {
          durableMessages = [...durableMessages, { ...message }];
          durableVersion += 1;
        }
        return snapshot();
      }),
      reconcileServerHistory: jest.fn(async (messages: readonly ChatMessage[]) => {
        if (messages.length === 0 && durableMessages.length > 0) {
          emptyReconcileAttempts += 1;
          throw new Error("Cannot save empty messages over existing chat content");
        }
        durableMessages = messages.map((message) => ({ ...message }));
        durableVersion += 1;
        return snapshot();
      }),
    };
    const workspace = {
      setHistory: jest.fn(async (messages: readonly ChatMessage[]) => {
        renderedHistory = messages.map((message) => ({ ...message }));
      }),
      setAgentSnapshot: jest.fn(async (value: AgentConversationSnapshot | null) => {
        projectedSnapshot = value;
      }),
      setRunPending: jest.fn(),
      setBanner: jest.fn(),
      settleCompletedRun: jest.fn(async () => undefined),
      resetMessageEditor: jest.fn(),
      showMessageEditor: jest.fn(async () => undefined),
      hideMessageEditor: jest.fn(async () => undefined),
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    function onCommand(value: unknown): void {
      if (
        value !== null
        && typeof value === "object"
        && (value as Record<string, unknown>).kind === "submit"
      ) {
        order.push("send");
        replacementProjectionWasCleanAtSend = destinationSynchronized
          && !JSON.stringify(projectedSnapshot).includes(SOURCE_RUN_ID)
          && !JSON.stringify(projectedSnapshot).includes(ORIGINAL_USER_ID);
      }
    }
    const requestClient = {
      request: jest.fn(async (request: Record<string, any>) => {
        const url = new URL(request.url as string);
        if (url.pathname.endsWith("/agent/bootstrap")) {
          const body = structuredClone(request.body as BootstrapRequest);
          bootstrapRequests.push(body);
          const forkNumber = bootstrapRequests.filter((entry) => entry.fork).length;
          order.push(body.fork ? `fork-bootstrap-${forkNumber}` : "source-bootstrap");
          const token = `fixture.access.${bootstrapRequests.length}.signature`;
          accessRequests.set(token, body);
          return new Response(JSON.stringify({
            contract_version: "thin-agent-v1",
            conversation_id: body.conversation_id,
            session: { id: `session_${String(bootstrapRequests.length).repeat(32)}` },
            access: {
              token,
              expires_at: "2030-01-01T00:01:00.000Z",
            },
            client_input_limits: {
              image_mime_types: ["image/png", "image/jpeg", "image/webp"],
              max_content_blocks_per_message: 16,
              max_images_per_turn: 6,
              max_image_bytes: 6 * 1024 * 1024,
              max_total_image_bytes: 16 * 1024 * 1024,
              max_text_bytes_per_block: 1024 * 1024,
              max_total_text_bytes: 2 * 1024 * 1024,
              max_document_bytes: 25 * 1024 * 1024,
            },
            accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
          }), { status: 200 });
        }
        if (url.pathname.endsWith("/agent/context")) {
          order.push("context");
          return new Response(JSON.stringify({
            contract_version: "thin-agent-v1",
            context_ref: CONTEXT_REF,
            expires_at: "2030-01-01T00:02:00.000Z",
            bytes: 10,
            sha256: `sha256:${"7".repeat(64)}`,
          }), { status: 201 });
        }
        if (url.pathname.endsWith("/connect/get-messages")) {
          const authorization = new Headers(request.headers).get("Authorization") ?? "";
          const token = authorization.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : "";
          const bootstrap = accessRequests.get(token);
          if (!bootstrap) throw new Error("Hydration used an unknown access token.");
          const server = new FakeStreamingServer(
            bootstrap.conversation_id as string,
            onCommand,
          );
          servers.push(server);
          return new Response(JSON.stringify(await server.snapshot), { status: 200 });
        }
        if (url.pathname.endsWith("/agent/turn")) {
          const authorization = new Headers(request.headers).get("Authorization") ?? "";
          const token = authorization.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : "";
          const bootstrap = accessRequests.get(token);
          const server = servers.find((candidate) =>
            candidate.conversationId === bootstrap?.conversation_id);
          server?.observe(request.body);
          return server
            ? server.openTurn()
            : new Response("", { status: 200 });
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    };
    const mutationJournal = {
      claim: jest.fn(async () => ({ kind: "execute" as const })),
      complete: jest.fn(async () => undefined),
      idle: jest.fn(async () => undefined),
    };
    const agent = new AgentChatSession({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "private-license",
      bootstrapRequest: () => {
        const request = (view as any).thinBootstrapRequest;
        if (!request) throw new Error("Missing bootstrap request.");
        return request;
      },
      mutationJournal: mutationJournal as any,
      executeLocalTool: jest.fn(async () => ({ success: true, data: { ok: true } })),
      persistAssistant: async (message) => {
        await transcript.persistAssistant(message);
      },
      reconcileHistory: (messages) => (view as any).reconcileAgentHistory(messages),
      reportError: (error) => reportedErrors.push(error),
      requestClient: requestClient as any,
      now: () => 1_000,
    });

    Object.assign(view, {
      workspace,
      transcript,
      agent,
      attachmentStore: {
        hydrateMessage: jest.fn(async (message: ChatMessage) => message),
      },
      contextManager: { getPinnedFiles: jest.fn(() => []) },
      plugin: {
        settings: { licenseKey: "private-license" },
        getLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
      },
      automationApprovalMode: "interactive",
      approvalMode: "ask",
      sessionTrustedToolNames: new Set<string>(),
      activeSubmissionOperation: null,
      queuedFollowUps: [],
      queueDrainSuppressionDepth: 0,
      conversationOriginToken: "origin-fork-retry",
      runConversationOrigins: new Map<string, string>(),
      pendingRetry: null,
      pendingRejectedRetry: null,
      pendingForkHistory: null,
      pendingThinConversationId: SOURCE_CONVERSATION_ID,
      thinClientId: CLIENT_ID,
      thinBootstrapRequest: {
        contract_version: "thin-agent-v1",
        conversation_id: SOURCE_CONVERSATION_ID,
        client_id: CLIENT_ID,
        plugin_build_id: PLUGIN_BUILD_ID,
        capability_manifest: {
          contract_version: "thin-agent-capabilities-v1",
          capabilities: [{ id: "obsidian.vault", version: 1 }],
        },
      },
      chatId: "chat-fork-retry",
      chatTitle: "Fork Retry",
      messageEditGeneration: 0,
      legacyHistoryViewOnly: false,
      readThinAgentContextSources: jest.fn(async () => []),
      getLoadedPluginBuildId: jest.fn(async () => PLUGIN_BUILD_ID),
      applyTranscriptIdentity: jest.fn(),
      bindQueueToChat: jest.fn(async () => undefined),
      updateViewState: jest.fn(),
    });
    const unsubscribe = agent.subscribe((agentSnapshot) => {
      (view as any).renderAgentSnapshot(agentSnapshot);
    });

    try {
      const sourceHydration = agent.hydrate(SOURCE_CONVERSATION_ID);
      await eventually(() => expect(servers).toHaveLength(1));
      servers[0].serverMessage(sessionSnapshot(
        SOURCE_CONVERSATION_ID,
        1,
        sourceHistory(),
      ));
      await sourceHydration;

      expect(agent.getSnapshot()).toMatchObject({
        status: "failed",
        turnId: ORIGINAL_USER_ID,
        terminalError: { code: "agent_turn_failed" },
      });
      expect(JSON.stringify(projectedSnapshot)).toContain(SOURCE_RUN_ID);
      expect(durableMessages).toEqual([
        expect.objectContaining({ message_id: ORIGINAL_USER_ID, role: "user" }),
      ]);
      const reconciliationsBeforeFork = transcript.reconcileServerHistory.mock.calls.length;

      const retry = (view as any).retryFailedTurn(ORIGINAL_USER_ID) as Promise<void>;
      await eventually(() => expect(servers).toHaveLength(2));

      expect(transcript.commitUser).not.toHaveBeenCalled();
      expect(submitCommands(servers[1])).toHaveLength(0);
      expect(workspace.setAgentSnapshot).toHaveBeenCalledWith(null);

      destinationSynchronized = true;
      order.push("fork-snapshot");
      servers[1].serverMessage(sessionSnapshot(servers[1].conversationId, 1, []));

      await eventually(() => expect(submitCommands(servers[1])).toHaveLength(1));
      const outbound = submitCommands(servers[1]);
      const replacement = outbound[0];
      expect(replacement).toMatchObject({
        request_id: expect.not.stringMatching(/^user-original$/),
        context_ref: CONTEXT_REF,
        user_message: {
          id: expect.not.stringMatching(/^user-original$/),
          role: "user",
          parts: [{ type: "text", text: "Reply exactly stable capacity proof." }],
        },
      });
      expect(replacement.request_id).toBe(replacement.user_message.id);
      const replacementUserId = replacement.user_message.id;

      expect(emptyReconcileAttempts).toBe(0);
      expect(transcript.reconcileServerHistory).toHaveBeenCalledTimes(
        reconciliationsBeforeFork,
      );
      expect(replacementProjectionWasCleanAtSend).toBe(true);

      servers[1].serverMessage({
        type: THIN_AGENT_EVENT_TYPE,
        version: 1,
        kind: "run_state",
        conversation_id: servers[1].conversationId,
        run_state: runningRunState(2, replacement.request_id, replacementUserId),
      });
      servers[1].serverMessage({
        type: THIN_AGENT_EVENT_TYPE,
        version: 1,
        kind: "assistant_snapshot",
        conversation_id: servers[1].conversationId,
        request_id: replacement.request_id,
        message: {
          id: REPLACEMENT_ASSISTANT_ID,
          role: "assistant",
          parts: [{ type: "text", text: "stable capacity proof" }],
        },
      });
      servers[1].serverMessage({
        type: THIN_AGENT_EVENT_TYPE,
        version: 1,
        kind: "run_state",
        conversation_id: servers[1].conversationId,
        run_state: idleRunState(3),
      });
      servers[1].serverMessage({
        type: THIN_AGENT_EVENT_TYPE,
        version: 1,
        kind: "terminal",
        conversation_id: servers[1].conversationId,
        request_id: replacement.request_id,
        terminal: {
          version: 1,
          run_id: REPLACEMENT_RUN_ID,
          root_message_id: replacementUserId,
          outcome: "succeeded",
          code: "completed",
        },
      });
      await retry;

      const forkBootstraps = bootstrapRequests.filter((entry) => entry.fork);
      expect(forkBootstraps).toHaveLength(1);
      expect(forkBootstraps[0]).toMatchObject({
        conversation_id: expect.stringMatching(/^conversation_[a-f0-9]{32}$/),
        fork: {
          source_conversation_id: SOURCE_CONVERSATION_ID,
          before_message_id: ORIGINAL_USER_ID,
        },
      });
      // Hydration is a request now, so the point is that each conversation
      // hydrates once and the fork never re-reads history on top of that.
      expect(requestClient.request.mock.calls.filter(([request]) =>
        new URL(request.url as string).pathname.endsWith("/get-messages")))
        .toHaveLength(2);
      expect(servers.flatMap(submitCommands)).toHaveLength(1);

      expect(order.indexOf("fork-snapshot")).toBeLessThan(order.indexOf("context"));
      expect(order.indexOf("context")).toBeLessThan(order.indexOf("commit"));
      expect(order.indexOf("commit")).toBeLessThan(order.indexOf("send"));
      expect(emptyReconcileAttempts).toBe(0);
      expect(transcript.reconcileServerHistory.mock.calls.every(([messages]) =>
        (messages as readonly ChatMessage[]).length > 0)).toBe(true);
      expect(reportedErrors.map((error) => String(error))).not.toContain(
        "Error: Cannot save empty messages over existing chat content",
      );

      expect(durableMessages).toEqual([
        expect.objectContaining({
          role: "user",
          message_id: replacementUserId,
        }),
        expect.objectContaining({
          role: "assistant",
          message_id: REPLACEMENT_ASSISTANT_ID,
          content: "stable capacity proof",
        }),
      ]);
      expect(durableMessages.map((message) => message.message_id)).not.toContain(
        ORIGINAL_USER_ID,
      );
      expect(durableMessages.map((message) => message.message_id)).not.toContain(
        OLD_FAILURE_ID,
      );
      expect(renderedHistory.map((message) => message.message_id)).not.toContain(
        OLD_FAILURE_ID,
      );
      expect(JSON.stringify(agent.getSnapshot())).not.toContain(SOURCE_RUN_ID);
      expect(agent.getSnapshot()).toMatchObject({
        status: "completed",
        turnId: replacementUserId,
      });
    } finally {
      unsubscribe();
      await agent.detach();
    }
  }, 15_000);
});
