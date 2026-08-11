import {
  AgentSession,
  AgentSessionError,
  type AgentApprovalCommand,
  type AgentAuthoritativeEvent,
  type AgentCancelCommand,
  type AgentCommandAckEvent,
  type AgentConnectionPort,
  type AgentConnectionState,
  type AgentSubmitCommand,
  type AgentToolResultCommand,
} from "../AuthoritativeSession";

type Message = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly Readonly<{
    type: "text";
    text: string;
  }>[];
}>;

const CONVERSATION_ID = "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_A = `run_${"a".repeat(32)}`;
const RUN_B = `run_${"b".repeat(32)}`;
const CONTEXT_REF = `ctx1_${"a".repeat(43)}.${"b".repeat(43)}`;

function message(
  id: string,
  role: "user",
  text: string,
): Message & Readonly<{ role: "user" }>;
function message(
  id: string,
  role: "assistant",
  text: string,
): Message & Readonly<{ role: "assistant" }>;
function message(
  id: string,
  role: Message["role"],
  text: string,
): Message {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  };
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && (candidate.role === "user" || candidate.role === "assistant")
    && Array.isArray(candidate.parts);
}

function idle(cursor: number) {
  return { version: 1 as const, cursor, state: "idle" as const };
}

function active(
  cursor: number,
  state: "running" | "waiting_for_client",
  requestId = "request_active",
  runId = RUN_A,
  rootMessageId = "user_active",
) {
  return {
    version: 1 as const,
    cursor,
    state,
    request_id: requestId,
    run_id: runId,
    root_message_id: rootMessageId,
  };
}

function event<T extends Record<string, unknown>>(
  kind: string,
  fields: T,
): Record<string, unknown> & T {
  return {
    type: "systemsculpt.agent.event.v1",
    version: 1,
    kind,
    conversation_id: CONVERSATION_ID,
    ...fields,
  };
}

class FakeConnection implements AgentConnectionPort {
  public state: AgentConnectionState = "open";
  private listener: ((frame: AgentAuthoritativeEvent) => void) | null = null;
  private stateListener: ((state: AgentConnectionState) => void) | null = null;

  public readonly sendSubmit = jest.fn<
    Promise<void>,
    [AgentSubmitCommand]
  >(async () => undefined);

  public readonly sendToolResult = jest.fn<
    Promise<void>,
    [AgentToolResultCommand]
  >(async () => undefined);

  public readonly sendApproval = jest.fn<
    Promise<void>,
    [AgentApprovalCommand]
  >(async () => undefined);

  public readonly sendCancel = jest.fn<
    Promise<void>,
    [AgentCancelCommand]
  >(async () => undefined);

  public addAuthoritativeFrameListener(
    listener: (frame: AgentAuthoritativeEvent) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  public addConnectionStateListener(
    listener: (state: AgentConnectionState) => void,
  ): () => void {
    this.stateListener = listener;
    return () => {
      if (this.stateListener === listener) this.stateListener = null;
    };
  }

  public emit(frame: unknown): void {
    this.listener?.(frame as AgentAuthoritativeEvent);
  }

  public setState(state: AgentConnectionState): void {
    this.state = state;
    this.stateListener?.(state);
  }
}

function createSession(input: Readonly<{
  connection?: FakeConnection;
  onProtocolError?: (error: Error) => void;
  onCommandError?: (error: Error) => void;
  onCommandAck?: (ack: AgentCommandAckEvent) => void;
}> = {}) {
  const connection = input.connection ?? new FakeConnection();
  const session = new AgentSession<Message>({
    conversationId: CONVERSATION_ID,
    connection,
    isAuthoritativeMessage: isMessage,
    ...(input.onProtocolError ? { onProtocolError: input.onProtocolError } : {}),
    ...(input.onCommandError ? { onCommandError: input.onCommandError } : {}),
    ...(input.onCommandAck ? { onCommandAck: input.onCommandAck } : {}),
  });
  return { connection, session };
}

async function flushCommands(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<TValue>() {
  let resolve!: (value: TValue | PromiseLike<TValue>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AgentSession server authority", () => {
  it("delivers only validated command acknowledgements after session authority", () => {
    const acknowledgements: AgentCommandAckEvent[] = [];
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onCommandAck: (ack) => acknowledgements.push(ack),
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const approvalAck = event("command_ack", {
      request_id: "request_active",
      command_kind: "client_tool_approval",
      tool_call_id: "call_write",
      status: "accepted",
    });

    connection.emit(approvalAck);
    expect(acknowledgements).toEqual([]);
    expect(protocolErrors).toHaveLength(1);

    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: active(1, "waiting_for_client"),
    }));
    connection.emit(approvalAck);
    connection.emit(approvalAck);

    expect(acknowledgements).toEqual([
      approvalAck,
      approvalAck,
    ]);
    expect(Object.isFrozen(acknowledgements[0])).toBe(true);
    session.dispose();
  });

  it("isolates command acknowledgement observer failures", () => {
    const { connection, session } = createSession({
      onCommandAck: () => {
        throw new Error("observer failed");
      },
    });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: active(1, "waiting_for_client"),
    }));
    connection.emit(event("command_ack", {
      request_id: "request_active",
      command_kind: "client_tool_result",
      tool_call_id: "call_read",
      status: "accepted",
    }));

    expect(session.current.runState).toMatchObject({
      state: "waiting_for_client",
      request_id: "request_active",
    });
    session.dispose();
  });

  it("projects bounded queued and cancelled request receipts from snapshots", () => {
    const { connection, session } = createSession();

    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(1),
      queued_request_ids: ["request_queued"],
      cancelled_queued_request_ids: ["request_cancelled"],
    }));

    expect(session.current.queuedRequestIds).toEqual(["request_queued"]);
    expect(session.current.cancelledQueuedRequestIds)
      .toEqual(["request_cancelled"]);
    expect(Object.isFrozen(session.current.queuedRequestIds)).toBe(true);
    expect(Object.isFrozen(session.current.cancelledQueuedRequestIds))
      .toBe(true);
    session.dispose();
  });

  it("rejects duplicate snapshot message identities", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const duplicate = message("message_duplicate", "user", "Duplicate");

    connection.emit(event("session_snapshot", {
      messages: [duplicate, duplicate],
      run_state: idle(1),
    }));

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.message)
      .toContain("invalid authoritative messages");
    session.dispose();
  });

  it("rejects an assistant snapshot that reuses a user identity", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const user = message("message_collision", "user", "Original user");

    connection.emit(event("session_snapshot", {
      messages: [user],
      run_state: active(
        1,
        "running",
        "request_collision",
        RUN_A,
        user.id,
      ),
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_collision",
      message: message(user.id, "assistant", "Conflicting assistant"),
    }));

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.message)
      .toContain("reuses a non-assistant message identity");
    session.dispose();
  });

  it("keeps one optimistic user separate and releases it only on authoritative idle", async () => {
    const { connection, session } = createSession();
    const pendingUser = message("user_queued", "user", "Queue this next turn");

    expect(session.current).toMatchObject({
      messages: [],
      runState: {
        state: "unknown",
        busy: true,
        reason: "awaiting_session_snapshot",
      },
      optimisticUser: null,
    });

    await expect(session.submit({
      request_id: "user_queued",
      user_message: pendingUser,
      context_ref: CONTEXT_REF,
    })).resolves.toBe("queued");
    expect(connection.sendSubmit).not.toHaveBeenCalled();
    expect(session.current.messages).toEqual([]);
    expect(session.current.optimisticUser).toEqual({
      kind: "optimistic_pending_user",
      request_id: "user_queued",
      message: pendingUser,
      delivery: "queued",
    });

    connection.emit(event("session_snapshot", {
      messages: [message("user_active", "user", "Existing turn")],
      run_state: active(1, "running"),
    }));
    connection.emit(event("terminal", {
      request_id: "request_active",
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: "user_active",
        outcome: "succeeded",
        code: "completed",
      },
    }));
    await flushCommands();

    expect(connection.sendSubmit).not.toHaveBeenCalled();
    expect(session.current.runState.state).toBe("running");
    expect(session.current.optimisticUser?.delivery).toBe("queued");

    connection.emit(event("run_state", { run_state: idle(2) }));
    await flushCommands();

    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(connection.sendSubmit).toHaveBeenCalledWith({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "submit",
      request_id: "user_queued",
      user_message: pendingUser,
      context_ref: CONTEXT_REF,
    });
    expect(session.current.optimisticUser?.delivery).toBe("sent");
    expect(session.current.messages).toEqual([
      message("user_active", "user", "Existing turn"),
    ]);

    connection.emit(event("session_snapshot", {
      messages: [
        message("user_active", "user", "Existing turn"),
        pendingUser,
      ],
      run_state: active(
        3,
        "running",
        "user_queued",
        RUN_B,
        "user_queued",
      ),
    }));

    expect(session.current.optimisticUser).toBeNull();
    expect(session.current.messages).toHaveLength(2);
    session.dispose();
  });

  it("accepts an exact dispatched failure terminal before running and frees the next submit", async () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    const first = message(
      "user_direct_terminal",
      "user",
      "Fail before running is published",
    );
    await expect(session.submit({
      request_id: first.id,
      user_message: first,
    })).resolves.toBe("sent");
    expect(session.current.optimisticUser).toMatchObject({
      request_id: first.id,
      delivery: "sent",
    });

    connection.emit(event("terminal", {
      request_id: first.id,
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: first.id,
        outcome: "failed",
        code: "response_capacity_unavailable",
        message: "SystemSculpt is temporarily busy.",
        incident_id: `incident_${"d".repeat(32)}`,
        retryable: true,
      },
    }));

    expect(protocolErrors).toEqual([]);
    expect(session.current.terminal).toMatchObject({
      request_id: first.id,
      value: {
        outcome: "failed",
        code: "response_capacity_unavailable",
      },
    });
    expect(session.current.optimisticUser).toBeNull();
    expect(session.current.runState).toEqual(idle(0));

    const second = message(
      "user_after_direct_terminal",
      "user",
      "Recover immediately",
    );
    await expect(session.submit({
      request_id: second.id,
      user_message: second,
    })).resolves.toBe("sent");
    expect(connection.sendSubmit).toHaveBeenCalledTimes(2);
    expect(session.current.optimisticUser).toMatchObject({
      request_id: second.id,
      delivery: "sent",
    });
    session.dispose();
  });

  it("rejects a pre-running terminal that does not match the dispatched root", async () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    const pending = message(
      "user_direct_terminal_mismatch",
      "user",
      "Keep this exact request bound",
    );
    await expect(session.submit({
      request_id: pending.id,
      user_message: pending,
    })).resolves.toBe("sent");

    connection.emit(event("terminal", {
      request_id: pending.id,
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: "user_wrong_terminal_root",
        outcome: "failed",
        code: "response_capacity_unavailable",
        message: "SystemSculpt is temporarily busy.",
        incident_id: `incident_${"e".repeat(32)}`,
        retryable: true,
      },
    }));

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.message).toContain("does not match the active run");
    expect(session.current.terminal).toBeNull();
    expect(session.current.optimisticUser?.message).toEqual(pending);
    session.dispose();
  });

  it("keeps a pending user and fails busy on a same-id content collision", async () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    const submitted = message(
      "user_collision",
      "user",
      "Preserve the exact submitted content",
    );
    await expect(session.submit({
      request_id: "user_collision",
      user_message: submitted,
    })).resolves.toBe("sent");

    const conflicting = message(
      "user_collision",
      "user",
      "Different authoritative content",
    );
    connection.emit(event("session_snapshot", {
      messages: [conflicting],
      run_state: active(
        1,
        "running",
        "user_collision",
        RUN_A,
        "user_collision",
      ),
    }));

    expect(protocolErrors).toHaveLength(1);
    expect(session.current.messages).toEqual([conflicting]);
    expect(session.current.optimisticUser?.message).toEqual(submitted);
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      busy: true,
      reason: "protocol_error",
    });

    connection.emit(event("session_snapshot", {
      messages: [submitted],
      run_state: active(
        1,
        "running",
        "user_collision",
        RUN_A,
        "user_collision",
      ),
    }));
    expect(session.current.optimisticUser).toBeNull();
    expect(session.current.messages).toEqual([submitted]);
    expect(session.current.runState.state).toBe("running");
    session.dispose();
  });

  it("rejects malformed snapshots before optimistic-user reconciliation", async () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    const pending = message(
      "user_malformed_snapshot",
      "user",
      "Keep this optimistic message",
    );
    await session.submit({
      request_id: pending.id,
      user_message: pending,
    });

    connection.emit(event("session_snapshot", {
      messages: [{
        id: pending.id,
        role: "user",
        parts: [{
          type: "file",
          mediaType: "image/png",
          url: "https://example.com/untrusted.png",
        }],
      }],
      run_state: active(
        1,
        "running",
        pending.id,
        RUN_A,
        pending.id,
      ),
    }));

    expect(protocolErrors).toHaveLength(1);
    expect(session.current.messages).toEqual([]);
    expect(session.current.optimisticUser?.message).toEqual(pending);
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      reason: "protocol_error",
    });
    session.dispose();
  });

  it("applies higher run-state cursors, ignores lower ones, and fails closed on conflicts", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });

    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: active(4, "running"),
    }));
    const afterInitial = session.current.revision;

    connection.emit(event("run_state", {
      run_state: active(4, "running"),
    }));
    expect(session.current.revision).toBe(afterInitial);

    connection.emit(event("run_state", { run_state: idle(3) }));
    expect(session.current.revision).toBe(afterInitial);
    expect(session.current.runState.state).toBe("running");

    connection.emit(event("run_state", {
      run_state: active(
        4,
        "waiting_for_client",
        "request_conflict",
        RUN_B,
        "user_conflict",
      ),
    }));
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      busy: true,
      cursor: 4,
      reason: "run_state_conflict",
    });
    expect(protocolErrors).toHaveLength(1);

    connection.emit(event("run_state", {
      run_state: active(4, "running"),
    }));
    expect(session.current.runState.state).toBe("unknown");

    connection.emit(event("run_state", { run_state: idle(5) }));
    expect(session.current.runState).toEqual(idle(5));
    session.dispose();
  });

  it("renders valid history but treats missing and future liveness as busy", async () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const queued = message("user_waiting", "user", "Wait for real idle");
    await session.submit({
      request_id: "user_waiting",
      user_message: queued,
    });

    connection.emit(event("session_snapshot", {
      messages: [message("user_existing", "user", "Restored")],
      run_state: { version: null, cursor: null, state: "unknown" },
    }));
    expect(session.current.messages).toHaveLength(1);
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      busy: true,
      reason: "missing_run_state",
    });
    expect(connection.sendSubmit).not.toHaveBeenCalled();

    connection.emit(event("run_state", {
      run_state: { version: 1, cursor: 1, state: "future_state" },
    }));
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      busy: true,
      reason: "invalid_run_state",
    });
    expect(protocolErrors).toHaveLength(1);
    expect(connection.sendSubmit).not.toHaveBeenCalled();

    connection.emit(event("run_state", { run_state: idle(2) }));
    await flushCommands();
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("keeps a queued submit through a closed transport and waits for both snapshot and open", async () => {
    const { connection, session } = createSession();
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    connection.setState("closed");

    await expect(session.submit({
      request_id: "user_reconnect",
      user_message: message("user_reconnect", "user", "Send after reconnect"),
    })).resolves.toBe("queued");
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      busy: true,
      reason: "transport_not_ready",
    });
    expect(connection.sendSubmit).not.toHaveBeenCalled();

    connection.setState("connecting");
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    await flushCommands();
    expect(connection.sendSubmit).not.toHaveBeenCalled();
    expect(session.current.optimisticUser?.delivery).toBe("queued");

    connection.setState("open");
    await flushCommands();
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(session.current.optimisticUser?.delivery).toBe("sent");
    session.dispose();
  });

  it("requeues a submit when readiness changes at the send boundary", async () => {
    const connection = new FakeConnection();
    connection.sendSubmit.mockRejectedValueOnce(Object.assign(
      new Error("not ready"),
      { code: "session_not_ready" },
    ));
    const { session } = createSession({ connection });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));

    await expect(session.submit({
      request_id: "user_race",
      user_message: message("user_race", "user", "Retry after readiness"),
    })).resolves.toBe("queued");
    expect(session.current.optimisticUser?.delivery).toBe("queued");
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);

    connection.setState("closed");
    connection.setState("connecting");
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    connection.setState("open");
    await flushCommands();

    expect(connection.sendSubmit).toHaveBeenCalledTimes(2);
    expect(session.current.optimisticUser?.delivery).toBe("sent");
    session.dispose();
  });

  it("does not let a delayed send resolution overwrite reconnect queue state", async () => {
    const connection = new FakeConnection();
    const firstSend = deferred<void>();
    connection.sendSubmit.mockImplementationOnce(() => firstSend.promise);
    const { session } = createSession({ connection });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));

    const result = session.submit({
      request_id: "user_delayed_disconnect",
      user_message: message(
        "user_delayed_disconnect",
        "user",
        "Keep this through the disconnect",
      ),
    });
    await flushCommands();
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(session.current.optimisticUser?.delivery).toBe("sending");

    connection.setState("closed");
    connection.setState("connecting");
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    connection.setState("open");
    await flushCommands();

    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(session.current.optimisticUser?.delivery).toBe("queued");

    firstSend.resolve();
    await expect(result).resolves.toBe("queued");
    await flushCommands();

    expect(connection.sendSubmit).toHaveBeenCalledTimes(2);
    expect(session.current.optimisticUser?.delivery).toBe("sent");
    session.dispose();
  });

  it("accepts the server completion order of idle before terminal", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    connection.emit(event("session_snapshot", {
      messages: [message("user_terminal_order", "user", "Finish normally")],
      run_state: active(
        1,
        "running",
        "request_terminal_order",
        RUN_A,
        "user_terminal_order",
      ),
    }));

    connection.emit(event("run_state", { run_state: idle(2) }));
    connection.emit(event("terminal", {
      request_id: "request_terminal_order",
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: "user_terminal_order",
        outcome: "succeeded",
        code: "completed",
      },
    }));

    expect(protocolErrors).toEqual([]);
    expect(session.current.runState).toEqual(idle(2));
    expect(session.current.terminal).toMatchObject({
      request_id: "request_terminal_order",
      value: { outcome: "succeeded", code: "completed" },
    });

    const afterTerminal = session.current.revision;
    connection.emit(event("terminal", {
      request_id: "request_terminal_order",
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: "user_terminal_order",
        outcome: "succeeded",
        code: "completed",
      },
    }));
    expect(session.current.revision).toBe(afterTerminal);
    session.dispose();
  });

  it("applies complete assistant replacements without deriving liveness from messages", () => {
    const { connection, session } = createSession();
    const user = message("user_active", "user", "Do the work");
    const partial = message("assistant_active", "assistant", "Part");
    const complete = message("assistant_active", "assistant", "Part complete");

    connection.emit(event("session_snapshot", {
      messages: [user, partial],
      run_state: active(1, "running"),
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_active",
      message: complete,
    }));

    expect(session.current.messages).toEqual([user, complete]);
    expect(session.current.runState.state).toBe("running");

    connection.emit(event("terminal", {
      request_id: "request_active",
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: "user_active",
        outcome: "failed",
        code: "response_failed",
        message: "The response failed.",
        incident_id: `incident_${"c".repeat(32)}`,
        retryable: true,
      },
    }));

    expect(session.current.terminal).toMatchObject({
      request_id: "request_active",
      value: { outcome: "failed", retryable: true },
    });
    expect(session.current.runState.state).toBe("running");
    session.dispose();
  });

  it("drops reordered same-request assistant snapshots after terminal settlement", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const user = message("user_parallel", "user", "Read three notes");
    const first = message("assistant_parallel", "assistant", "One tool settled");
    const second = message("assistant_parallel", "assistant", "Two tools settled");
    const complete = message("assistant_parallel", "assistant", "All tools settled");

    connection.emit(event("session_snapshot", {
      messages: [user],
      run_state: active(
        7,
        "waiting_for_client",
        "request_parallel",
        RUN_A,
        user.id,
      ),
    }));

    // These frames model two same-request HTTP response bodies arriving in a
    // different order than the server broadcasts. Sequence 12 is authoritative;
    // the late 11 and duplicate 12 must not replace it or cause an idle error.
    connection.emit(event("assistant_snapshot", {
      request_id: "request_parallel",
      snapshot_epoch: 3,
      snapshot_sequence: 10,
      message: first,
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_parallel",
      snapshot_epoch: 3,
      snapshot_sequence: 12,
      message: complete,
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_parallel",
      message: second,
    }));
    connection.emit(event("run_state", { run_state: idle(8) }));
    const settledRevision = session.current.revision;
    connection.emit(event("assistant_snapshot", {
      request_id: "request_parallel",
      snapshot_epoch: 3,
      snapshot_sequence: 11,
      message: second,
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_parallel",
      snapshot_epoch: 3,
      snapshot_sequence: 12,
      message: complete,
    }));

    expect(session.current.messages).toEqual([user, complete]);
    expect(session.current.runState).toEqual(idle(8));
    expect(session.current.revision).toBe(settledRevision);
    expect(protocolErrors).toEqual([]);
    session.dispose();
  });

  it("orders a new server-instance epoch ahead of delayed old response bodies", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const user = message("user_epoch", "user", "Continue after an eviction");
    const old = message("assistant_epoch", "assistant", "Old instance");
    const current = message("assistant_epoch", "assistant", "New instance");

    connection.emit(event("session_snapshot", {
      messages: [user],
      run_state: active(
        9,
        "waiting_for_client",
        "request_epoch",
        RUN_A,
        user.id,
      ),
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_epoch",
      snapshot_epoch: 40,
      snapshot_sequence: 900,
      message: old,
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_epoch",
      snapshot_epoch: 41,
      snapshot_sequence: 1,
      message: current,
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: "request_epoch",
      snapshot_epoch: 40,
      snapshot_sequence: 901,
      message: old,
    }));

    expect(session.current.messages).toEqual([user, current]);
    expect(protocolErrors).toEqual([]);
    session.dispose();
  });

  it("ignores a stale cancel or finalization session snapshot atomically", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const requestId = "request_stale_full_snapshot";
    const user = message("user_stale_full_snapshot", "user", "Finish safely");
    const partial = message("assistant_stale_full_snapshot", "assistant", "Partial");
    const complete = message("assistant_stale_full_snapshot", "assistant", "Complete");

    connection.emit(event("session_snapshot", {
      messages: [user, partial],
      run_state: active(14, "running", requestId, RUN_A, user.id),
      queued_request_ids: ["request_keep_queued"],
      cancelled_queued_request_ids: ["request_keep_cancelled"],
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: requestId,
      snapshot_epoch: 5,
      snapshot_sequence: 2,
      message: complete,
    }));
    connection.emit(event("terminal", {
      request_id: requestId,
      terminal: {
        version: 1,
        run_id: RUN_A,
        root_message_id: user.id,
        outcome: "succeeded",
        code: "completed",
      },
    }));
    connection.emit(event("run_state", { run_state: idle(15) }));
    const settled = session.current;

    // A slower cancellation/finalization response can still contain the full
    // pre-terminal snapshot. Its lower liveness cursor must reject the entire
    // frame before any message, terminal, or queue authority is replaced.
    connection.emit(event("session_snapshot", {
      messages: [user, partial],
      run_state: active(14, "running", requestId, RUN_A, user.id),
      queued_request_ids: ["request_wrong_queue"],
      cancelled_queued_request_ids: [],
    }));

    expect(session.current).toEqual(settled);
    expect(session.current.messages).toEqual([user, complete]);
    expect(session.current.terminal).toMatchObject({
      request_id: requestId,
      value: { outcome: "succeeded", code: "completed" },
    });
    expect(session.current.queuedRequestIds).toEqual(["request_keep_queued"]);
    expect(session.current.cancelledQueuedRequestIds)
      .toEqual(["request_keep_cancelled"]);
    expect(protocolErrors).toEqual([]);
    session.dispose();
  });

  it("orders equal-cursor full snapshots with assistant replacements", () => {
    const protocolErrors: Error[] = [];
    const { connection, session } = createSession({
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const requestId = "request_equal_cursor_snapshot_order";
    const user = message("user_equal_cursor_snapshot_order", "user", "Inspect");
    const partial = message(
      "assistant_equal_cursor_snapshot_order",
      "assistant",
      "Partial",
    );
    const complete = message(
      "assistant_equal_cursor_snapshot_order",
      "assistant",
      "Complete",
    );
    const newest = message(
      "assistant_equal_cursor_snapshot_order",
      "assistant",
      "Newest",
    );
    const runState = active(14, "waiting_for_client", requestId, RUN_A, user.id);

    connection.emit(event("session_snapshot", {
      snapshot_epoch: 5,
      snapshot_sequence: 1,
      messages: [user, partial],
      run_state: runState,
      queued_request_ids: ["request_initial_queue"],
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: requestId,
      snapshot_epoch: 5,
      snapshot_sequence: 3,
      message: complete,
    }));

    // A slower full projection has the same liveness cursor and identity but
    // predates the accepted assistant replacement. Reject its messages and
    // queue state atomically instead of regressing the visible tool timeline.
    connection.emit(event("session_snapshot", {
      snapshot_epoch: 5,
      snapshot_sequence: 2,
      messages: [user, partial],
      run_state: runState,
      queued_request_ids: ["request_stale_queue"],
    }));
    expect(session.current.messages).toEqual([user, complete]);
    expect(session.current.queuedRequestIds).toEqual(["request_initial_queue"]);

    // A genuinely newer same-cursor projection remains valid and advances the
    // fence for both delayed ordered and deployment-transition legacy frames.
    connection.emit(event("session_snapshot", {
      snapshot_epoch: 5,
      snapshot_sequence: 4,
      messages: [user, newest],
      run_state: runState,
      queued_request_ids: ["request_newest_queue"],
    }));
    connection.emit(event("assistant_snapshot", {
      request_id: requestId,
      snapshot_epoch: 5,
      snapshot_sequence: 3,
      message: complete,
    }));
    connection.emit(event("session_snapshot", {
      messages: [user, partial],
      run_state: runState,
      queued_request_ids: ["request_legacy_queue"],
    }));

    expect(session.current.messages).toEqual([user, newest]);
    expect(session.current.queuedRequestIds).toEqual(["request_newest_queue"]);
    expect(protocolErrors).toEqual([]);
    session.dispose();
  });

  it("emits one exact typed command for every controller action", async () => {
    const { connection, session } = createSession();

    connection.emit(event("session_snapshot", {
      messages: [message("user_regenerate", "user", "Try again")],
      run_state: idle(0),
    }));
    await session.regenerate({
      request_id: "request_regenerate",
      root_message_id: "user_regenerate",
    });
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(connection.sendSubmit).toHaveBeenCalledWith({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "regenerate",
      request_id: "request_regenerate",
      root_message_id: "user_regenerate",
    });
    expect(JSON.stringify(connection.sendSubmit.mock.calls[0][0]))
      .not.toContain("messages");

    connection.emit(event("run_state", {
      run_state: active(1, "waiting_for_client"),
    }));
    await session.sendToolResult({
      request_id: "request_active",
      tool_call_id: "call_read",
      tool_name: "read",
      state: "output-available",
      output: { text: "result" },
    });
    await session.sendToolApproval({
      request_id: "request_active",
      tool_call_id: "call_write",
      approved: true,
    });
    await session.cancel({ request_id: "request_active" });

    expect(connection.sendToolResult).toHaveBeenCalledTimes(1);
    expect(connection.sendToolResult).toHaveBeenCalledWith({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "client_tool_result",
      request_id: "request_active",
      tool_call_id: "call_read",
      tool_name: "read",
      state: "output-available",
      output: { text: "result" },
    });
    expect(connection.sendApproval).toHaveBeenCalledTimes(1);
    expect(connection.sendApproval).toHaveBeenCalledWith({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "client_tool_approval",
      request_id: "request_active",
      tool_call_id: "call_write",
      approved: true,
    });
    expect(connection.sendCancel).toHaveBeenCalledTimes(1);
    expect(connection.sendCancel).toHaveBeenCalledWith({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "cancel",
      request_id: "request_active",
    });
    session.dispose();
  });

  it("rejects mismatched local-tool actions without sending a command", async () => {
    const { connection, session } = createSession();
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: active(1, "waiting_for_client"),
    }));

    await expect(session.sendToolResult({
      request_id: "request_other",
      tool_call_id: "call_read",
      tool_name: "read",
      state: "output-error",
      error_text: "Read failed.",
    })).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "run_identity_mismatch",
    } satisfies Partial<AgentSessionError>);
    expect(connection.sendToolResult).not.toHaveBeenCalled();
    session.dispose();
  });

  it("clears optimistic state when a direct submit fails", async () => {
    const connection = new FakeConnection();
    connection.sendSubmit.mockRejectedValueOnce(new Error("send failed"));
    const { session } = createSession({ connection });
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));

    await expect(session.submit({
      request_id: "user_direct",
      user_message: message("user_direct", "user", "Send now"),
    })).rejects.toThrow("send failed");
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(session.current.optimisticUser).toBeNull();
    session.dispose();
  });

  it("rejects a non-canonical context reference before creating optimism", async () => {
    const { connection, session } = createSession();
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));

    await expect(session.submit({
      request_id: "user_context",
      user_message: message("user_context", "user", "Use context"),
      context_ref: "ctx1_not-a-real-reference",
    })).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "invalid_command",
    });
    expect(session.current.optimisticUser).toBeNull();
    expect(connection.sendSubmit).not.toHaveBeenCalled();
    session.dispose();
  });

  describe("live assistant deltas", () => {
    function liveDelta(fields: Readonly<{
      offset: number;
      delta: string;
      requestId?: string;
      messageId?: string;
      partOrdinal?: number;
      partKind?: "text" | "reasoning";
    }>) {
      return event("assistant_delta", {
        request_id: fields.requestId ?? "request_active",
        message_id: fields.messageId ?? "assistant_live",
        part_kind: fields.partKind ?? "text",
        part_ordinal: fields.partOrdinal ?? 0,
        offset: fields.offset,
        delta: fields.delta,
      });
    }

    it("builds streamed text from exact-offset deltas and drops the rest", () => {
      const protocolErrors: Error[] = [];
      const { connection, session } = createSession({
        onProtocolError: (error) => protocolErrors.push(error),
      });
      connection.emit(event("session_snapshot", {
        messages: [message("user_active", "user", "Stream it")],
        run_state: active(1, "running"),
      }));

      connection.emit(liveDelta({ offset: 0, delta: "Hello" }));
      connection.emit(liveDelta({ offset: 5, delta: " world" }));
      // Replay of an already-applied run and a gap beyond the local text are
      // both render hints that no longer fit; each is dropped silently.
      connection.emit(liveDelta({ offset: 5, delta: " world" }));
      connection.emit(liveDelta({ offset: 99, delta: "lost" }));
      // A delta for a different run or a non-assistant identity never applies.
      connection.emit(liveDelta({
        offset: 11,
        delta: "!",
        requestId: "request_other",
      }));
      connection.emit(liveDelta({
        offset: 0,
        delta: "not yours",
        messageId: "user_active",
      }));

      const assistant = session.current.messages.find(
        (candidate) => candidate.id === "assistant_live",
      );
      expect(assistant).toMatchObject({
        role: "assistant",
        parts: [{ type: "text", text: "Hello world" }],
      });
      expect(Object.isFrozen(assistant)).toBe(true);
      expect(session.current.messages).toHaveLength(2);
      expect(protocolErrors).toEqual([]);
      session.dispose();
    });

    it("creates a following part only as the next part of its kind", () => {
      const { connection, session } = createSession();
      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      connection.emit(liveDelta({ offset: 0, delta: "First part." }));
      // Ordinal 2 would skip a part; it must not create anything.
      connection.emit(liveDelta({ offset: 0, delta: "skipped", partOrdinal: 2 }));
      connection.emit(liveDelta({ offset: 0, delta: "Second part.", partOrdinal: 1 }));

      expect(session.current.messages).toEqual([{
        id: "assistant_live",
        role: "assistant",
        parts: [
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." },
        ],
      }]);
      session.dispose();
    });

    it("keeps the longer live text when a delayed snapshot is a strict prefix", () => {
      const { connection, session } = createSession();
      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      connection.emit(liveDelta({ offset: 0, delta: "Hello" }));
      connection.emit(liveDelta({ offset: 5, delta: " world" }));

      // The durable snapshot cadence legitimately trails the delta stream.
      connection.emit(event("assistant_snapshot", {
        request_id: "request_active",
        message: message("assistant_live", "assistant", "Hello"),
      }));
      expect(session.current.messages[0]?.parts).toEqual([
        { type: "text", text: "Hello world" },
      ]);

      // A non-prefix snapshot is an authoritative rewrite and always wins.
      connection.emit(event("assistant_snapshot", {
        request_id: "request_active",
        message: message("assistant_live", "assistant", "Rewritten answer"),
      }));
      expect(session.current.messages[0]?.parts).toEqual([
        { type: "text", text: "Rewritten answer" },
      ]);

      // Later deltas continue from the rewrite's exact tail offset.
      connection.emit(liveDelta({ offset: 16, delta: " continues" }));
      expect(session.current.messages[0]?.parts).toEqual([
        { type: "text", text: "Rewritten answer continues" },
      ]);
      session.dispose();
    });

    it("addresses parts by ordinal within their own kind", () => {
      const { connection, session } = createSession();
      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      connection.emit(liveDelta({
        offset: 0,
        delta: "Think",
        partKind: "reasoning",
      }));
      connection.emit(liveDelta({ offset: 0, delta: "Answer" }));
      connection.emit(liveDelta({
        offset: 5,
        delta: "ing",
        partKind: "reasoning",
      }));
      connection.emit(liveDelta({ offset: 6, delta: " done" }));

      expect(session.current.messages).toEqual([{
        id: "assistant_live",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Thinking" },
          { type: "text", text: "Answer done" },
        ],
      }]);
      session.dispose();
    });

    it("never creates a message from a mid-stream delta", () => {
      const { connection, session } = createSession();
      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      // A first observable delta must be the exact start of the message;
      // anything else waits for the healing assistant snapshot instead.
      connection.emit(liveDelta({ offset: 3, delta: "late tail" }));
      connection.emit(liveDelta({ offset: 0, delta: "late part", partOrdinal: 1 }));

      expect(session.current.messages).toEqual([]);
      session.dispose();
    });

    it("keeps live tails of both part kinds through a delayed snapshot", () => {
      const { connection, session } = createSession();
      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      connection.emit(liveDelta({
        offset: 0,
        delta: "Thinking hard",
        partKind: "reasoning",
      }));
      connection.emit(liveDelta({ offset: 0, delta: "Answer text" }));

      connection.emit(event("assistant_snapshot", {
        request_id: "request_active",
        message: {
          id: "assistant_live",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "Thinking" },
            { type: "text", text: "Answer" },
          ],
        },
      }));

      expect(session.current.messages).toEqual([{
        id: "assistant_live",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Thinking hard" },
          { type: "text", text: "Answer text" },
        ],
      }]);
      session.dispose();
    });

    it("lets a snapshot rewrite a live part that carries no text", () => {
      const { connection, session } = createSession();
      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      // Additive part shapes without text are legal on the wire; they must
      // pass through the live-tail merge untouched.
      connection.emit(event("assistant_snapshot", {
        request_id: "request_active",
        message: {
          id: "assistant_live",
          role: "assistant",
          parts: [{ type: "text" }],
        },
      }));
      connection.emit(event("assistant_snapshot", {
        request_id: "request_active",
        message: {
          id: "assistant_live",
          role: "assistant",
          parts: [{ type: "text", text: "Full answer" }],
        },
      }));

      expect(session.current.messages).toEqual([{
        id: "assistant_live",
        role: "assistant",
        parts: [{ type: "text", text: "Full answer" }],
      }]);
      session.dispose();
    });

    it("never applies deltas before session authority or after the run ends", () => {
      const protocolErrors: Error[] = [];
      const { connection, session } = createSession({
        onProtocolError: (error) => protocolErrors.push(error),
      });
      connection.emit(liveDelta({ offset: 0, delta: "too early" }));
      expect(protocolErrors).toHaveLength(1);

      connection.emit(event("session_snapshot", {
        messages: [],
        run_state: active(1, "running"),
      }));
      connection.emit(event("run_state", { run_state: idle(2) }));
      connection.emit(liveDelta({ offset: 0, delta: "too late" }));

      expect(session.current.messages).toEqual([]);
      expect(protocolErrors).toHaveLength(1);
      session.dispose();
    });
  });
});
