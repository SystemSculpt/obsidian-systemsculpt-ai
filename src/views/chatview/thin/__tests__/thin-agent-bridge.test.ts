import { MessageType } from "agents/chat";
import type { UIMessage, UIMessageChunk } from "ai";
import { ThinAgentBridge } from "../ThinAgentBridge";
import type { ThinAgentLifecycleInput } from "../ThinAgentLifecycle";

const CONVERSATION_ID = "conversation_0123456789abcdef0123456789abcdef";
const RUN_ID = "run_0123456789abcdef0123456789abcdef";

function stream(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

function expectLifecycleOrder(
  events: readonly ThinAgentLifecycleInput[],
  expected: readonly ThinAgentLifecycleInput["code"][],
): void {
  let cursor = -1;
  for (const code of expected) {
    cursor = events.findIndex((event, index) => index > cursor && event.code === code);
    if (cursor < 0) {
      throw new Error(
        `Expected lifecycle code ${code} after the prior match. Actual chronology: ${
          events.map((event) => event.code).join(", ")
        }`,
      );
    }
  }
}

class FakeTransport {
  public readonly sent: any[] = [];
  public readonly reconnects: any[] = [];
  public expectToolContinuation = jest.fn();
  public retryPendingResume = jest.fn(() => false);
  public cancelActiveServerTurn = jest.fn(() => true);
  public cancelPendingResume = jest.fn(() => false);
  public abortActiveToolContinuation = jest.fn(() => false);
  public resetResumeState = jest.fn();
  public handleStreamResuming = jest.fn(() => true);
  public handleStreamResumeNone = jest.fn(() => true);
  public handleStreamPending = jest.fn(() => true);
  private readonly initial: Array<ReadableStream<UIMessageChunk>>;
  private readonly continuations: Array<ReadableStream<UIMessageChunk> | null>;

  constructor(
    initial: readonly UIMessageChunk[],
    continuations: Array<readonly UIMessageChunk[] | null> = [],
  ) {
    this.initial = [stream(initial)];
    this.continuations = continuations.map((chunks) => chunks ? stream(chunks) : null);
  }

  public async sendMessages(options: any): Promise<ReadableStream<UIMessageChunk>> {
    this.sent.push(options);
    return this.initial.shift() ?? stream([]);
  }

  public async reconnectToStream(options: any): Promise<ReadableStream<UIMessageChunk> | null> {
    this.reconnects.push(options);
    return this.continuations.shift() ?? null;
  }

  public enqueueSend(chunks: readonly UIMessageChunk[]): void {
    this.initial.push(stream(chunks));
  }
}

class FakeConnection {
  public readonly sentFrames: any[] = [];
  public readonly lifecycleEvents: ThinAgentLifecycleInput[] = [];
  public readyFailures = 0;
  public connect = jest.fn();
  public disconnect = jest.fn(() => {
    this.didEmitHistory = false;
  });
  private readonly messages = new Set<(event: MessageEvent) => void>();
  private readonly opens = new Set<(event: Event) => void>();
  private readonly closes = new Set<(event: CloseEvent) => void>();
  private initialHistory?: UIMessage[];
  private didEmitHistory = false;
  private readonly readyFrames: unknown[] = [];

  constructor(
    public readonly transport: FakeTransport,
    initialHistory?: UIMessage[],
  ) {
    this.initialHistory = initialHistory;
  }

  public async whenReady(): Promise<void> {
    if (this.readyFailures > 0) {
      this.readyFailures -= 1;
      throw Object.assign(new Error("response unavailable"), {
        code: "response_start_failed",
        retryable: true,
      });
    }
    if (!this.didEmitHistory) {
      this.didEmitHistory = true;
      this.emit({
        type: MessageType.CF_AGENT_CHAT_MESSAGES,
        messages: this.initialHistory ?? [],
      });
    }
    for (const frame of this.readyFrames.splice(0)) this.emit(frame);
  }

  public chatTransport(): any {
    return this.transport;
  }

  public async prepare(): Promise<any> {
    return {
      messages: this.initialHistory ?? [],
      inputLimits: {
        imageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        maxContentBlocksPerMessage: 16,
        maxImagesPerTurn: 6,
        maxImageBytes: 6 * 1024 * 1024,
        maxTotalImageBytes: 16 * 1024 * 1024,
        maxTextBytesPerBlock: 1024 * 1024,
        maxTotalTextBytes: 2 * 1024 * 1024,
        maxDocumentBytes: 25 * 1024 * 1024,
      },
    };
  }

  public agentClient(): any {
    return {
      send: (value: string) => this.sentFrames.push(JSON.parse(value)),
    };
  }

  public addMessageListener(listener: (event: MessageEvent) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  public addOpenListener(listener: (event: Event) => void): () => void {
    this.opens.add(listener);
    return () => this.opens.delete(listener);
  }

  public addCloseListener(listener: (event: CloseEvent) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  public handleProtocolFrame(): boolean {
    return false;
  }

  public recordLifecycle(input: ThinAgentLifecycleInput): void {
    this.lifecycleEvents.push(input);
  }

  public cancel = jest.fn(() => true);

  public close(): void {}

  public emit(frame: unknown): void {
    const event = { data: JSON.stringify(frame) } as MessageEvent;
    for (const listener of this.messages) listener(event);
  }

  public reopen(): void {
    for (const listener of this.closes) {
      listener({ code: 1006, reason: "" } as CloseEvent);
    }
    for (const listener of this.opens) listener({} as Event);
  }

  public closeWith(code: number, reason: string): void {
    for (const listener of this.closes) {
      listener({ code, reason } as CloseEvent);
    }
  }

  public setInitialHistory(messages: UIMessage[]): void {
    this.initialHistory = messages;
  }

  public emitWhenReady(frame: unknown): void {
    this.readyFrames.push(frame);
  }
}

function completedPart(rootMessageId: string) {
  return {
    type: "data-systemsculpt-run-terminal",
    data: {
      version: 1,
      run_id: RUN_ID,
      root_message_id: rootMessageId,
      outcome: "succeeded",
      code: "completed",
    },
  } as const;
}

function createBridge(
  connection: FakeConnection,
  executeLocalTool = jest.fn(async () => ({ success: true, data: { ok: true } })),
  mutationJournal: any = {
    claim: jest.fn(async () => ({ kind: "execute" })),
    complete: jest.fn(async () => {}),
    idle: jest.fn(async () => {}),
  },
  reconcileHistory?: (messages: readonly any[]) => Promise<void>,
  onPersistAssistant?: (message: any) => Promise<void>,
  reportError?: (error: unknown) => void,
) {
  const persisted: any[] = [];
  const bridge = new ThinAgentBridge({
    connection: connection as any,
    mutationJournal,
    executeLocalTool,
    persistAssistant: async (message) => {
      persisted.push(message);
      await onPersistAssistant?.(message);
    },
    reconcileHistory,
    reportError,
    runId: () => "run-local",
    now: () => 100,
  });
  return { bridge, persisted, executeLocalTool, mutationJournal };
}

describe("ThinAgentBridge official headless Chat integration", () => {
  it("does not commit or send on bootstrap failure and can retry cleanly", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-retry" },
      { type: "text-start", id: "text-retry" },
      { type: "text-delta", id: "text-retry", delta: "Retried." },
      { type: "text-end", id: "text-retry" },
      completedPart("user-retry"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    connection.readyFailures = 1;
    const { bridge } = createBridge(connection);
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));
    const beforeSend = jest.fn(async () => {});
    const input = {
      conversationId: CONVERSATION_ID,
      turnId: "user-retry",
      message: {
        id: "user-retry",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Retry me" }],
      },
      approvalPolicy: "ask" as const,
      beforeSend,
    };

    await expect(bridge.start(input)).resolves.toMatchObject({
      kind: "failed",
      error: { code: "response_start_failed", retryable: true },
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(observedStatuses.filter((status) => status === "failed")).toHaveLength(1);

    await expect(bridge.start(input)).resolves.toMatchObject({ kind: "completed" });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(transport.sent).toHaveLength(1);
  });

  it("fails closed when a completed terminal has no user-visible final answer", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-silent-terminal" },
      completedPart("user-silent-terminal"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge, persisted } = createBridge(connection);

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-silent-terminal",
      message: {
        id: "user-silent-terminal",
        role: "user",
        parts: [{ type: "text", text: "Complete this task." }],
      },
      approvalPolicy: "ask",
    })).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "response_missing_final_answer",
        retryable: true,
      },
    });

    expect(persisted).toHaveLength(0);
    expect(bridge.getSnapshot()).toMatchObject({
      status: "failed",
      terminalError: { code: "response_missing_final_answer" },
    });
  });

  it("does not send when the local user commit fails after bootstrap", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const beforeSend = jest.fn(async () => {
      throw new Error("disk full");
    });

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-local-failure",
      message: {
        id: "user-local-failure",
        role: "user",
        parts: [{ type: "text", text: "Do not send me" }],
      },
      approvalPolicy: "ask",
      beforeSend,
    })).resolves.toMatchObject({
      kind: "failed",
      error: { code: "message_save_failed" },
    });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(transport.sent).toHaveLength(0);
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(connection.sentFrames).toContainEqual({
      type: "systemsculpt.client_diagnostic.v1",
      payload: {
        version: 1,
        severity: "error",
        code: "message_save_failed",
        phase: "persistence",
        run_id: "run-local",
      },
    });
  });

  it("sends the admitted turn before honoring cancellation requested during the durable commit", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    let resolveCommit: (() => void) | undefined;
    const commit = new Promise<void>((resolve) => {
      resolveCommit = resolve;
    });
    const beforeSend = jest.fn(() => commit);
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-cancel-during-commit",
      message: {
        id: "user-cancel-during-commit",
        role: "user",
        parts: [{ type: "text", text: "Admit this turn before stopping" }],
      },
      approvalPolicy: "ask",
      beforeSend,
    });
    await eventually(() => expect(beforeSend).toHaveBeenCalledTimes(1));

    const cancellation = bridge.cancel();
    await Promise.resolve();
    expect(transport.sent).toHaveLength(0);
    expect(connection.cancel).not.toHaveBeenCalled();

    resolveCommit?.();
    await cancellation;
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].messages.map((message: UIMessage) => message.id))
      .toEqual(["user-cancel-during-commit"]);
    expect(connection.cancel).toHaveBeenCalledTimes(1);
    expect(observedStatuses).not.toContain("failed");
    expect(bridge.getSnapshot().status).toBe("cancelled");
  });

  it("sends nothing when the durable commit rejects while cancellation is waiting", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    let rejectCommit: ((error: Error) => void) | undefined;
    const commit = new Promise<void>((_resolve, reject) => {
      rejectCommit = reject;
    });
    const beforeSend = jest.fn(() => commit);

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-cancel-during-failed-commit",
      message: {
        id: "user-cancel-during-failed-commit",
        role: "user",
        parts: [{ type: "text", text: "Do not send a failed admission" }],
      },
      approvalPolicy: "ask",
      beforeSend,
    });
    await eventually(() => expect(beforeSend).toHaveBeenCalledTimes(1));

    const cancellation = bridge.cancel();
    rejectCommit?.(new Error("disk full"));
    await cancellation;
    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "message_save_failed" },
    });

    expect(transport.sent).toHaveLength(0);
    expect(connection.cancel).not.toHaveBeenCalled();
  });

  it("returns cancellation without a stale failure when disconnect supersedes preparation", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const prepare = jest.spyOn(connection, "prepare").mockImplementation(async () => {
      await preparation;
      return {
        messages: [],
        inputLimits: {
          imageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          maxContentBlocksPerMessage: 16,
          maxImagesPerTurn: 6,
          maxImageBytes: 6 * 1024 * 1024,
          maxTotalImageBytes: 16 * 1024 * 1024,
          maxTextBytesPerBlock: 1024 * 1024,
          maxTotalTextBytes: 2 * 1024 * 1024,
          maxDocumentBytes: 25 * 1024 * 1024,
        },
      };
    });
    const { bridge } = createBridge(connection);
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-superseded-prepare",
      message: {
        id: "user-superseded-prepare",
        role: "user",
        parts: [{ type: "text", text: "Superseded by New chat" }],
      },
      approvalPolicy: "ask",
    });
    expect(prepare).toHaveBeenCalledTimes(1);

    bridge.disconnect();
    releasePreparation?.();

    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
    expect(connection.connect).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(observedStatuses).not.toContain("failed");
  });

  it("stops a deferred preparation before context, commit, or network submission", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const prepare = jest.spyOn(connection, "prepare").mockImplementation(async () => {
      await preparation;
      return {
        messages: [],
        inputLimits: {
          imageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          maxContentBlocksPerMessage: 16,
          maxImagesPerTurn: 6,
          maxImageBytes: 6 * 1024 * 1024,
          maxTotalImageBytes: 16 * 1024 * 1024,
          maxTextBytesPerBlock: 1024 * 1024,
          maxTotalTextBytes: 2 * 1024 * 1024,
          maxDocumentBytes: 25 * 1024 * 1024,
        },
      };
    });
    const { bridge } = createBridge(connection);
    const buildBody = jest.fn(async () => ({}));
    const beforeSend = jest.fn(async () => {});
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-stop-preparation",
      message: {
        id: "user-stop-preparation",
        role: "user",
        parts: [{ type: "text", text: "Stop before preparation finishes" }],
      },
      approvalPolicy: "ask",
      buildBody,
      beforeSend,
    });
    await eventually(() => expect(prepare).toHaveBeenCalledTimes(1));

    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });

    expect(buildBody).not.toHaveBeenCalled();
    expect(beforeSend).not.toHaveBeenCalled();
    expect(connection.connect).not.toHaveBeenCalled();
    expect(connection.disconnect).toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(observedStatuses).not.toContain("failed");
    releasePreparation?.();
  });

  it("adds only canonical incident correlation to client failure diagnostics", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-context-failure",
      message: {
        id: "user-context-failure",
        role: "user",
        parts: [{ type: "text", text: "Use context" }],
      },
      approvalPolicy: "ask",
      buildBody: async () => {
        throw {
          code: "context_prepare_failed",
          message: "SystemSculpt could not prepare vault context.",
          incidentId: "incident_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          retryable: true,
        };
      },
    })).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "context_prepare_failed",
        requestId: "incident_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    });

    expect(connection.sentFrames).toContainEqual({
      type: "systemsculpt.client_diagnostic.v1",
      payload: {
        version: 1,
        severity: "error",
        code: "context_prepare_failed",
        phase: "start",
        run_id: "run-local",
        retryable: true,
        incident_id: "incident_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    });
    expect(connection.lifecycleEvents).toContainEqual(expect.objectContaining({
      code: "run_finished_failed",
      incidentId: "incident_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }));
  });

  it("builds the opaque turn body after bootstrap and before the local user commit", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-context" },
      { type: "text-start", id: "text-context" },
      { type: "text-delta", id: "text-context", delta: "Context received." },
      { type: "text-end", id: "text-context" },
      completedPart("user-context"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const order: string[] = [];
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        if (messages.some((message) => message.message_id === "user-context")) {
          order.push("reconcile-user");
        }
      },
    );
    const buildBody = jest.fn(async (signal: AbortSignal) => {
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);
      order.push("stage");
      return {
        context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
    });
    const beforeSend = jest.fn(async () => {
      order.push("commit");
    });

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-context",
      message: {
        id: "user-context",
        role: "user",
        parts: [{ type: "text", text: "Use staged context" }],
      },
      approvalPolicy: "ask",
      buildBody,
      beforeSend,
    })).resolves.toMatchObject({ kind: "completed" });

    expect(order.slice(0, 3)).toEqual(["stage", "commit", "reconcile-user"]);
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toEqual(expect.objectContaining({
      body: {
        context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    }));
  });

  it("does not commit, send, or retry when lazy context staging fails", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const beforeSend = jest.fn(async () => {});
    const buildBody = jest.fn(async () => {
      throw Object.assign(new Error("Context staging is temporarily unavailable."), {
        code: "context_prepare_failed",
        status: 503,
        retryable: true,
      });
    });

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-context-failure",
      message: {
        id: "user-context-failure",
        role: "user",
        parts: [{ type: "text", text: "Do not leak raw-selected-note-content" }],
      },
      approvalPolicy: "ask",
      buildBody,
      beforeSend,
    })).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "context_prepare_failed",
        status: 503,
        retryable: true,
      },
    });

    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(beforeSend).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(JSON.stringify(connection.sentFrames)).not.toContain("raw-selected-note-content");
  });

  it("cancels context preparation without publishing a stale failure", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const beforeSend = jest.fn(async () => {});
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));
    const buildBody = jest.fn((signal: AbortSignal) => new Promise<Record<string, unknown>>(
      (_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        }, { once: true });
      },
    ));

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-cancel-context",
      message: {
        id: "user-cancel-context",
        role: "user",
        parts: [{ type: "text", text: "Stop while preparing context" }],
      },
      approvalPolicy: "ask",
      buildBody,
      beforeSend,
    });
    await eventually(() => expect(buildBody).toHaveBeenCalledTimes(1));

    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });

    expect(beforeSend).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(observedStatuses).not.toContain("failed");
    expect(bridge.getSnapshot().status).toBe("cancelled");
  });

  it("finishes a successful response when stop is requested during final persistence", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-persisting" },
      { type: "text-start", id: "text-persisting" },
      { type: "text-delta", id: "text-persisting", delta: "Persisted exactly once." },
      { type: "text-end", id: "text-persisting" },
      completedPart("user-persisting"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    let markPersistenceStarted: (() => void) | undefined;
    let releasePersistence: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      undefined,
      async () => {
        markPersistenceStarted?.();
        await persistenceGate;
      },
    );
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-persisting",
      message: {
        id: "user-persisting",
        role: "user",
        parts: [{ type: "text", text: "Finish durably" }],
      },
      approvalPolicy: {},
    });
    await persistenceStarted;

    const cancellation = bridge.cancel();
    let cancellationSettled = false;
    void cancellation.then(() => {
      cancellationSettled = true;
    });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);

    releasePersistence?.();
    await cancellation;
    await expect(run).resolves.toMatchObject({ kind: "completed" });

    expect(persisted).toHaveLength(1);
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(observedStatuses).not.toContain("cancelled");
    expect(bridge.getSnapshot().status).toBe("completed");
  });

  it("installs native listeners before ready and terminalizes a post-stream MESSAGE_UPDATED", async () => {
    const historical: UIMessage[] = [
      { id: "history-user", role: "user", parts: [{ type: "text", text: "Earlier" }] },
      { id: "history-assistant", role: "assistant", parts: [{ type: "text", text: "Earlier answer" }] },
    ];
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-current" },
      { type: "text-start", id: "text-current" },
      { type: "text-delta", id: "text-current", delta: "Current answer" },
      { type: "text-end", id: "text-current" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport, historical);
    const { bridge, persisted } = createBridge(connection);

    const resultPromise = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-current",
      message: {
        id: "user-current",
        role: "user",
        parts: [{ type: "text", text: "Current question" }],
      },
      approvalPolicy: "ask",
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0].messages.map((message: UIMessage) => message.id))
      .toEqual(["history-user", "history-assistant", "user-current"]);

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "history-assistant",
        role: "assistant",
        parts: [
          { type: "text", text: "Earlier answer", state: "done" },
          completedPart("history-user"),
        ],
      },
    });
    await Promise.resolve();
    expect(bridge.getSnapshot().status).not.toBe("completed");
    expect(persisted).toHaveLength(0);

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-current",
        role: "assistant",
        parts: [
          { type: "text", text: "Current answer", state: "done" },
          completedPart("different-user"),
        ],
      },
    });
    await Promise.resolve();
    expect(bridge.getSnapshot().status).not.toBe("completed");
    expect(persisted).toHaveLength(0);

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-current",
        role: "assistant",
        parts: [
          { type: "text", text: "Current answer", state: "done" },
          completedPart("user-current"),
        ],
      },
    });
    await expect(resultPromise).resolves.toMatchObject({ kind: "completed" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: "assistant",
      message_id: "assistant-current",
      content: "Current answer",
    });
    expect(bridge.getSnapshot().parts.some((part) =>
      part.kind === "text" && part.markdown === "Earlier answer")).toBe(false);
  });

  it("terminalizes an active turn when success arrives in authoritative full history", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-full-history" },
      { type: "text-start", id: "text-full-history" },
      { type: "text-delta", id: "text-full-history", delta: "Completed on the server" },
      { type: "text-end", id: "text-full-history" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const reconciled: any[][] = [];
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );
    const result = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-full-history",
      message: {
        id: "user-full-history",
        role: "user",
        parts: [{ type: "text", text: "Finish through history" }],
      },
      approvalPolicy: "ask",
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-full-history",
        role: "user",
        parts: [{ type: "text", text: "Finish through history" }],
      }, {
        id: "assistant-full-history",
        role: "assistant",
        parts: [
          { type: "text", text: "Completed on the server", state: "done" },
          completedPart("user-full-history"),
        ],
      }],
    });

    await expect(result).resolves.toMatchObject({ kind: "completed" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      message_id: "assistant-full-history",
      content: "Completed on the server",
    });
    expect(connection.lifecycleEvents).toContainEqual(expect.objectContaining({
      code: "response_result_received_succeeded",
      phase: "response",
    }));
    expect(new Set(connection.lifecycleEvents
      .map((event) => event.runId)
      .filter(Boolean))).toEqual(new Set(["run-local"]));
    expect(reconciled.flat().some((message) =>
      message.message_id === "assistant-full-history")).toBe(false);
  });

  it("publishes one projection for an active nonterminal CHAT_MESSAGES notification", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-history-publication" },
      { type: "text-start", id: "text-history-publication" },
      { type: "text-delta", id: "text-history-publication", delta: "Before history" },
      { type: "text-end", id: "text-history-publication" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const snapshots: any[] = [];
    bridge.subscribe((snapshot) => snapshots.push(snapshot));
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-history-publication",
      message: {
        id: "user-history-publication",
        role: "user",
        parts: [{ type: "text", text: "Keep publishing stable" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "text",
        markdown: "Before history",
      }),
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const publicationCount = snapshots.length;

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-history-publication",
        role: "user",
        parts: [{ type: "text", text: "Keep publishing stable" }],
      }, {
        id: "assistant-history-publication",
        role: "assistant",
        parts: [
          { type: "text", text: "After history", state: "done" },
          {
            type: "tool-web_search",
            toolCallId: "call-history-publication",
            state: "input-streaming",
            input: { query: "official sources" },
          },
        ],
      }],
    });

    expect(snapshots).toHaveLength(publicationCount + 1);
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "text",
      markdown: "After history",
    }));
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "tool",
      name: "web_search",
    }));
    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("publishes one projection for an active nonterminal MESSAGE_UPDATED notification", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-update-publication" },
      { type: "text-start", id: "text-update-publication" },
      { type: "text-delta", id: "text-update-publication", delta: "Before update" },
      { type: "text-end", id: "text-update-publication" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const snapshots: any[] = [];
    bridge.subscribe((snapshot) => snapshots.push(snapshot));
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-update-publication",
      message: {
        id: "user-update-publication",
        role: "user",
        parts: [{ type: "text", text: "Keep updates stable" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "text",
        markdown: "Before update",
      }),
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const publicationCount = snapshots.length;

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-update-publication",
        role: "assistant",
        parts: [{ type: "text", text: "After update", state: "done" }],
      },
    });

    expect(snapshots).toHaveLength(publicationCount + 1);
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "text",
      markdown: "After update",
    }));
    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("publishes immediate Thinking and one monotonic projection per delta in a 64-delta burst", async () => {
    const deltas = Array.from({ length: 64 }, () => ({
      type: "text-delta" as const,
      id: "text-burst",
      delta: "x",
    }));
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-burst" },
      { type: "text-start", id: "text-burst" },
      ...deltas,
      { type: "text-end", id: "text-burst" },
      completedPart("user-burst"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const snapshots: any[] = [];
    bridge.subscribe((snapshot) => snapshots.push(snapshot));

    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-burst",
      message: {
        id: "user-burst",
        role: "user",
        parts: [{ type: "text", text: "Stream a burst" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(snapshots).not.toHaveLength(0));
    expect(snapshots[0]).toMatchObject({
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
    });
    await expect(run).resolves.toMatchObject({ kind: "completed" });

    const streamedPrefixes = snapshots.flatMap((snapshot) => {
      if (snapshot.status !== "running" || snapshot.phase !== "working") return [];
      const text = snapshot.parts.find((part: any) =>
        part.kind === "text" && part.messageId === "assistant-burst");
      return typeof text?.markdown === "string" && text.markdown.length > 0
        ? [text.markdown]
        : [];
    });
    const growingPrefixes = streamedPrefixes.filter((prefix, index) =>
      index === 0 || prefix.length > streamedPrefixes[index - 1].length);
    expect(growingPrefixes.map((prefix) => prefix.length))
      .toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(new Set(growingPrefixes).size).toBe(64);

    const phaseCounts = snapshots.reduce<Record<string, number>>((counts, snapshot) => {
      counts[snapshot.phase] = (counts[snapshot.phase] ?? 0) + 1;
      return counts;
    }, {});
    expect({
      total: snapshots.length,
      submitted: phaseCounts.submitted ?? 0,
      working: phaseCounts.working ?? 0,
      settling: phaseCounts.settling ?? 0,
      complete: phaseCounts.complete ?? 0,
    }).toEqual({
      total: 77,
      submitted: 4,
      working: 69,
      settling: 3,
      complete: 1,
    });
  });

  it("never surfaces or reloads internal context setup while preserving server tools", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-server-tools" },
      {
        type: "tool-input-available",
        toolCallId: "call-set-context",
        toolName: "set_context",
        input: { content: "context-secret" },
        providerExecuted: true,
      },
      {
        type: "tool-output-available",
        toolCallId: "call-set-context",
        output: { success: true, data: { prepared: true } },
        providerExecuted: true,
      },
      {
        type: "tool-input-available",
        toolCallId: "call-web-search",
        toolName: "web_search",
        input: { query: "official sources" },
        providerExecuted: true,
      },
      {
        type: "tool-output-available",
        toolCallId: "call-web-search",
        output: { success: true, data: { result_count: 2 } },
        providerExecuted: true,
      },
      {
        type: "tool-input-available",
        toolCallId: "call-future-server-tool",
        toolName: "future_server_tool",
        input: { value: "keep-me" },
        providerExecuted: true,
      },
      {
        type: "tool-output-available",
        toolCallId: "call-future-server-tool",
        output: { success: true, data: { kept: true } },
        providerExecuted: true,
      },
      { type: "text-start", id: "text-server-tools" },
      { type: "text-delta", id: "text-server-tools", delta: "Server tools finished." },
      { type: "text-end", id: "text-server-tools" },
      completedPart("user-server-tools"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge, persisted, executeLocalTool } = createBridge(connection);
    const snapshots: any[] = [];
    bridge.subscribe((snapshot) => snapshots.push(snapshot));

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-server-tools",
      message: {
        id: "user-server-tools",
        role: "user",
        parts: [{ type: "text", text: "Use server tools" }],
      },
      approvalPolicy: {},
    })).resolves.toMatchObject({ kind: "completed" });

    const visibleToolNames = snapshots.flatMap((snapshot) =>
      snapshot.parts
        .filter((part: any) => part.kind === "tool")
        .map((part: any) => part.name));
    expect(new Set(visibleToolNames)).toEqual(new Set([
      "web_search",
      "future_server_tool",
    ]));
    expect(JSON.stringify(snapshots)).not.toContain("set_context");
    expect(JSON.stringify(snapshots)).not.toContain("context-secret");
    expect(executeLocalTool).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].tool_calls?.map((tool: any) => tool.request.function.name))
      .toEqual(["web_search", "future_server_tool"]);
    expect(JSON.stringify(persisted)).not.toContain("set_context");
    expect(JSON.stringify(persisted)).not.toContain("context-secret");

    const nativeHistory = JSON.parse(JSON.stringify((bridge as any).chat.messages));
    await bridge.close();
    const reloadConnection = new FakeConnection(new FakeTransport([]), nativeHistory);
    const reconciled: any[][] = [];
    const { bridge: reloadedBridge } = createBridge(
      reloadConnection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );
    await reloadedBridge.hydrate(CONVERSATION_ID);

    expect(reconciled.at(-1)?.[1]?.tool_calls
      ?.map((tool: any) => tool.request.function.name))
      .toEqual(["web_search", "future_server_tool"]);
    expect(JSON.stringify(reconciled)).not.toContain("set_context");
    expect(JSON.stringify(reconciled)).not.toContain("context-secret");
    await reloadedBridge.close();
  });

  it("keeps provider-executed vault-name collisions server-owned through approval, merge, and persistence", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-provider-write" },
      {
        type: "tool-input-available",
        toolCallId: "call-provider-write",
        toolName: "write",
        input: { path: "server-private-path", content: "server-private-content" },
        providerExecuted: true,
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-provider-write",
        toolCallId: "call-provider-write",
      },
      { type: "finish", finishReason: "tool-calls" },
    ], [null]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(async () => ({
      success: true,
      data: { path: "must-not-run.md" },
    }));
    const { bridge, persisted } = createBridge(connection, execute);
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-provider-write",
      message: {
        id: "user-provider-write",
        role: "user",
        parts: [{ type: "text", text: "Use the server action" }],
      },
      approvalPolicy: "ask",
    });

    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        callId: "call-provider-write",
        location: "server",
        state: "running",
      }),
    ));
    expect(bridge.getSnapshot()).toMatchObject({ status: "running" });
    expect(bridge.respondToApproval("approval-provider-write", true)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(connection.sentFrames.some((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_APPROVAL)).toBe(false);

    // An authoritative update may omit an already-observed additive field.
    // Server execution authority must be monotonic across that merge.
    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-provider-write",
        role: "assistant",
        parts: [{
          type: "tool-write",
          toolCallId: "call-provider-write",
          state: "approval-requested",
          input: { path: "server-private-path", content: "server-private-content" },
          approval: { id: "approval-provider-write" },
        }],
      },
    });
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.respondToApproval("approval-provider-write", true)).toBe(false);
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "tool",
      callId: "call-provider-write",
      location: "server",
      state: "running",
    }));

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-provider-write",
        role: "assistant",
        parts: [{
          type: "tool-write",
          toolCallId: "call-provider-write",
          state: "output-available",
          input: { path: "server-private-path", content: "server-private-content" },
          output: { success: true, data: { completed: true } },
        }, {
          type: "text",
          text: "Server action finished.",
          state: "done",
        }, completedPart("user-provider-write")],
      },
    });

    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(execute).not.toHaveBeenCalled();
    expect(connection.sentFrames.some((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_RESULT
      || frame.type === MessageType.CF_AGENT_TOOL_APPROVAL)).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].tool_calls).toEqual([
      expect.objectContaining({
        id: "call-provider-write",
        executedOn: "server",
        request: expect.objectContaining({
          function: expect.objectContaining({ name: "write" }),
        }),
      }),
    ]);
  });

  it("does not recover a terminal turn solely for unfinished provider-executed vault-name activity", async () => {
    const history: UIMessage[] = [{
      id: "user-provider-read-history",
      role: "user",
      parts: [{ type: "text", text: "Use the server read" }],
    }, {
      id: "assistant-provider-read-history",
      role: "assistant",
      parts: [{
        type: "tool-read",
        toolCallId: "call-provider-read-history",
        state: "input-available",
        input: { paths: ["server-private-path"] },
        providerExecuted: true,
      }, completedPart("user-provider-read-history")],
    }];
    const transport = new FakeTransport([], [null]);
    const connection = new FakeConnection(transport, history);
    const execute = jest.fn(async () => ({ success: true, data: { unexpected: true } }));
    const { bridge, persisted } = createBridge(connection, execute);

    await bridge.hydrate(CONVERSATION_ID);

    expect(bridge.getSnapshot().status).toBe("idle");
    expect(execute).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
    expect(connection.lifecycleEvents.some((event) => event.code === "run_started")).toBe(false);
  });

  it("merges stale same-id history monotonically and publishes one terminal projection", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-monotonic" },
      { type: "text-start", id: "text-monotonic" },
      { type: "text-delta", id: "text-monotonic", delta: "The complete streamed answer" },
      { type: "text-end", id: "text-monotonic" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    let releasePersistence: (() => void) | undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      undefined,
      async () => persistenceGate,
    );
    const snapshots: any[] = [];
    bridge.subscribe((snapshot) => snapshots.push(snapshot));
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-monotonic",
      message: {
        id: "user-monotonic",
        role: "user",
        parts: [{ type: "text", text: "Keep the newest response state" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "text",
        markdown: "The complete streamed answer",
      }),
    ));

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-monotonic",
        role: "assistant",
        parts: [
          { type: "text", text: "The complete streamed answer", state: "done" },
          {
            type: "tool-read",
            toolCallId: "call-monotonic",
            state: "output-available",
            input: { paths: ["Monotonic.md"] },
            output: { success: true, data: { content: "Current" } },
          },
        ],
      },
    });
    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-monotonic",
        role: "user",
        parts: [{ type: "text", text: "Keep the newest response state" }],
      }, {
        id: "assistant-monotonic",
        role: "assistant",
        parts: [
          { type: "text", text: "The complete", state: "streaming" },
          {
            type: "tool-read",
            toolCallId: "call-monotonic",
            state: "input-available",
            input: { paths: ["Monotonic.md"] },
          },
        ],
      }],
    });

    const currentAssistant = () => (bridge as any).chat.messages.find(
      (message: UIMessage) => message.id === "assistant-monotonic",
    );
    expect(currentAssistant().parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "The complete streamed answer" }),
      expect.objectContaining({
        type: "tool-read",
        toolCallId: "call-monotonic",
        state: "output-available",
      }),
    ]));

    const publicationCount = snapshots.length;
    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-monotonic",
        role: "user",
        parts: [{ type: "text", text: "Keep the newest response state" }],
      }, {
        id: "assistant-monotonic",
        role: "assistant",
        parts: [
          { type: "text", text: "The complete", state: "streaming" },
          {
            type: "tool-read",
            toolCallId: "call-monotonic",
            state: "input-available",
            input: { paths: ["Monotonic.md"] },
          },
          completedPart("user-monotonic"),
        ],
      }],
    });

    expect(snapshots).toHaveLength(publicationCount + 1);
    expect(bridge.getSnapshot()).toMatchObject({
      status: "running",
      phase: "settling",
    });
    expect(currentAssistant().parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "The complete streamed answer" }),
      expect.objectContaining({
        type: "tool-read",
        toolCallId: "call-monotonic",
        state: "output-available",
      }),
      expect.objectContaining({ type: "data-systemsculpt-run-terminal" }),
    ]));

    releasePersistence?.();
    await expect(run).resolves.toMatchObject({ kind: "completed" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      message_id: "assistant-monotonic",
      content: "The complete streamed answer",
    });
  });

  it("executes one vault tool once across authoritative history and message updates", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-authoritative-tool" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(async () => ({
      success: true,
      data: { content: "Found" },
    }));
    const { bridge } = createBridge(connection, execute);
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-authoritative-tool",
      message: {
        id: "user-authoritative-tool",
        role: "user",
        parts: [{ type: "text", text: "Read once" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));
    const assistant = {
      id: "assistant-authoritative-tool",
      role: "assistant" as const,
      parts: [{
        type: "tool-read",
        toolCallId: "call-authoritative-read",
        state: "input-available",
        input: { paths: ["Once.md"] },
      }],
    };

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-authoritative-tool",
        role: "user",
        parts: [{ type: "text", text: "Read once" }],
      }, assistant],
    });
    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: assistant,
    });

    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    await eventually(() => expect(connection.sentFrames.filter((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_RESULT)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: assistant,
    });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(connection.sentFrames.filter((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_RESULT)).toHaveLength(1);
    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("preserves an active submitted turn across stale empty history before terminal update", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-stale-history" },
      { type: "text-start", id: "text-stale-history" },
      { type: "text-delta", id: "text-stale-history", delta: "Still here" },
      { type: "text-end", id: "text-stale-history" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge, persisted } = createBridge(connection);
    const result = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-stale-history",
      message: {
        id: "user-stale-history",
        role: "user",
        parts: [{ type: "text", text: "Keep this turn" }],
      },
      approvalPolicy: "ask",
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));
    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "text",
        messageId: "assistant-stale-history",
        markdown: "Still here",
      }),
    ));

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [],
    });
    await Promise.resolve();

    expect(bridge.getSnapshot().status).not.toBe("failed");
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "text",
      messageId: "assistant-stale-history",
      markdown: "Still here",
    }));

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-stale-history",
        role: "assistant",
        parts: [
          { type: "text", text: "Still here", state: "done" },
          completedPart("user-stale-history"),
        ],
      },
    });

    await expect(result).resolves.toMatchObject({ kind: "completed" });
    expect(transport.sent).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: "assistant",
      message_id: "assistant-stale-history",
      content: "Still here",
    });
  });

  it("preserves a recovered streamed projection across a stale empty history frame", async () => {
    const history: UIMessage[] = [{
      id: "user-recovered-stale",
      role: "user",
      parts: [{ type: "text", text: "Recover this" }],
    }, {
      id: "assistant-recovered-stale",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Recovered partial answer",
        state: "streaming",
      }],
    }];
    const transport = new FakeTransport([], [null]);
    const connection = new FakeConnection(transport, history);
    const reconciled = jest.fn(async () => undefined);
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      reconciled,
    );

    await bridge.hydrate(CONVERSATION_ID);
    expect(bridge.getSnapshot()).toMatchObject({
      status: "running",
      turnId: "user-recovered-stale",
    });
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "text",
      messageId: "assistant-recovered-stale",
      markdown: "Recovered partial answer",
    }));
    reconciled.mockClear();

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [],
    });
    await Promise.resolve();

    expect(bridge.getSnapshot().status).toBe("running");
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "text",
      messageId: "assistant-recovered-stale",
      markdown: "Recovered partial answer",
    }));
    expect(reconciled).not.toHaveBeenCalled();
    await bridge.cancel();
  });

  it("reconciles a recovered streaming turn only through its user boundary", async () => {
    const history: UIMessage[] = [{
      id: "user-before-recovered",
      role: "user",
      parts: [{ type: "text", text: "Earlier question" }],
    }, {
      id: "assistant-before-recovered",
      role: "assistant",
      parts: [{ type: "text", text: "Earlier answer" }],
    }, {
      id: "user-recovered-prefix",
      role: "user",
      parts: [{ type: "text", text: "Recover this turn" }],
    }, {
      id: "assistant-recovered-prefix",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Partial answer",
        state: "streaming",
      }],
    }];
    const connection = new FakeConnection(new FakeTransport([], [null]), history);
    const reconciled = jest.fn(async () => undefined);
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      reconciled,
    );

    await bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(reconciled).toHaveBeenCalledTimes(1));
    expect(reconciled).toHaveBeenLastCalledWith([
      expect.objectContaining({ message_id: "user-before-recovered" }),
      expect.objectContaining({ message_id: "assistant-before-recovered" }),
      expect.objectContaining({ message_id: "user-recovered-prefix" }),
    ]);

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: history.map((message) =>
        message.id === "assistant-recovered-prefix"
          ? {
              ...message,
              parts: [{
                type: "text",
                text: "Longer partial answer",
                state: "streaming",
              }],
            }
          : message),
    });
    await Promise.resolve();

    expect(reconciled).toHaveBeenCalledTimes(1);
    await bridge.cancel();
  });

  it("does not let a late shorter recovered history delete a just-persisted terminal assistant", async () => {
    const history: UIMessage[] = [{
      id: "user-recovered-terminal",
      role: "user",
      parts: [{ type: "text", text: "Finish recovery" }],
    }, {
      id: "assistant-recovered-terminal",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Nearly done",
        state: "streaming",
      }],
    }];
    const connection = new FakeConnection(new FakeTransport([], [null]), history);
    let localMessageIds: string[] = [];
    const reconciled = jest.fn(async (messages: readonly any[]) => {
      localMessageIds = messages.map((message) => message.message_id);
    });
    let releaseAssistantPersistence: (() => void) | undefined;
    let markAssistantPersistenceStarted: (() => void) | undefined;
    const assistantPersistenceStarted = new Promise<void>((resolve) => {
      markAssistantPersistenceStarted = resolve;
    });
    const assistantPersistenceGate = new Promise<void>((resolve) => {
      releaseAssistantPersistence = resolve;
    });
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      reconciled,
      async (message) => {
        localMessageIds = [...localMessageIds, message.message_id];
        markAssistantPersistenceStarted?.();
        await assistantPersistenceGate;
      },
    );

    await bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(reconciled).toHaveBeenCalledTimes(1));
    expect(localMessageIds).toEqual(["user-recovered-terminal"]);

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-recovered-terminal",
        role: "assistant",
        parts: [
          { type: "text", text: "Finished recovery", state: "done" },
          completedPart("user-recovered-terminal"),
        ],
      },
    });
    await assistantPersistenceStarted;
    expect(localMessageIds).toEqual([
      "user-recovered-terminal",
      "assistant-recovered-terminal",
    ]);

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-recovered-terminal",
        role: "user",
        parts: [{ type: "text", text: "Finish recovery" }],
      }],
    });
    await Promise.resolve();

    expect(reconciled).toHaveBeenCalledTimes(1);
    expect(localMessageIds).toEqual([
      "user-recovered-terminal",
      "assistant-recovered-terminal",
    ]);

    releaseAssistantPersistence?.();
    await eventually(() => expect(bridge.getSnapshot().status).toBe("completed"));
    expect(persisted).toHaveLength(1);
  });

  it("replaces a stale completed tail with shorter authoritative history before the next submit", async () => {
    const history: UIMessage[] = [{
      id: "user-authoritative-prefix",
      role: "user",
      parts: [{ type: "text", text: "Earlier question" }],
    }, {
      id: "assistant-authoritative-prefix",
      role: "assistant",
      parts: [{ type: "text", text: "Earlier answer" }],
    }];
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-stale-completed" },
      { type: "text-start", id: "text-stale-completed" },
      { type: "text-delta", id: "text-stale-completed", delta: "Stale answer" },
      { type: "text-end", id: "text-stale-completed" },
      completedPart("user-stale-completed"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport, history);
    const reconciled = jest.fn(async () => undefined);
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      reconciled,
    );

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-stale-completed",
      message: {
        id: "user-stale-completed",
        role: "user",
        parts: [{ type: "text", text: "This turn will be removed" }],
      },
      approvalPolicy: "ask",
    })).resolves.toMatchObject({ kind: "completed" });
    expect(transport.sent[0].messages.map((message: UIMessage) => message.id))
      .toEqual([
        "user-authoritative-prefix",
        "assistant-authoritative-prefix",
        "user-stale-completed",
      ]);

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: history,
    });
    await eventually(() => {
      const latest = reconciled.mock.calls.at(-1)?.[0] ?? [];
      expect(latest.map((message: any) => message.message_id)).toEqual([
        "user-authoritative-prefix",
        "assistant-authoritative-prefix",
      ]);
    });

    transport.enqueueSend([
      { type: "start", messageId: "assistant-after-truncation" },
      { type: "text-start", id: "text-after-truncation" },
      { type: "text-delta", id: "text-after-truncation", delta: "Fresh answer" },
      { type: "text-end", id: "text-after-truncation" },
      completedPart("user-after-truncation"),
      { type: "finish", finishReason: "stop" },
    ]);
    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-after-truncation",
      message: {
        id: "user-after-truncation",
        role: "user",
        parts: [{ type: "text", text: "Continue from authoritative history" }],
      },
      approvalPolicy: "ask",
    })).resolves.toMatchObject({ kind: "completed" });

    expect(transport.sent).toHaveLength(2);
    const nextOutboundIds = transport.sent[1].messages
      .map((message: UIMessage) => message.id);
    expect(nextOutboundIds).toEqual([
      "user-authoritative-prefix",
      "assistant-authoritative-prefix",
      "user-after-truncation",
    ]);
    expect(nextOutboundIds).not.toContain("user-stale-completed");
    expect(nextOutboundIds).not.toContain("assistant-stale-completed");
  });

  it("runs one local reconciliation per idle authoritative history observation", async () => {
    const history: UIMessage[] = [{
      id: "user-idle-history",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    }, {
      id: "assistant-idle-history",
      role: "assistant",
      parts: [{ type: "text", text: "Initial answer" }],
    }];
    const connection = new FakeConnection(new FakeTransport([]), history);
    const reconciled = jest.fn(async () => undefined);
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      reconciled,
    );
    await bridge.hydrate(CONVERSATION_ID);
    reconciled.mockClear();

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: history,
    });
    await eventually(() => expect(reconciled).toHaveBeenCalledTimes(1));
    expect(reconciled).toHaveBeenLastCalledWith([
      expect.objectContaining({ message_id: "user-idle-history" }),
      expect.objectContaining({ message_id: "assistant-idle-history" }),
    ]);

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-idle-history",
        role: "assistant",
        parts: [{ type: "text", text: "Updated answer" }],
      },
    });
    await eventually(() => expect(reconciled).toHaveBeenCalledTimes(2));
    expect(reconciled).toHaveBeenLastCalledWith([
      expect.objectContaining({ message_id: "user-idle-history" }),
      expect.objectContaining({
        message_id: "assistant-idle-history",
        content: "Updated answer",
      }),
    ]);
  });

  it("keeps a server-completed run authoritative when local history reconciliation fails", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-reconcile-failure" },
      { type: "text-start", id: "text-reconcile-failure" },
      { type: "text-delta", id: "text-reconcile-failure", delta: "Server result" },
      { type: "text-end", id: "text-reconcile-failure" },
      completedPart("user-reconcile-failure"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const reconcileHistory = jest.fn(async () => {
      throw new Error("local history write failed");
    });
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      reconcileHistory,
    );

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-reconcile-failure",
      message: {
        id: "user-reconcile-failure",
        role: "user",
        parts: [{ type: "text", text: "Continue despite local cache failure" }],
      },
      approvalPolicy: {},
    })).resolves.toMatchObject({ kind: "completed" });

    expect(connection.cancel).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(1);
    expect(connection.lifecycleEvents).toContainEqual(expect.objectContaining({
      code: "history_sync_failed",
      phase: "persistence",
    }));
    expect(connection.lifecycleEvents).toContainEqual(expect.objectContaining({
      code: "run_finished_completed",
    }));
  });

  it("ignores every tool and terminal part after the next user-turn boundary", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-old-turn" },
      { type: "text-start", id: "text-old-turn" },
      { type: "text-delta", id: "text-old-turn", delta: "Still working" },
      { type: "text-end", id: "text-old-turn" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(async () => ({ success: true, data: { ignored: false } }));
    const { bridge, persisted } = createBridge(connection, execute);
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-old-turn",
      message: {
        id: "user-old-turn",
        role: "user",
        parts: [{ type: "text", text: "Old turn" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [
        {
          id: "user-old-turn",
          role: "user",
          parts: [{ type: "text", text: "Old turn" }],
        },
        {
          id: "assistant-old-turn",
          role: "assistant",
          parts: [{ type: "text", text: "Still working" }],
        },
        {
          id: "user-newer-turn",
          role: "user",
          parts: [{ type: "text", text: "Newer turn from another client" }],
        },
        {
          id: "assistant-newer-turn",
          role: "assistant",
          parts: [
            {
              type: "tool-read",
              toolCallId: "call-newer-turn",
              state: "input-available",
              input: { paths: ["MustNotRun.md"] },
            },
            completedPart("user-newer-turn"),
          ],
        },
      ],
    });
    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-newer-turn",
        role: "assistant",
        parts: [
          {
            type: "tool-read",
            toolCallId: "call-newer-turn",
            state: "input-available",
            input: { paths: ["MustNotRun.md"] },
          },
          completedPart("user-newer-turn"),
        ],
      },
    });
    await Promise.resolve();

    expect(execute).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
    expect(bridge.getSnapshot().status).not.toBe("completed");
    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("returns a thrown local tool error and lets the server decide how to continue", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-tool-throws" },
      {
        type: "tool-input-available",
        toolCallId: "call-tool-throws",
        toolName: "read",
        input: { paths: ["Throws.md"] },
      },
      { type: "finish", finishReason: "tool-calls" },
    ], [null, [
      { type: "text-start", id: "text-tool-error" },
      { type: "text-delta", id: "text-tool-error", delta: "I could not read that file." },
      { type: "text-end", id: "text-tool-error" },
      completedPart("user-tool-throws"),
      { type: "finish", finishReason: "stop" },
    ]]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(async () => {
      throw new Error("vault adapter unavailable");
    });
    const { bridge } = createBridge(connection, execute);

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-tool-throws",
      message: {
        id: "user-tool-throws",
        role: "user",
        parts: [{ type: "text", text: "Read it" }],
      },
      approvalPolicy: {},
    })).resolves.toMatchObject({ kind: "completed" });
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(transport.reconnects).toHaveLength(2);
    expect(connection.sentFrames).toContainEqual({
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: "call-tool-throws",
      toolName: "read",
      state: "output-error",
      errorText: "vault adapter unavailable",
    });
    expectLifecycleOrder(connection.lifecycleEvents, [
      "run_started",
      "local_tool_started",
      "local_tool_completed_failed",
      "tool_result_sent_failed",
      "response_resume_scheduled",
      "response_resume_started",
      "response_result_received_succeeded",
      "response_resume_completed",
      "response_save_started",
      "response_save_completed",
      "run_finished_completed",
    ]);
  });

  it("sends exactly one native tool result when local projection rejects it", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-tool-projection" },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(async () => ({
      success: true,
      data: { content: "Read once" },
    }));
    const { bridge } = createBridge(connection, execute);
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-tool-projection",
      message: {
        id: "user-tool-projection",
        role: "user",
        parts: [{ type: "text", text: "Read once" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));
    const addToolOutput = jest.fn(async () => {
      throw new Error("projection rejected tool output");
    });
    (bridge as any).chat.addToolOutput = addToolOutput;

    connection.emit({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-tool-projection",
        role: "assistant",
        parts: [{
          type: "tool-read",
          toolCallId: "call-tool-projection",
          state: "input-available",
          input: { paths: ["Once.md"] },
        }],
      },
    });

    await expect(run).resolves.toMatchObject({
      kind: "failed",
      error: { code: "tool_result_display_failed" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(addToolOutput).toHaveBeenCalledTimes(1);
    expect(connection.sentFrames.filter((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_RESULT)).toEqual([{
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: "call-tool-projection",
      toolName: "read",
      output: { success: true, data: { content: "Read once" } },
      state: "output-available",
    }]);
  });

  it("leaves lifecycle chronology at local_tool_started while an executor is hung", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-tool-hangs" },
      {
        type: "tool-input-available",
        toolCallId: "call-tool-hangs",
        toolName: "read",
        input: { paths: ["Hangs.md"] },
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(() => new Promise<any>(() => {}));
    const { bridge } = createBridge(connection, execute);
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-tool-hangs",
      message: {
        id: "user-tool-hangs",
        role: "user",
        parts: [{ type: "text", text: "Read it" }],
      },
      approvalPolicy: {},
    });

    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(connection.lifecycleEvents.at(-1)?.code).toBe("local_tool_started");
    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("reports a throwing projection subscriber as a terminal renderer failure", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const reportError = jest.fn();
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      undefined,
      undefined,
      reportError,
    );
    const observedStatuses: string[] = [];
    bridge.subscribe((snapshot) => observedStatuses.push(snapshot.status));
    bridge.subscribe(() => {
      throw new Error("renderer exploded");
    });

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-renderer-throws",
      message: {
        id: "user-renderer-throws",
        role: "user",
        parts: [{ type: "text", text: "Render this" }],
      },
      approvalPolicy: {},
    })).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "response_display_failed",
        message: "renderer exploded",
      },
    });
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(observedStatuses.filter((status) => status === "failed")).toHaveLength(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      code: "response_display_failed",
    }));
  });

  it("discards a stale terminal socket and bootstraps a clean replacement", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport);
    const { bridge } = createBridge(connection);
    const staleRun = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-stale-socket",
      message: {
        id: "user-stale-socket",
        role: "user",
        parts: [{ type: "text", text: "Old socket" }],
      },
      approvalPolicy: {},
    });
    await eventually(() => expect(transport.sent).toHaveLength(1));

    connection.closeWith(4001, "Replaced by newer executor socket");

    await expect(staleRun).resolves.toMatchObject({
      kind: "failed",
      error: {
        code: "session_interrupted",
        message: "The response was interrupted. Retry this message.",
      },
    });
    expect(connection.disconnect).toHaveBeenCalledTimes(1);

    transport.enqueueSend([
      { type: "start", messageId: "assistant-fresh-socket" },
      { type: "text-start", id: "text-fresh-socket" },
      { type: "text-delta", id: "text-fresh-socket", delta: "Fresh socket" },
      { type: "text-end", id: "text-fresh-socket" },
      completedPart("user-fresh-socket"),
      { type: "finish", finishReason: "stop" },
    ]);
    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-fresh-socket",
      message: {
        id: "user-fresh-socket",
        role: "user",
        parts: [{ type: "text", text: "Fresh socket" }],
      },
      approvalPolicy: {},
    })).resolves.toMatchObject({ kind: "completed" });
    expect(connection.connect).toHaveBeenCalledTimes(2);
  });

  it("reuses one official Chat across turns without projecting historical assistants", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-one" },
      { type: "text-start", id: "text-one" },
      { type: "text-delta", id: "text-one", delta: "First answer" },
      { type: "text-end", id: "text-one" },
      completedPart("user-one"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const { bridge, persisted } = createBridge(connection);

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-one",
      message: {
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "First" }],
      },
      approvalPolicy: "ask",
    })).resolves.toMatchObject({ kind: "completed" });

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [{
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "First" }],
      }, {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "First", state: "streaming" }],
      }],
    });
    await Promise.resolve();

    transport.enqueueSend([
      { type: "start", messageId: "assistant-two" },
      { type: "text-start", id: "text-two" },
      { type: "text-delta", id: "text-two", delta: "Second answer" },
      { type: "text-end", id: "text-two" },
      completedPart("user-two"),
      { type: "finish", finishReason: "stop" },
    ]);
    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-two",
      message: {
        id: "user-two",
        role: "user",
        parts: [{ type: "text", text: "Second" }],
      },
      approvalPolicy: "ask",
    })).resolves.toMatchObject({ kind: "completed" });

    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1].messages.map((message: UIMessage) => message.id))
      .toEqual(["user-one", "assistant-one", "user-two"]);
    expect(persisted.map((message) => message.content))
      .toEqual(["First answer", "Second answer"]);
    expect(bridge.getSnapshot().parts.some((part) =>
      part.kind === "text" && part.markdown === "First answer")).toBe(false);
  });

  it("hydrates authoritative history on reopen without submitting a turn", async () => {
    const history: UIMessage[] = [
      { id: "user-history", role: "user", parts: [{ type: "text", text: "Question" }] },
      { id: "assistant-history", role: "assistant", parts: [{ type: "text", text: "Answer" }] },
    ];
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport, history);
    const reconciled: any[][] = [];
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );

    await bridge.hydrate(CONVERSATION_ID);

    expect(transport.sent).toHaveLength(0);
    expect(reconciled.at(-1)?.map((message) => message.message_id))
      .toEqual(["user-history", "assistant-history"]);
    expect(reconciled.at(-1)?.[1]).toMatchObject({
      role: "assistant",
      content: "Answer",
    });
  });

  it("keeps current-turn assistants out of durable history while the live projection owns them", async () => {
    const history: UIMessage[] = [
      { id: "user-history", role: "user", parts: [{ type: "text", text: "Earlier" }] },
      {
        id: "assistant-history",
        role: "assistant",
        parts: [
          { type: "text", text: "Earlier answer" },
          completedPart("user-history"),
        ],
      },
    ];
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-current" },
      { type: "text-start", id: "text-current" },
      { type: "text-delta", id: "text-current", delta: "Still working" },
      { type: "text-end", id: "text-current" },
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport, history);
    const reconciled: any[][] = [];
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-current",
      message: {
        id: "user-current",
        role: "user",
        parts: [{ type: "text", text: "Current question" }],
      },
      approvalPolicy: "ask",
    });

    await eventually(() => expect(transport.sent).toHaveLength(1));
    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [
        ...history,
        {
          id: "user-current",
          role: "user",
          parts: [{ type: "text", text: "Current question" }],
        },
        {
          id: "assistant-current",
          role: "assistant",
          parts: [{ type: "text", text: "Still working", state: "done" }],
        },
      ],
    });
    await eventually(() =>
      expect(reconciled.at(-1)?.map((message) => message.message_id)).toEqual([
        "user-history",
        "assistant-history",
        "user-current",
      ]));
    expect(reconciled.flat().some((message) => message.message_id === "assistant-current"))
      .toBe(false);
    expect(bridge.getSnapshot().parts).toContainEqual(expect.objectContaining({
      kind: "text",
      messageId: "assistant-current",
      markdown: "Still working",
    }));

    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("preserves a native terminal update that arrives after strict history fetch", async () => {
    const history: UIMessage[] = [
      { id: "user-history", role: "user", parts: [{ type: "text", text: "Question" }] },
      { id: "assistant-history", role: "assistant", parts: [{ type: "text", text: "Stale" }] },
    ];
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport, history);
    connection.emitWhenReady({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-history",
        role: "assistant",
        parts: [
          { type: "text", text: "Fresh terminal answer" },
          completedPart("user-history"),
        ],
      },
    });
    const reconciled: any[][] = [];
    const { bridge, persisted } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );

    await bridge.hydrate(CONVERSATION_ID);

    await eventually(() => expect(persisted).toHaveLength(1));
    expect(reconciled.at(-1)?.map((message) => message.message_id))
      .toEqual(["user-history", "assistant-history"]);
    expect(reconciled.at(-1)?.[1]).toMatchObject({
      content: "Fresh terminal answer",
    });
    expect(persisted[0]).toMatchObject({
      message_id: "assistant-history",
      content: "Fresh terminal answer",
    });
  });

  it("rehydrates an input-available vault tool and completes without a new submit", async () => {
    const history: UIMessage[] = [
      { id: "user-recovery", role: "user", parts: [{ type: "text", text: "Read it" }] },
      {
        id: "assistant-recovery",
        role: "assistant",
        parts: [{
          type: "tool-read",
          toolCallId: "call-recovered-read",
          state: "input-available",
          input: { paths: ["Recovered.md"] },
        }],
      },
    ];
    const transport = new FakeTransport([], [null, [
      { type: "text-start", id: "recovered-text" },
      { type: "text-delta", id: "recovered-text", delta: "Recovered answer" },
      { type: "text-end", id: "recovered-text" },
      completedPart("user-recovery"),
      { type: "finish", finishReason: "stop" },
    ]]);
    const connection = new FakeConnection(transport, history);
    const execute = jest.fn(async () => ({
      success: true,
      data: { content: "Recovered" },
    }));
    const { bridge, persisted } = createBridge(connection, execute);

    await bridge.hydrate(CONVERSATION_ID);

    await eventually(() => expect(persisted).toHaveLength(1));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(transport.sent).toHaveLength(0);
    expect(transport.reconnects).toHaveLength(2);
    expect(persisted[0]).toMatchObject({
      role: "assistant",
      message_id: "assistant-recovery",
      content: "Recovered answer",
    });
  });

  it("rehydrates approval-requested mutation state and waits for the native server acknowledgement", async () => {
    const history: UIMessage[] = [
      { id: "user-recovery", role: "user", parts: [{ type: "text", text: "Write it" }] },
      {
        id: "assistant-recovery",
        role: "assistant",
        parts: [{
          type: "tool-write",
          toolCallId: "call-recovered-write",
          state: "approval-requested",
          input: { path: "Recovered.md", content: "Done" },
          approval: { id: "approval-recovered-write" },
        }],
      },
    ];
    const transport = new FakeTransport([], [null, [
      { type: "text-start", id: "recovered-write-text" },
      { type: "text-delta", id: "recovered-write-text", delta: "Write completed" },
      { type: "text-end", id: "recovered-write-text" },
      completedPart("user-recovery"),
      { type: "finish", finishReason: "stop" },
    ]]);
    const connection = new FakeConnection(transport, history);
    const execute = jest.fn(async () => ({
      success: true,
      data: { path: "Recovered.md" },
    }));
    const { bridge, persisted } = createBridge(connection, execute);

    await bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(bridge.getSnapshot()).toMatchObject({
      status: "waiting",
      waitingReason: "approval",
    }));
    expect(bridge.respondToApproval("approval-recovered-write", true)).toBe(true);
    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        callId: "call-recovered-write",
        state: "approved",
      }),
    ));
    expect(execute).not.toHaveBeenCalled();

    connection.emit({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      body: JSON.stringify({
        type: "tool-approval-response",
        approvalId: "approval-recovered-write",
        approved: true,
      }),
    });
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    await eventually(() => expect(persisted).toHaveLength(1));
    expect(transport.sent).toHaveLength(0);
    expect(connection.sentFrames).toContainEqual(expect.objectContaining({
      type: MessageType.CF_AGENT_TOOL_APPROVAL,
      toolCallId: "call-recovered-write",
      approved: true,
    }));
    expect(connection.sentFrames.some((frame) => "autoContinue" in frame)).toBe(false);
  });

  it("keeps a detached recovered turn authoritative when no stream is immediately available", async () => {
    const history: UIMessage[] = [
      {
        id: "user-detached",
        role: "user",
        parts: [{ type: "text", text: "This turn was detached" }],
      },
    ];
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-after-recovery" },
      { type: "text-start", id: "text-after-recovery" },
      { type: "text-delta", id: "text-after-recovery", delta: "New turn works" },
      { type: "text-end", id: "text-after-recovery" },
      completedPart("user-after-recovery"),
      { type: "finish", finishReason: "stop" },
    ], [null]);
    const connection = new FakeConnection(transport, history);
    const { bridge } = createBridge(connection);

    await bridge.hydrate(CONVERSATION_ID);

    expect(bridge.getSnapshot()).toMatchObject({
      status: "running",
      turnId: "user-detached",
    });
    expect(connection.cancel).not.toHaveBeenCalled();
    await bridge.cancel();
    await Promise.resolve();
    expect(connection.cancel).toHaveBeenCalledTimes(1);

    await expect(bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-after-recovery",
      message: {
        id: "user-after-recovery",
        role: "user",
        parts: [{ type: "text", text: "Try a new turn" }],
      },
      approvalPolicy: {},
    })).resolves.toMatchObject({ kind: "completed" });
  });

  it("repairs final history after reconnect without resubmitting", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-current" },
      { type: "text-start", id: "text-current" },
      { type: "text-delta", id: "text-current", delta: "Initial" },
      { type: "text-end", id: "text-current" },
      completedPart("user-current"),
      { type: "finish", finishReason: "stop" },
    ]);
    const connection = new FakeConnection(transport);
    const reconciled: any[][] = [];
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );
    await bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-current",
      message: {
        id: "user-current",
        role: "user",
        parts: [{ type: "text", text: "Question" }],
      },
      approvalPolicy: "ask",
    });

    connection.emit({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [
        { id: "user-current", role: "user", parts: [{ type: "text", text: "Question" }] },
        { id: "assistant-current", role: "assistant", parts: [{ type: "text", text: "Recovered final" }] },
      ],
    });
    await eventually(() =>
      expect(reconciled.at(-1)?.[1]?.content).toBe("Recovered final"));

    expect(transport.sent).toHaveLength(1);
  });

  it("replaces the official Chat when the bound conversation changes", async () => {
    const transport = new FakeTransport([]);
    const connection = new FakeConnection(transport, []);
    const reconciled: any[][] = [];
    const { bridge } = createBridge(
      connection,
      undefined,
      undefined,
      async (messages) => {
        reconciled.push([...messages]);
      },
    );
    await bridge.hydrate(CONVERSATION_ID);
    connection.setInitialHistory([
      { id: "user-other", role: "user", parts: [{ type: "text", text: "Other" }] },
    ]);
    await bridge.hydrate("conversation_abcdef0123456789abcdef0123456789");

    expect(connection.connect).toHaveBeenCalledTimes(2);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(reconciled.at(-1)?.map((message) => message.message_id))
      .toEqual(["user-other"]);
  });

  it("runs more than thirty client tools in parallel and resumes exactly once", async () => {
    const toolChunks = Array.from({ length: 32 }, (_, index) => ({
      type: "tool-input-available" as const,
      toolCallId: `call-${index}`,
      toolName: "read",
      input: { paths: [`Note-${index}.md`] },
    }));
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-tools" },
      ...toolChunks,
      { type: "finish", finishReason: "tool-calls" },
    ], [null, [
      { type: "text-start", id: "final-text" },
      { type: "text-delta", id: "final-text", delta: "Finished all reads." },
      { type: "text-end", id: "final-text" },
      completedPart("user-tools"),
      { type: "finish", finishReason: "stop" },
    ]]);
    const connection = new FakeConnection(transport);
    let activeExecutions = 0;
    let maximumParallel = 0;
    let releaseExecutions: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
      releaseExecutions = resolve;
    });
    const execute = jest.fn(async () => {
      activeExecutions += 1;
      maximumParallel = Math.max(maximumParallel, activeExecutions);
      if (activeExecutions === 32) releaseExecutions();
      await allStarted;
      activeExecutions -= 1;
      return { success: true, data: { found: true } };
    });
    const { bridge } = createBridge(connection, execute);

    const result = await bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-tools",
      message: {
        id: "user-tools",
        role: "user",
        parts: [{ type: "text", text: "Read everything" }],
      },
      approvalPolicy: "ask",
    });

    expect(result.kind).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(32);
    expect(maximumParallel).toBeGreaterThan(1);
    expect(connection.sentFrames.filter((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_RESULT)).toHaveLength(32);
    expect(connection.sentFrames.some((frame) => "autoContinue" in frame)).toBe(false);
    expect(transport.expectToolContinuation).toHaveBeenCalledTimes(1);
    expect(transport.reconnects).toHaveLength(2);
  });

  it("returns mutation outcome unknown after receipt failure and never duplicates execution", async () => {
    const transport = new FakeTransport([
      { type: "start", messageId: "assistant-write" },
      {
        type: "tool-input-available",
        toolCallId: "call-write",
        toolName: "write",
        input: { path: "Plan.md", content: "Done" },
      },
      { type: "tool-approval-request", approvalId: "approval-write", toolCallId: "call-write" },
      { type: "finish", finishReason: "tool-calls" },
    ], [null]);
    const connection = new FakeConnection(transport);
    const execute = jest.fn(async () => ({ success: true, data: { path: "Plan.md" } }));
    const journal = {
      claim: jest.fn(async () => ({ kind: "execute" })),
      complete: jest.fn(async () => {
        throw new Error("disk full");
      }),
      idle: jest.fn(async () => {}),
    };
    const { bridge } = createBridge(connection, execute, journal);
    const run = bridge.start({
      conversationId: CONVERSATION_ID,
      turnId: "user-write",
      message: {
        id: "user-write",
        role: "user",
        parts: [{ type: "text", text: "Write it" }],
      },
      approvalPolicy: "ask",
    });
    await eventually(() =>
      expect(bridge.getSnapshot().parts.some((part) =>
        part.kind === "tool" && part.approvalId === "approval-write")).toBe(true));
    expect(bridge.respondToApproval("approval-write", true)).toBe(true);
    await eventually(() => expect(bridge.getSnapshot().parts).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        callId: "call-write",
        state: "approved",
      }),
    ));
    expect(execute).not.toHaveBeenCalled();

    connection.emit({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      body: JSON.stringify({
        type: "tool-approval-response",
        approvalId: "approval-write",
        approved: true,
      }),
    });
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    await eventually(() => expect(connection.sentFrames.some((frame) =>
      frame.type === MessageType.CF_AGENT_TOOL_RESULT
      && frame.output?.error?.code === "TOOL_MUTATION_OUTCOME_UNKNOWN")).toBe(true));
    const diagnostic = connection.sentFrames.find((frame) =>
      frame.type === "systemsculpt.client_diagnostic.v1");
    expect(diagnostic).toEqual({
      type: "systemsculpt.client_diagnostic.v1",
      payload: {
        version: 1,
        severity: "error",
        code: "tool_mutation_outcome_unknown",
        phase: "mutation_journal",
        run_id: "run-local",
        tool_name: "write",
        tool_call_id: "call-write",
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("Plan.md");
    expect(JSON.stringify(diagnostic)).not.toContain("disk full");

    connection.emit({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      body: JSON.stringify({
        type: "tool-approval-response",
        approvalId: "approval-write",
        approved: true,
      }),
    });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    await bridge.cancel();
    await expect(run).resolves.toMatchObject({ kind: "cancelled" });
  });
});
