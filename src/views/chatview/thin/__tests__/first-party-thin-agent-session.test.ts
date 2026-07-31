import {
  FirstPartyThinAgentSession,
  FirstPartyThinAgentSessionError,
  type FirstPartyThinAgentApprovalCommand,
  type FirstPartyThinAgentAuthoritativeEvent,
  type FirstPartyThinAgentCancelCommand,
  type FirstPartyThinAgentCommandAckEvent,
  type FirstPartyThinAgentConnectionPort,
  type FirstPartyThinAgentSubmitCommand,
  type FirstPartyThinAgentToolResultCommand,
} from "../FirstPartyThinAgentSession";
import type {
  FirstPartyThinAgentConnectionState,
} from "../FirstPartyThinAgentSessionTransport";

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

class FakeConnection implements FirstPartyThinAgentConnectionPort {
  public state: FirstPartyThinAgentConnectionState = "open";
  private listener: ((frame: FirstPartyThinAgentAuthoritativeEvent) => void) | null = null;
  private stateListener: ((state: FirstPartyThinAgentConnectionState) => void) | null = null;

  public readonly sendSubmit = jest.fn<
    Promise<void>,
    [FirstPartyThinAgentSubmitCommand]
  >(async () => undefined);

  public readonly sendToolResult = jest.fn<
    Promise<void>,
    [FirstPartyThinAgentToolResultCommand]
  >(async () => undefined);

  public readonly sendApproval = jest.fn<
    Promise<void>,
    [FirstPartyThinAgentApprovalCommand]
  >(async () => undefined);

  public readonly sendCancel = jest.fn<
    Promise<void>,
    [FirstPartyThinAgentCancelCommand]
  >(async () => undefined);

  public addAuthoritativeFrameListener(
    listener: (frame: FirstPartyThinAgentAuthoritativeEvent) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  public addConnectionStateListener(
    listener: (state: FirstPartyThinAgentConnectionState) => void,
  ): () => void {
    this.stateListener = listener;
    return () => {
      if (this.stateListener === listener) this.stateListener = null;
    };
  }

  public emit(frame: unknown): void {
    this.listener?.(frame as FirstPartyThinAgentAuthoritativeEvent);
  }

  public setState(state: FirstPartyThinAgentConnectionState): void {
    this.state = state;
    this.stateListener?.(state);
  }
}

function createSession(input: Readonly<{
  connection?: FakeConnection;
  onProtocolError?: (error: Error) => void;
  onCommandError?: (error: Error) => void;
  onCommandAck?: (ack: FirstPartyThinAgentCommandAckEvent) => void;
}> = {}) {
  const connection = input.connection ?? new FakeConnection();
  const session = new FirstPartyThinAgentSession<Message>({
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

describe("FirstPartyThinAgentSession server authority", () => {
  it("delivers only validated command acknowledgements after session authority", () => {
    const acknowledgements: FirstPartyThinAgentCommandAckEvent[] = [];
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
      request_id: "request_queued",
      user_message: pendingUser,
      context_ref: CONTEXT_REF,
    })).resolves.toBe("queued");
    expect(connection.sendSubmit).not.toHaveBeenCalled();
    expect(session.current.messages).toEqual([]);
    expect(session.current.optimisticUser).toEqual({
      kind: "optimistic_pending_user",
      request_id: "request_queued",
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
      request_id: "request_queued",
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
        "request_queued",
        RUN_B,
        "user_queued",
      ),
    }));

    expect(session.current.optimisticUser).toBeNull();
    expect(session.current.messages).toHaveLength(2);
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
      request_id: "request_collision",
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
        "request_collision",
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
        "request_collision",
        RUN_A,
        "user_collision",
      ),
    }));
    expect(session.current.optimisticUser).toBeNull();
    expect(session.current.messages).toEqual([submitted]);
    expect(session.current.runState.state).toBe("running");
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
      request_id: "request_waiting",
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

  it("keeps a queued submit through reconnect and waits for both snapshot and open", async () => {
    const { connection, session } = createSession();
    connection.emit(event("session_snapshot", {
      messages: [],
      run_state: idle(0),
    }));
    connection.setState("reconnecting");

    await expect(session.submit({
      request_id: "request_reconnect",
      user_message: message("user_reconnect", "user", "Send after reconnect"),
    })).resolves.toBe("queued");
    expect(session.current.runState).toMatchObject({
      state: "unknown",
      busy: true,
      reason: "transport_not_ready",
    });
    expect(connection.sendSubmit).not.toHaveBeenCalled();

    connection.setState("synchronizing");
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
      request_id: "request_race",
      user_message: message("user_race", "user", "Retry after readiness"),
    })).resolves.toBe("queued");
    expect(session.current.optimisticUser?.delivery).toBe("queued");
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);

    connection.setState("reconnecting");
    connection.setState("synchronizing");
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
      request_id: "request_delayed_disconnect",
      user_message: message(
        "user_delayed_disconnect",
        "user",
        "Keep this through the disconnect",
      ),
    });
    await flushCommands();
    expect(connection.sendSubmit).toHaveBeenCalledTimes(1);
    expect(session.current.optimisticUser?.delivery).toBe("sending");

    connection.setState("reconnecting");
    connection.setState("synchronizing");
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
      name: "FirstPartyThinAgentSessionError",
      code: "run_identity_mismatch",
    } satisfies Partial<FirstPartyThinAgentSessionError>);
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
      request_id: "request_direct",
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
      request_id: "request_context",
      user_message: message("user_context", "user", "Use context"),
      context_ref: "ctx1_not-a-real-reference",
    })).rejects.toMatchObject({
      name: "FirstPartyThinAgentSessionError",
      code: "invalid_command",
    });
    expect(session.current.optimisticUser).toBeNull();
    expect(connection.sendSubmit).not.toHaveBeenCalled();
    session.dispose();
  });
});
