import {
  THIN_AGENT_COMMAND_TYPE,
  parseAgentCommand,
  parseAgentServerEvent,
  type AgentApprovalCommand as ProtocolApprovalCommand,
  type AgentCancelCommand as ProtocolCancelCommand,
  type AgentCommandAckEvent as ProtocolCommandAckEvent,
  type AgentCommand as ProtocolCommand,
  type AgentJsonValue,
  type AgentKnownRunState,
  type AgentQueueSnapshotEvent,
  type AgentRegenerateCommand,
  type AgentServerEvent,
  type AgentSubmitCommand as ProtocolSubmitCommand,
  type AgentTerminalEvent,
  type AgentToolResultCommand as ProtocolToolResultCommand,
  type AgentUserMessage,
} from "./Protocol";
/**
 * The synchronization states for the authoritative session.
 *
 * `open` means that the client accepted a current server snapshot. A failed
 * request returns the state to `closed` until a new snapshot restores it.
 */
export type AgentConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "closed";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const RUN_ID = /^run_[a-f0-9]{32}$/u;

type AgentMessageBase = Readonly<{
  id: string;
  role: string;
}>;

export type AgentAuthoritativeRunState =
  AgentKnownRunState;

export type AgentUnknownRunState = Readonly<{
  version: 1;
  cursor: number | null;
  state: "unknown";
  busy: true;
  reason:
    | "awaiting_session_snapshot"
    | "missing_run_state"
    | "invalid_run_state"
    | "run_state_conflict"
    | "transport_not_ready"
    | "protocol_error";
}>;

export type AgentVisibleRunState =
  | AgentAuthoritativeRunState
  | AgentUnknownRunState;

export type AgentTerminal =
  AgentTerminalEvent["terminal"];
export type AgentAuthoritativeEvent =
  AgentServerEvent;
export type AgentSubmitCommand =
  | ProtocolSubmitCommand
  | AgentRegenerateCommand;
export type AgentToolResultCommand =
  ProtocolToolResultCommand;
export type AgentApprovalCommand = ProtocolApprovalCommand;
export type AgentCancelCommand = ProtocolCancelCommand;
export type AgentCommandAckEvent = ProtocolCommandAckEvent;

export type AgentConnectionPort = Readonly<{
  state: AgentConnectionState;
  addAuthoritativeFrameListener: (
    listener: (frame: AgentServerEvent) => void,
  ) => () => void;
  addConnectionStateListener: (
    listener: (state: AgentConnectionState) => void,
  ) => () => void;
  sendSubmit: (
    command: AgentSubmitCommand,
  ) => void | Promise<void>;
  sendToolResult: (
    command: AgentToolResultCommand,
  ) => void | Promise<void>;
  sendApproval: (
    command: AgentApprovalCommand,
  ) => void | Promise<void>;
  sendCancel: (
    command: AgentCancelCommand,
  ) => void | Promise<void>;
}>;

export type AgentOptimisticUser = Readonly<{
  kind: "optimistic_pending_user";
  request_id: string;
  message: AgentUserMessage;
  delivery: "queued" | "sending" | "sent";
}>;

export type AgentSessionSnapshot<
  TMessage extends AgentMessageBase,
> = Readonly<{
  revision: number;
  messages: readonly TMessage[];
  runState: AgentVisibleRunState;
  terminal: Readonly<{
    request_id: string;
    value: AgentTerminal;
  }> | null;
  queuedRequestIds: readonly string[];
  cancelledQueuedRequestIds: readonly string[];
  optimisticUser: AgentOptimisticUser | null;
}>;

export type AgentSessionErrorCode =
  | "invalid_command"
  | "pending_user_exists"
  | "run_state_busy"
  | "run_identity_mismatch"
  | "session_disposed";

export class AgentSessionError extends Error {
  constructor(
    public readonly code: AgentSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
}

export type AgentSessionOptions<
  TMessage extends AgentMessageBase,
> = Readonly<{
  conversationId: string;
  connection: AgentConnectionPort;
  isAuthoritativeMessage: (value: unknown) => value is TMessage;
  onProtocolError?: (error: Error) => void;
  onCommandError?: (error: Error) => void;
  onCommandAck?: (ack: AgentCommandAckEvent) => void;
  onQueueSnapshot?: (snapshot: AgentQueueSnapshotEvent) => void;
}>;

type PendingSubmit = {
  command: ProtocolSubmitCommand;
  delivery: "queued" | "sending" | "sent";
};

type RunStateResult = "applied" | "idempotent" | "stale" | "conflict";
type ActiveRunState = Extract<
  AgentAuthoritativeRunState,
  { state: "running" | "waiting_for_client" }
>;

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}

function knownRunState(
  value: AgentKnownRunState | Readonly<{
    version: 1 | null;
    cursor: number | null;
    state: "unknown";
  }>,
): AgentAuthoritativeRunState | null {
  if (value.state === "idle") return value;
  if (
    (value.state === "running" || value.state === "waiting_for_client")
    && safeId(value.request_id)
    && safeRunId(value.run_id)
    && safeId(value.root_message_id)
  ) return value;
  return null;
}

function sameRunState(
  left: AgentAuthoritativeRunState,
  right: AgentAuthoritativeRunState,
): boolean {
  if (left.version !== right.version
    || left.cursor !== right.cursor
    || left.state !== right.state) return false;
  if (left.state === "idle" || right.state === "idle") {
    return left.state === right.state;
  }
  return left.request_id === right.request_id
    && left.run_id === right.run_id
    && left.root_message_id === right.root_message_id;
}

function command<TKind extends ProtocolCommand["kind"]>(
  value: unknown,
  expectedKind: TKind,
): Extract<ProtocolCommand, { kind: TKind }> {
  try {
    const parsed = parseAgentCommand(value);
    if (parsed.kind !== expectedKind) throw new TypeError("Command kind changed.");
    return parsed as Extract<ProtocolCommand, { kind: TKind }>;
  } catch (error) {
    throw new AgentSessionError(
      "invalid_command",
      error instanceof Error ? error.message : "The client command is invalid.",
    );
  }
}

function unknownRunState(
  reason: AgentUnknownRunState["reason"],
  cursor: number | null,
): AgentUnknownRunState {
  return Object.freeze({ version: 1, cursor, state: "unknown", busy: true, reason });
}

function cloneAndFreeze<TValue>(value: TValue): TValue {
  const cloned = structuredClone(value);
  if (cloned === null || typeof cloned !== "object") return cloned;
  const pending: object[] = [cloned as object];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return cloned;
}

function frozenMessages<TMessage>(messages: readonly TMessage[]): readonly TMessage[] {
  return Object.freeze(messages.map((message) => cloneAndFreeze(message)));
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error("The client command failed.");
}

function currentDelivery(pending: PendingSubmit): PendingSubmit["delivery"] {
  return pending.delivery;
}

function sameAuthoritativeUserMessage(
  value: unknown,
  expected: AgentUserMessage,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const candidateParts = candidate.parts;
  if (
    candidate.id !== expected.id
    || candidate.role !== "user"
    || !Array.isArray(candidateParts)
    || candidateParts.length !== expected.parts.length
  ) return false;
  return expected.parts.every((expectedPart, index) => {
    const actualPart = candidateParts[index];
    if (!actualPart || typeof actualPart !== "object" || Array.isArray(actualPart)) {
      return false;
    }
    const actual = actualPart as Record<string, unknown>;
    if (expectedPart.type === "text") {
      return actual.type === "text" && actual.text === expectedPart.text;
    }
    return actual.type === "file"
      && actual.mediaType === expectedPart.mediaType
      && actual.url === expectedPart.url
      && actual.filename === expectedPart.filename;
  });
}

export class AgentSession<
  TMessage extends AgentMessageBase,
> {
  private readonly listeners = new Set<(
    snapshot: AgentSessionSnapshot<TMessage>,
  ) => void>();
  private readonly detachFrameListener: () => void;
  private readonly detachConnectionStateListener: () => void;
  private messages: readonly TMessage[] = Object.freeze([]);
  private runState: AgentVisibleRunState = unknownRunState(
    "awaiting_session_snapshot",
    null,
  );
  private authoritativeRunState: AgentAuthoritativeRunState | null = null;
  private terminal: AgentSessionSnapshot<TMessage>["terminal"] = null;
  private queuedRequestIds: readonly string[] = Object.freeze([]);
  private cancelledQueuedRequestIds: readonly string[] = Object.freeze([]);
  private pendingSubmit: PendingSubmit | null = null;
  private revision = 0;
  private disposed = false;
  private hasSessionSnapshot = false;
  private conflictedCursor: number | null = null;
  private awaitingTerminalRun: ActiveRunState | null = null;
  private queuedDispatch: Promise<"sent" | "queued"> | null = null;
  private queuedPromotionRequested = false;

  constructor(private readonly options: AgentSessionOptions<TMessage>) {
    if (!safeId(options.conversationId)) {
      throw new AgentSessionError(
        "invalid_command",
        "The conversation identity is invalid.",
      );
    }
    this.detachFrameListener = options.connection.addAuthoritativeFrameListener(
      (frame) => this.handleAuthoritativeFrame(frame),
    );
    this.detachConnectionStateListener =
      options.connection.addConnectionStateListener(
        (state) => this.handleConnectionState(state),
      );
  }

  public get current(): AgentSessionSnapshot<TMessage> {
    return this.snapshot();
  }

  public subscribe(
    listener: (snapshot: AgentSessionSnapshot<TMessage>) => void,
  ): () => void {
    this.assertAvailable();
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachFrameListener();
    this.detachConnectionStateListener();
    this.listeners.clear();
  }

  public async submit(input: Readonly<{
    request_id: string;
    user_message: AgentUserMessage;
    context_ref?: string;
  }>): Promise<"sent" | "queued"> {
    this.assertAvailable();
    if (this.pendingSubmit) {
      throw new AgentSessionError(
        "pending_user_exists",
        "One user message is already pending server authority.",
      );
    }
    const parsed = command({
      type: THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "submit",
      request_id: input.request_id,
      user_message: input.user_message,
      ...(input.context_ref === undefined ? {} : { context_ref: input.context_ref }),
    }, "submit");
    this.pendingSubmit = {
      command: parsed,
      delivery: this.readyForSubmit() ? "sending" : "queued",
    };
    this.publish();
    if (!this.readyForSubmit()) return "queued";
    return this.startPendingDispatch(true);
  }

  public async regenerate(input: Readonly<{
    request_id: string;
    root_message_id: string;
  }>): Promise<void> {
    this.assertIdleCommand(input.request_id);
    await this.options.connection.sendSubmit(command({
      type: THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "regenerate",
      request_id: input.request_id,
      root_message_id: input.root_message_id,
    }, "regenerate"));
  }

  public async sendToolResult(input:
    | Readonly<{
        request_id: string;
        tool_call_id: string;
        tool_name: string;
        state: "output-available";
        output: AgentJsonValue;
      }>
    | Readonly<{
        request_id: string;
        tool_call_id: string;
        tool_name: string;
        state: "output-error";
        error_text: string;
      }>): Promise<void> {
    this.assertWaitingCommand(input.request_id);
    const parsed = input.state === "output-available"
      ? command({
          type: THIN_AGENT_COMMAND_TYPE,
          version: 1,
          kind: "client_tool_result",
          request_id: input.request_id,
          tool_call_id: input.tool_call_id,
          tool_name: input.tool_name,
          state: "output-available",
          output: input.output,
        }, "client_tool_result")
      : command({
          type: THIN_AGENT_COMMAND_TYPE,
          version: 1,
          kind: "client_tool_result",
          request_id: input.request_id,
          tool_call_id: input.tool_call_id,
          tool_name: input.tool_name,
          state: "output-error",
          error_text: input.error_text,
        }, "client_tool_result");
    await this.options.connection.sendToolResult(parsed);
  }

  public async sendToolApproval(input: Readonly<{
    request_id: string;
    tool_call_id: string;
    approved: boolean;
  }>): Promise<void> {
    this.assertWaitingCommand(input.request_id);
    await this.options.connection.sendApproval(command({
      type: THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_approval",
      request_id: input.request_id,
      tool_call_id: input.tool_call_id,
      approved: input.approved,
    }, "client_tool_approval"));
  }

  public async cancel(input: Readonly<{
    request_id: string;
    queued?: boolean;
  }>): Promise<void> {
    if (input.queued) {
      this.assertAvailable();
      if (!safeId(input.request_id)) {
        throw new AgentSessionError(
          "invalid_command",
          "The queued cancellation request identity is invalid.",
        );
      }
    } else {
      this.assertActiveCommand(input.request_id);
    }
    await this.options.connection.sendCancel(command({
      type: THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "cancel",
      request_id: input.request_id,
    }, "cancel"));
  }

  private handleAuthoritativeFrame(frame: unknown): void {
    if (this.disposed) return;
    let parsed: AgentServerEvent;
    try {
      parsed = parseAgentServerEvent(
        frame,
        this.options.conversationId,
      );
    } catch {
      this.protocolError("SystemSculpt returned an invalid session event.");
      return;
    }
    if (parsed.kind === "unknown") return;
    if (parsed.kind === "session_snapshot") {
      this.handleSessionSnapshot(parsed);
      return;
    }
    if (!this.hasSessionSnapshot) {
      this.protocolError("SystemSculpt sent an event before the session snapshot.");
      return;
    }
    if (parsed.kind === "assistant_snapshot") {
      this.handleAssistantSnapshot(parsed);
    } else if (parsed.kind === "run_state") {
      this.handleRunState(parsed.run_state);
    } else if (parsed.kind === "terminal") {
      this.handleTerminal(parsed);
    } else if (parsed.kind === "queue_snapshot") {
      try {
        this.options.onQueueSnapshot?.(parsed);
      } catch {
        // Queue observers cannot mutate session authority.
      }
    } else if (parsed.kind === "command_ack") {
      try {
        this.options.onCommandAck?.(parsed);
      } catch {
        // Delivery acknowledgement observers cannot mutate session authority.
      }
    }
  }

  private handleSessionSnapshot(
    frame: Extract<AgentServerEvent, { kind: "session_snapshot" }>,
  ): void {
    const incomingMessages = frame.messages;
    if (!Array.isArray(incomingMessages)
      || !incomingMessages.every(this.options.isAuthoritativeMessage)
      || new Set(incomingMessages.map((message) => message.id)).size
        !== incomingMessages.length) {
      this.protocolError("SystemSculpt returned invalid authoritative messages.");
      return;
    }
    this.hasSessionSnapshot = true;
    this.messages = frozenMessages(incomingMessages);
    this.queuedRequestIds = Object.freeze([...frame.queued_request_ids]);
    this.cancelledQueuedRequestIds = Object.freeze([
      ...frame.cancelled_queued_request_ids,
    ]);
    this.terminal = null;
    this.awaitingTerminalRun = null;
    if (!this.reconcileOptimisticUser()) return;
    const parsedRunState = knownRunState(frame.run_state);
    if (!parsedRunState) {
      this.authoritativeRunState = null;
      this.conflictedCursor = null;
      this.setUnknownRunState("missing_run_state");
      return;
    }
    const result = this.applyRunState(parsedRunState);
    if (result !== "conflict") this.publish();
    if (result !== "conflict" && result !== "stale"
      && parsedRunState.state === "idle") {
      this.promoteQueuedSubmit();
    }
  }

  private handleAssistantSnapshot(
    frame: Extract<AgentServerEvent, { kind: "assistant_snapshot" }>,
  ): void {
    if (!this.options.isAuthoritativeMessage(frame.message)
      || frame.message.role !== "assistant") {
      this.protocolError("SystemSculpt returned an invalid assistant snapshot.");
      return;
    }
    const active = this.authoritativeRunState;
    if (!active || active.state === "idle" || active.request_id !== frame.request_id) {
      this.protocolError("The assistant snapshot does not match the active run.");
      return;
    }
    const message = cloneAndFreeze(frame.message);
    const existingIndex = this.messages.findIndex((candidate) => candidate.id === message.id);
    if (existingIndex >= 0 && this.messages[existingIndex]?.role !== "assistant") {
      this.protocolError("The assistant snapshot reuses a non-assistant message identity.");
      return;
    }
    this.messages = Object.freeze(existingIndex < 0
      ? [...this.messages, message]
      : this.messages.map((candidate, index) => index === existingIndex ? message : candidate));
    this.publish();
  }

  private handleRunState(
    value: Extract<AgentServerEvent, { kind: "run_state" }>["run_state"],
  ): void {
    const parsed = knownRunState(value);
    if (!parsed) {
      this.protocolError(
        "SystemSculpt returned an invalid authoritative run state.",
        "invalid_run_state",
      );
      return;
    }
    const result = this.applyRunState(parsed);
    if (result === "applied") {
      this.publish();
    }
    if (result !== "conflict" && result !== "stale" && parsed.state === "idle") {
      this.promoteQueuedSubmit();
    }
  }

  private handleTerminal(
    frame: Extract<AgentServerEvent, { kind: "terminal" }>,
  ): void {
    const terminal = frame.terminal;
    const authoritative = this.authoritativeRunState;
    const correlatedRun = authoritative?.state === "running"
      || authoritative?.state === "waiting_for_client"
      ? authoritative
      : this.awaitingTerminalRun;
    if (!correlatedRun
      || correlatedRun.request_id !== frame.request_id
      || correlatedRun.run_id !== terminal.run_id
      || correlatedRun.root_message_id !== terminal.root_message_id) {
      if (this.terminal?.request_id === frame.request_id
        && this.terminal.value.run_id === terminal.run_id
        && this.terminal.value.root_message_id === terminal.root_message_id) {
        return;
      }
      this.protocolError("The terminal event does not match the active run.");
      return;
    }
    this.terminal = Object.freeze({
      request_id: frame.request_id,
      value: terminal,
    });
    this.awaitingTerminalRun = null;
    this.publish();
  }

  private handleConnectionState(state: AgentConnectionState): void {
    if (this.disposed) return;
    if (state !== "open") {
      this.hasSessionSnapshot = false;
      this.awaitingTerminalRun = null;
      if (this.pendingSubmit) this.pendingSubmit.delivery = "queued";
      this.runState = unknownRunState(
        "transport_not_ready",
        this.authoritativeRunState?.cursor ?? null,
      );
      this.publish();
      return;
    }
    const authoritative = this.authoritativeRunState;
    if (!this.hasSessionSnapshot || !authoritative) {
      this.runState = unknownRunState("awaiting_session_snapshot", null);
      this.publish();
      return;
    }
    if (this.conflictedCursor === authoritative.cursor) return;
    this.runState = authoritative;
    this.publish();
    if (authoritative.state === "idle") this.promoteQueuedSubmit();
  }

  private applyRunState(
    incoming: AgentAuthoritativeRunState,
  ): RunStateResult {
    const current = this.authoritativeRunState;
    if (current && incoming.cursor < current.cursor) return "stale";
    if (current && incoming.cursor === current.cursor) {
      if (!sameRunState(current, incoming)) {
        this.conflictedCursor = incoming.cursor;
        this.protocolError(
          "SystemSculpt returned conflicting state for one session cursor.",
          "run_state_conflict",
        );
        return "conflict";
      }
      if (this.conflictedCursor === incoming.cursor) return "conflict";
      if (this.runState.state === "unknown") {
        this.runState = this.options.connection.state === "open"
          ? current
          : unknownRunState("transport_not_ready", current.cursor);
        return "applied";
      }
      return "idempotent";
    }
    const previousActive = current?.state === "running"
      || current?.state === "waiting_for_client"
      ? current
      : null;
    this.authoritativeRunState = incoming;
    this.runState = this.options.connection.state === "open"
      ? incoming
      : unknownRunState("transport_not_ready", incoming.cursor);
    this.conflictedCursor = null;
    if (incoming.state !== "idle") {
      this.awaitingTerminalRun = null;
      if (this.terminal?.request_id !== incoming.request_id) this.terminal = null;
      if (this.pendingSubmit?.command.request_id === incoming.request_id) {
        this.pendingSubmit.delivery = "sent";
      }
    } else if (previousActive) {
      const terminalAlreadyReceived = this.terminal?.request_id
        === previousActive.request_id
        && this.terminal.value.run_id === previousActive.run_id
        && this.terminal.value.root_message_id === previousActive.root_message_id;
      this.awaitingTerminalRun = terminalAlreadyReceived ? null : previousActive;
    }
    return "applied";
  }

  private setUnknownRunState(
    reason: AgentUnknownRunState["reason"],
  ): void {
    this.runState = unknownRunState(
      reason,
      this.authoritativeRunState?.cursor ?? null,
    );
    this.publish();
  }

  private protocolError(
    message: string,
    reason: AgentUnknownRunState["reason"] = "protocol_error",
  ): void {
    this.runState = unknownRunState(
      reason,
      this.authoritativeRunState?.cursor ?? null,
    );
    const error = new Error(message);
    try {
      this.options.onProtocolError?.(error);
    } catch {
      // Diagnostics must never alter session authority.
    }
    this.publish();
  }

  private reconcileOptimisticUser(): boolean {
    const pending = this.pendingSubmit;
    if (!pending) return true;
    const authoritative = this.messages.find((message) =>
      message.id === pending.command.user_message.id);
    if (!authoritative) return true;
    if (!sameAuthoritativeUserMessage(
      authoritative,
      pending.command.user_message,
    )) {
      this.protocolError(
        "The authoritative user message conflicts with the pending submission.",
      );
      return false;
    }
    this.pendingSubmit = null;
    return true;
  }

  private promoteQueuedSubmit(): void {
    if (!this.pendingSubmit || this.pendingSubmit.delivery !== "queued") return;
    if (!this.readyForSubmit()) return;
    if (this.queuedDispatch) {
      this.queuedPromotionRequested = true;
      return;
    }
    this.queuedPromotionRequested = false;
    void this.startPendingDispatch(false)
      .catch((error: unknown) => {
        try {
          this.options.onCommandError?.(errorValue(error));
        } catch {
          // Command diagnostics are observational only.
        }
      });
  }

  private startPendingDispatch(
    rethrow: boolean,
  ): Promise<"sent" | "queued"> {
    if (this.queuedDispatch) {
      this.queuedPromotionRequested = true;
      return this.queuedDispatch;
    }
    const operation = Promise.resolve()
      .then(() => this.dispatchPendingSubmit(rethrow));
    let tracked!: Promise<"sent" | "queued">;
    tracked = operation.finally(() => {
      if (this.queuedDispatch !== tracked) return;
      const retry = this.queuedPromotionRequested;
      this.queuedPromotionRequested = false;
      this.queuedDispatch = null;
      if (retry && this.pendingSubmit?.delivery === "queued") {
        this.promoteQueuedSubmit();
      }
    });
    this.queuedDispatch = tracked;
    return tracked;
  }

  private async dispatchPendingSubmit(
    rethrow: boolean,
  ): Promise<"sent" | "queued"> {
    const pending = this.pendingSubmit;
    if (!pending || pending.delivery === "sent") return "sent";
    if (!this.readyForSubmit()) {
      if (pending.delivery !== "queued") {
        pending.delivery = "queued";
        this.publish();
      }
      return "queued";
    }
    if (pending.delivery !== "sending") {
      pending.delivery = "sending";
      this.publish();
    }
    try {
      await this.options.connection.sendSubmit(pending.command);
      if (this.pendingSubmit !== pending) return "sent";
      const delivery = currentDelivery(pending);
      if (delivery === "queued"
        || this.options.connection.state !== "open") {
        if (delivery !== "queued") {
          pending.delivery = "queued";
          this.publish();
        }
        return "queued";
      }
      if (delivery !== "sent") {
        pending.delivery = "sent";
        this.publish();
      }
      return "sent";
    } catch (error) {
      const retryWhenReady = pending.delivery === "queued"
        || this.options.connection.state !== "open"
        || (
          error !== null
          && typeof error === "object"
          && "code" in error
          && (error as { code?: unknown }).code === "session_not_ready"
        );
      if (retryWhenReady && this.pendingSubmit === pending) {
        pending.delivery = "queued";
        this.publish();
        return "queued";
      }
      if (this.pendingSubmit === pending) {
        this.pendingSubmit = null;
        this.publish();
      }
      if (rethrow) throw error;
      throw errorValue(error);
    }
  }

  private readyForSubmit(): boolean {
    return this.options.connection.state === "open"
      && this.runState.state === "idle";
  }

  private assertIdleCommand(requestId: string): void {
    this.assertAvailable();
    if (!safeId(requestId)) {
      throw new AgentSessionError(
        "invalid_command",
        "The request identity is invalid.",
      );
    }
    if (this.runState.state !== "idle") {
      throw new AgentSessionError(
        "run_state_busy",
        "The authoritative session is not idle.",
      );
    }
    if (this.pendingSubmit) {
      throw new AgentSessionError(
        "pending_user_exists",
        "One user message is already pending server authority.",
      );
    }
  }

  private assertActiveCommand(requestId: string): void {
    this.assertAvailable();
    const active = this.authoritativeRunState;
    if (!safeId(requestId)) {
      throw new AgentSessionError(
        "invalid_command",
        "The request identity is invalid.",
      );
    }
    if (!active || active.state === "idle" || this.runState.state === "unknown") {
      throw new AgentSessionError(
        "run_state_busy",
        "The authoritative active run is unavailable.",
      );
    }
    if (active.request_id !== requestId) {
      throw new AgentSessionError(
        "run_identity_mismatch",
        "The command does not match the authoritative active run.",
      );
    }
  }

  private assertWaitingCommand(requestId: string): void {
    this.assertActiveCommand(requestId);
    if (this.runState.state !== "waiting_for_client") {
      throw new AgentSessionError(
        "run_state_busy",
        "The authoritative run is not waiting for a client tool action.",
      );
    }
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new AgentSessionError(
        "session_disposed",
        "This SystemSculpt session is closed.",
      );
    }
  }

  private publish(): void {
    if (this.disposed) return;
    this.revision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A presentation observer cannot mutate session authority.
      }
    }
  }

  private snapshot(): AgentSessionSnapshot<TMessage> {
    const pending = this.pendingSubmit;
    return Object.freeze({
      revision: this.revision,
      messages: this.messages,
      runState: this.runState,
      terminal: this.terminal,
      queuedRequestIds: this.queuedRequestIds,
      cancelledQueuedRequestIds: this.cancelledQueuedRequestIds,
      optimisticUser: pending
        ? Object.freeze({
            kind: "optimistic_pending_user" as const,
            request_id: pending.command.request_id,
            message: pending.command.user_message,
            delivery: pending.delivery,
          })
        : null,
    });
  }
}
