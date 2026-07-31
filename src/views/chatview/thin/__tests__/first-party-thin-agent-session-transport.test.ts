import {
  FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
  FIRST_PARTY_THIN_AGENT_DIAGNOSTIC_TYPE,
  FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
  parseFirstPartyThinAgentCommand,
  parseFirstPartyThinAgentServerEvent,
  type FirstPartyThinAgentServerEvent,
} from "../FirstPartyThinAgentProtocol";
import {
  FirstPartyThinAgentSessionTransport,
  type FirstPartyThinAgentTransportIssue,
  type FirstPartyThinAgentWebSocket,
} from "../FirstPartyThinAgentSessionTransport";

const conversationId = "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sessionId = "session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const requestId = "request_1";
const rootMessageId = "user_1";

const bootstrapRequest = {
  contract_version: "thin-agent-v1" as const,
  conversation_id: conversationId,
  client_id: "client_cccccccccccccccccccccccccccccccc",
  plugin_build_id: `sha256:${"d".repeat(64)}`,
  capability_manifest: {
    contract_version: "thin-agent-capabilities-v1" as const,
    capabilities: [{ id: "obsidian.vault" as const, version: 1 as const }],
  },
};

function bootstrapResponse(token: string) {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: conversationId,
    session: { id: sessionId },
    access: {
      token,
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

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class FakeWebSocket implements FirstPartyThinAgentWebSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  public readonly closes: Readonly<{ code: number; reason: string }>[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public send(data: string): void {
    if (this.readyState !== 1) throw new Error("Fake socket is not open.");
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", { code, reason });
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  public serverMessage(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  public serverRawMessage(data: unknown): void {
    this.emit("message", { data });
  }

  public serverClose(code = 1006, reason = "interrupted"): void {
    this.close(code, reason);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function idleRunState(cursor: number) {
  return { version: 1, cursor, state: "idle" } as const;
}

function runningRunState(cursor: number, state: "running" | "waiting_for_client" = "running") {
  return {
    version: 1,
    cursor,
    state,
    request_id: requestId,
    run_id: "run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    root_message_id: rootMessageId,
  } as const;
}

function sessionSnapshot(cursor: number, messages: unknown[] = []) {
  return {
    type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
    version: 1,
    kind: "session_snapshot",
    conversation_id: conversationId,
    messages,
    run_state: idleRunState(cursor),
  } as const;
}

function assistantMessage(id = "assistant_1", parts: unknown[] = []) {
  return { id, role: "assistant", parts } as const;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test state.");
}

function harness(
  tokens = ["access_token_first_1234567890"],
  options: Readonly<{
    request?: jest.Mock<Promise<Response>, []>;
    reconnectDelayMs?: number;
    snapshotTimeoutMs?: number;
    onIssue?: (issue: FirstPartyThinAgentTransportIssue) => void;
  }> = {},
) {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const issues: FirstPartyThinAgentTransportIssue[] = [];
  let requestIndex = 0;
  const request = options.request ?? jest.fn(async () => response(bootstrapResponse(
    tokens[Math.min(requestIndex++, tokens.length - 1)],
  )));
  const transport = new FirstPartyThinAgentSessionTransport({
    baseUrl: "https://systemsculpt.test",
    pluginVersion: "6.2.7",
    licenseKey: () => "license_test",
    bootstrapRequest: () => bootstrapRequest,
    requestClient: { request },
    reconnectDelayMs: () => options.reconnectDelayMs ?? 0,
    snapshotTimeoutMs: options.snapshotTimeoutMs ?? 5_000,
    createWebSocket: (url) => {
      urls.push(url);
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    onIssue: (issue) => {
      issues.push(issue);
      options.onIssue?.(issue);
    },
  });
  return { transport, sockets, urls, issues, request };
}

async function connect(h: ReturnType<typeof harness>, cursor = 1): Promise<void> {
  const ready = h.transport.connect();
  await waitFor(() => h.sockets.length === 1);
  h.sockets[0].open();
  h.sockets[0].serverMessage(sessionSnapshot(cursor));
  await ready;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("FirstPartyThinAgentSessionTransport", () => {
  it("matches the server command collection and submit-part boundaries", () => {
    const submit = (parts: unknown[]) => ({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "submit",
      request_id: requestId,
      user_message: { id: rootMessageId, role: "user", parts },
    });
    expect(parseFirstPartyThinAgentCommand(submit(
      Array.from({ length: 16 }, () => ({ type: "text", text: "x" })),
    ))).toMatchObject({ kind: "submit" });
    expect(() => parseFirstPartyThinAgentCommand(submit(
      Array.from({ length: 17 }, () => ({ type: "text", text: "x" })),
    ))).toThrow("one new user message");
    expect(() => parseFirstPartyThinAgentCommand(submit([
      { type: "text", text: " \n\t" },
    ]))).toThrow("text part");

    const outputCommand = (output: unknown) => ({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_result",
      request_id: requestId,
      tool_call_id: "call_1",
      tool_name: "read",
      state: "output-available",
      output,
    });
    const accepted = parseFirstPartyThinAgentCommand(outputCommand(
      Array.from({ length: 2_048 }, () => null),
    ));
    expect(accepted.kind).toBe("client_tool_result");
    if (accepted.kind !== "client_tool_result" || accepted.state !== "output-available") {
      throw new Error("Tool result missing.");
    }
    expect(Object.isFrozen(accepted.output)).toBe(true);
    expect(() => parseFirstPartyThinAgentCommand(outputCommand(
      Array.from({ length: 2_049 }, () => null),
    ))).toThrow("invalid JSON data");
  });

  it("matches bounded server message, assistant-role, terminal, and unknown-event decoding", () => {
    const messages = Array.from({ length: 256 }, (_, index) =>
      assistantMessage(`assistant_${index}`));
    expect(parseFirstPartyThinAgentServerEvent(
      sessionSnapshot(1, messages),
      conversationId,
    )).toMatchObject({ kind: "session_snapshot" });
    expect(() => parseFirstPartyThinAgentServerEvent(
      sessionSnapshot(1, [...messages, assistantMessage("assistant_overflow")]),
      conversationId,
    )).toThrow("session snapshot");
    expect(() => parseFirstPartyThinAgentServerEvent({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "assistant_snapshot",
      conversation_id: conversationId,
      request_id: requestId,
      message: { id: rootMessageId, role: "user", parts: [] },
    }, conversationId)).toThrow("authoritative message");

    const terminal = parseFirstPartyThinAgentServerEvent({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "terminal",
      conversation_id: conversationId,
      request_id: requestId,
      terminal: {
        version: 1,
        run_id: "run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        root_message_id: rootMessageId,
        outcome: "succeeded",
        code: "completed",
        message: "additive field",
      },
    }, conversationId);
    expect(terminal).toMatchObject({
      kind: "terminal",
      terminal: { outcome: "succeeded", code: "completed" },
    });
    if (terminal.kind !== "terminal") throw new Error("Terminal missing.");
    expect(terminal.terminal).not.toHaveProperty("message");

    const rawKind = "f".repeat(80);
    const unknown = parseFirstPartyThinAgentServerEvent({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: rawKind,
      conversation_id: conversationId,
      private_payload: "must not reach presentation",
    }, conversationId);
    expect(unknown).toEqual({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "unknown",
      conversation_id: conversationId,
      raw_kind: rawKind,
      raw: {
        type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
        version: 1,
        kind: rawKind,
        conversation_id: conversationId,
      },
    });
    expect(() => parseFirstPartyThinAgentServerEvent({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "f".repeat(81),
      conversation_id: conversationId,
    }, conversationId)).toThrow("server event");
  });

  it("strictly decodes ordinary and tool command acknowledgements", () => {
    const base = {
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "command_ack",
      conversation_id: conversationId,
      request_id: requestId,
      status: "accepted",
    } as const;
    expect(parseFirstPartyThinAgentServerEvent({
      ...base,
      command_kind: "submit",
    }, conversationId)).toEqual({
      ...base,
      command_kind: "submit",
    });
    expect(parseFirstPartyThinAgentServerEvent({
      ...base,
      command_kind: "client_tool_result",
      tool_call_id: "call_read_1",
    }, conversationId)).toEqual({
      ...base,
      command_kind: "client_tool_result",
      tool_call_id: "call_read_1",
    });
    expect(() => parseFirstPartyThinAgentServerEvent({
      ...base,
      command_kind: "client_tool_approval",
    }, conversationId)).toThrow("command acknowledgement");
    expect(() => parseFirstPartyThinAgentServerEvent({
      ...base,
      command_kind: "cancel",
      tool_call_id: "call_forbidden",
    }, conversationId)).toThrow("command acknowledgement");
    expect(() => parseFirstPartyThinAgentServerEvent({
      ...base,
      command_kind: "client_tool_result",
      tool_call_id: "call_read_1",
      status: "ignored",
    }, conversationId)).toThrow("command acknowledgement");
  });

  it("settles connect immediately when closed during bootstrap and ignores a late response", async () => {
    let resolveBootstrap!: (value: Response) => void;
    const request = jest.fn(() => new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    }));
    const h = harness(["access_token_late_1234567890"], { request });

    const pending = h.transport.connect();
    await waitFor(() => request.mock.calls.length === 1);
    h.transport.close();

    await expect(pending).rejects.toMatchObject({ code: "transport_closed" });
    resolveBootstrap(response(bootstrapResponse("access_token_late_1234567890")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.sockets).toHaveLength(0);
    expect(h.transport.state).toBe("closed");
  });

  it.each([false, true])(
    "settles connect when closed %s socket open but before the snapshot",
    async (openSocket) => {
      const h = harness();
      const pending = h.transport.connect();
      await waitFor(() => h.sockets.length === 1);
      if (openSocket) h.sockets[0].open();

      h.transport.close();

      await expect(pending).rejects.toMatchObject({ code: "transport_closed" });
      h.sockets[0].serverMessage(sessionSnapshot(99));
      expect(h.transport.state).toBe("closed");
      expect(h.request).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels reconnect backoff when connect is called manually", async () => {
    const h = harness([
      "access_token_first_1234567890",
      "access_token_second_1234567890",
    ], { reconnectDelayMs: 50 });
    await connect(h);
    h.sockets[0].serverClose();

    const first = h.transport.connect();
    const second = h.transport.connect();
    expect(first).toBe(second);
    await waitFor(() => h.sockets.length === 2);
    h.sockets[1].open();
    h.sockets[1].serverMessage(sessionSnapshot(2));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.sockets).toHaveLength(2);
    h.transport.close();
  });

  it("joins a timer-owned reconnect attempt instead of starting a competing generation", async () => {
    let resolveReconnect!: (value: Response) => void;
    const request = jest.fn()
      .mockResolvedValueOnce(response(bootstrapResponse("access_token_first_1234567890")))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveReconnect = resolve;
      }));
    const h = harness([], { request });
    await connect(h);
    h.sockets[0].serverClose();
    await waitFor(() => request.mock.calls.length === 2);

    const first = h.transport.connect();
    const second = h.transport.connect();
    expect(first).toBe(second);
    resolveReconnect(response(bootstrapResponse("access_token_second_1234567890")));
    await waitFor(() => h.sockets.length === 2);
    h.sockets[1].open();
    h.sockets[1].serverMessage(sessionSnapshot(2));
    await first;

    expect(request).toHaveBeenCalledTimes(2);
    expect(h.sockets).toHaveLength(2);
    h.transport.close();
  });

  it("cannot be resurrected when an authority listener closes during the first snapshot", async () => {
    const h = harness();
    h.transport.addRunStateListener((state) => {
      if (state.state === "idle") h.transport.close();
    });
    const pending = h.transport.connect();
    await waitFor(() => h.sockets.length === 1);
    h.sockets[0].open();
    h.sockets[0].serverMessage(sessionSnapshot(1));

    await expect(pending).rejects.toMatchObject({ code: "transport_closed" });
    expect(h.transport.state).toBe("closed");
    expect(h.transport.isReady).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("settles when a state listener closes during socket synchronization", async () => {
    const h = harness();
    h.transport.addConnectionStateListener((state) => {
      if (state === "synchronizing") h.transport.close();
    });
    const pending = h.transport.connect();
    await waitFor(() => h.sockets.length === 1);
    h.sockets[0].open();

    await expect(pending).rejects.toMatchObject({ code: "transport_closed" });
    expect(h.transport.state).toBe("closed");
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("rebootstraps with a fresh ticket and full authoritative snapshot after reconnect", async () => {
    const h = harness([
      "access_token_first_1234567890",
      "access_token_second_1234567890",
    ]);
    const received: FirstPartyThinAgentServerEvent[] = [];
    h.transport.addAuthoritativeFrameListener((event) => received.push(event));

    await connect(h, 4);
    expect(h.transport.state).toBe("open");
    expect(h.transport.isAuthoritativelyIdle).toBe(true);
    expect(h.urls[0]).toBe(
      "wss://systemsculpt.test/api/plugin/agent/connect?access_token=access_token_first_1234567890",
    );
    expect(h.urls[0]).not.toContain("license_test");
    expect(h.urls[0]).not.toContain("after_cursor");

    h.sockets[0].serverClose();
    expect(h.transport.isReady).toBe(false);
    expect(h.transport.isAuthoritativelyIdle).toBe(false);
    expect(h.transport.runState.state).toBe("unknown");
    await waitFor(() => h.sockets.length === 2);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.urls[1]).toBe(
      "wss://systemsculpt.test/api/plugin/agent/connect?access_token=access_token_second_1234567890",
    );
    h.sockets[1].open();
    h.sockets[1].serverMessage(sessionSnapshot(4, [assistantMessage()]));
    await waitFor(() => h.transport.state === "open");
    expect(h.transport.isReady).toBe(true);

    const receivedCount = received.length;
    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: idleRunState(99),
    });
    expect(received).toHaveLength(receivedCount);
    h.transport.close();
  });

  it("applies higher run-state cursors, ignores lower cursors, and rejects a divergent replay", async () => {
    const h = harness();
    const runStates: string[] = [];
    h.transport.addRunStateListener((state) => runStates.push(state.state));
    await connect(h, 5);

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: runningRunState(6),
    });
    expect(h.transport.runState).toMatchObject({ state: "running", cursor: 6 });
    expect(h.transport.isAuthoritativelyIdle).toBe(false);

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: idleRunState(5),
    });
    expect(h.transport.runState).toMatchObject({ state: "running", cursor: 6 });
    expect(h.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale_run_state" }),
    ]));

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: runningRunState(6),
    });
    expect(h.sockets[0].readyState).toBe(1);

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: runningRunState(6, "waiting_for_client"),
    });
    expect(h.sockets[0].readyState).toBe(3);
    expect(h.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "run_state_conflict" }),
    ]));
    expect(runStates).toEqual(["idle", "running", "running", "unknown"]);
    h.transport.close();
  });

  it("treats missing or unknown run state as busy and only releases on authoritative idle", async () => {
    const h = harness();
    const ready = h.transport.connect();
    await waitFor(() => h.sockets.length === 1);
    h.sockets[0].open();
    h.sockets[0].serverMessage({
      ...sessionSnapshot(1),
      run_state: { version: 1, cursor: 1, state: "future_server_state" },
    });
    await ready;
    expect(h.transport.runState).toMatchObject({ state: "unknown", cursor: 1 });
    expect(h.transport.isAuthoritativelyIdle).toBe(false);

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: idleRunState(2),
    });
    expect(h.transport.isAuthoritativelyIdle).toBe(true);

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: {
        ...runningRunState(3),
        run_id: "run_not_canonical",
      },
    });
    expect(h.transport.runState).toEqual({ version: 1, cursor: 3, state: "unknown" });
    expect(h.transport.isAuthoritativelyIdle).toBe(false);

    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: {},
    });
    expect(h.transport.runState).toEqual({ version: null, cursor: null, state: "unknown" });
    expect(h.transport.isAuthoritativelyIdle).toBe(false);
    h.transport.close();
  });

  it.each([1008, 4001])(
    "treats policy close %s as terminal and never starts a reconnect loop",
    async (closeCode) => {
    const h = harness([
      "access_token_first_1234567890",
      "access_token_never_used_123456",
    ]);
    await connect(h);
    expect(h.transport.isAuthoritativelyIdle).toBe(true);

    h.sockets[0].serverClose(closeCode, "private policy reason");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(h.transport.state).toBe("closed");
    expect(h.transport.isReady).toBe(false);
    expect(h.transport.isAuthoritativelyIdle).toBe(false);
    expect(h.sockets).toHaveLength(1);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "socket_policy_closed",
        recoverable: false,
      }),
    ]));
    expect(h.issues.map((issue) => issue.message).join(" "))
      .not.toContain("private policy reason");
    },
  );

  it("self-closes with the app protocol code and reconnects when the snapshot never arrives", async () => {
    const h = harness([
      "access_token_first_1234567890",
      "access_token_second_1234567890",
    ], { snapshotTimeoutMs: 10 });
    const pending = h.transport.connect();
    await waitFor(() => h.sockets.length === 1);
    h.sockets[0].open();

    await expect(pending).rejects.toMatchObject({ code: "snapshot_timeout" });
    expect(h.sockets[0].closes).toEqual([
      { code: 4002, reason: "Authoritative snapshot required." },
    ]);

    await waitFor(() => h.sockets.length === 2);
    h.sockets[1].open();
    h.sockets[1].serverMessage(sessionSnapshot(1));
    await waitFor(() => h.transport.state === "open");
    expect(h.transport.isReady).toBe(true);
    expect(h.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "snapshot_timeout", recoverable: true }),
    ]));
    expect(h.issues.map((issue) => issue.code)).not.toContain("socket_policy_closed");
    h.transport.close();
  });

  it("reports a bounded invalid-event detail, self-closes with 4002, and resynchronizes", async () => {
    const h = harness([
      "access_token_first_1234567890",
      "access_token_second_1234567890",
      "access_token_third_1234567890",
    ]);
    await connect(h);

    const corruptFrame = `{"broken": ${"x".repeat(300)}`;
    h.sockets[0].serverRawMessage(corruptFrame);

    expect(h.sockets[0].closes).toEqual([
      { code: 4002, reason: "Invalid authoritative event." },
    ]);
    expect(h.issues).toEqual([{
      code: "malformed_server_event",
      message: "The authoritative server event is not valid JSON.",
      recoverable: true,
      detail: "The authoritative server event is not valid JSON."
        + ` | event: ${corruptFrame.slice(0, 200)}`,
    }]);

    await waitFor(() => h.sockets.length === 2);
    h.sockets[1].open();
    h.sockets[1].serverMessage(sessionSnapshot(2));
    await waitFor(() => h.transport.state === "open");

    h.sockets[1].serverRawMessage(12_345);
    expect(h.sockets[1].closes).toEqual([
      { code: 4002, reason: "Invalid authoritative event." },
    ]);
    expect(h.issues[1]).toEqual({
      code: "binary_server_event_forbidden",
      message: "The authoritative server event must be a text frame.",
      recoverable: true,
      detail: "The authoritative server event must be a text frame."
        + " | event: [non-string frame: number]",
    });

    await waitFor(() => h.sockets.length === 3);
    expect(h.issues.map((issue) => issue.code)).not.toContain("socket_policy_closed");
    h.transport.close();
  });

  it("publishes recursively immutable sanitized snapshots without encrypted reasoning material", async () => {
    const h = harness();
    let observed: FirstPartyThinAgentServerEvent | null = null;
    h.transport.addAuthoritativeFrameListener((event) => {
      if (event.kind !== "session_snapshot") return;
      const message = event.messages[0] as Readonly<Record<string, unknown>>;
      const parts = message.parts as readonly Readonly<Record<string, unknown>>[];
      const nested = parts[0].nested as Record<string, unknown>;
      nested.visible = "mutated by the first listener";
    });
    h.transport.addAuthoritativeFrameListener((event) => {
      observed = event;
    });

    const ready = h.transport.connect();
    await waitFor(() => h.sockets.length === 1);
    h.sockets[0].open();
    h.sockets[0].serverMessage(sessionSnapshot(1, [assistantMessage("assistant_1", [{
      type: "reasoning",
      encryptedContent: "ciphertext-one",
      nested: {
        encrypted_content: "ciphertext-two",
        visible: "safe summary",
      },
    }])]));
    await ready;

    expect(observed).toMatchObject({ kind: "session_snapshot" });
    if (!observed || observed.kind !== "session_snapshot") throw new Error("Snapshot missing.");
    const message = observed.messages[0] as Readonly<Record<string, unknown>>;
    const parts = message.parts as readonly Readonly<Record<string, unknown>>[];
    const nested = parts[0].nested as Readonly<Record<string, unknown>>;
    expect(parts[0]).not.toHaveProperty("encryptedContent");
    expect(nested).not.toHaveProperty("encrypted_content");
    expect(nested.visible).toBe("safe summary");
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(parts)).toBe(true);
    expect(Object.isFrozen(parts[0])).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    h.transport.close();
  });

  it.each([
    { conversation_id: "Private.md" },
    { client_instance_id: "client_not-safe" },
    { server_run_id: "run_not-safe" },
    { incident_id: "incident_not-safe" },
    { request_id: "https:private.example.com" },
    { plugin_build_id: "file:Private.md" },
    { run_id: "data:text/plain,private" },
    { tool_call_id: "obsidian:Private.md" },
    { request_id: "wss:private.example.com" },
    { request_id: "www.private.example.com" },
  ])("rejects content-shaped diagnostic identity %# without sending it", async (identity) => {
    const h = harness();
    await connect(h);
    const sent = h.sockets[0].sent.length;

    expect(() => h.transport.sendDiagnostic({
      version: 1,
      severity: "warn",
      code: "render_delayed",
      phase: "render",
      ...identity,
    })).toThrow("diagnostic identity");
    expect(h.sockets[0].sent).toHaveLength(sent);
    h.transport.close();
  });

  it("accepts 512-character tool-call IDs and rejects 513 characters", async () => {
    const h = harness();
    await connect(h);
    const valid = "c".repeat(512);
    const invalid = "c".repeat(513);
    h.transport.sendToolResult({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_result",
      request_id: requestId,
      tool_call_id: valid,
      tool_name: "read",
      state: "output-available",
      output: { ok: true },
    });
    h.transport.sendApproval({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_approval",
      request_id: requestId,
      tool_call_id: valid,
      approved: true,
    });
    expect(() => h.transport.sendToolResult({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_result",
      request_id: requestId,
      tool_call_id: invalid,
      tool_name: "read",
      state: "output-available",
      output: null,
    })).toThrow("tool result identity");
    expect(() => h.transport.sendApproval({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_approval",
      request_id: requestId,
      tool_call_id: invalid,
      approved: true,
    })).toThrow("tool approval");
    expect(h.sockets[0].sent).toHaveLength(2);
    h.transport.close();
  });

  it("accepts equivalent same-cursor future run states without trusting them as idle", async () => {
    const h = harness();
    const ready = h.transport.connect();
    await waitFor(() => h.sockets.length === 1);
    h.sockets[0].open();
    h.sockets[0].serverMessage({
      ...sessionSnapshot(4),
      run_state: {
        version: 1,
        cursor: 4,
        state: "future_server_state",
        future_detail: "one",
      },
    });
    await ready;
    h.sockets[0].serverMessage({
      type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
      version: 1,
      kind: "run_state",
      conversation_id: conversationId,
      run_state: {
        version: 1,
        cursor: 4,
        state: "future_server_state",
        future_detail: "two",
      },
    });

    expect(h.sockets[0].readyState).toBe(1);
    expect(h.transport.runState).toEqual({ version: 1, cursor: 4, state: "unknown" });
    expect(h.transport.isAuthoritativelyIdle).toBe(false);
    h.transport.close();
  });

  it("sends only exact first-party commands and the existing bounded diagnostic frame", async () => {
    const h = harness();
    await connect(h);
    const contextRef = `ctx1_${"A".repeat(43)}.${"B".repeat(43)}`;
    const submit = {
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1 as const,
      kind: "submit" as const,
      request_id: requestId,
      user_message: {
        id: rootMessageId,
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Inspect the vault." }],
      },
      context_ref: contextRef,
    };
    h.transport.sendSubmit(submit);
    h.transport.sendSubmit({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "regenerate",
      request_id: "request_2",
      root_message_id: rootMessageId,
    });
    h.transport.sendToolResult({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_result",
      request_id: requestId,
      tool_call_id: "call_1",
      tool_name: "read",
      state: "output-available",
      output: { success: true, content: "Bounded result" },
    });
    h.transport.sendToolResult({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_result",
      request_id: requestId,
      tool_call_id: "call_2",
      tool_name: "write",
      state: "output-error",
      error_text: "The write failed.",
    });
    h.transport.sendApproval({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_approval",
      request_id: requestId,
      tool_call_id: "call_2",
      approved: false,
    });
    h.transport.sendCancel({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "cancel",
      request_id: requestId,
    });
    h.transport.sendDiagnostic({
      version: 1,
      severity: "warn",
      code: "render_delayed",
      phase: "render",
      conversation_id: conversationId,
      request_id: requestId,
      retryable: true,
    });

    expect(h.sockets[0].sent.map((value) => JSON.parse(value))).toEqual([
      submit,
      expect.objectContaining({ kind: "regenerate", root_message_id: rootMessageId }),
      expect.objectContaining({ kind: "client_tool_result", state: "output-available" }),
      expect.objectContaining({ kind: "client_tool_result", state: "output-error" }),
      expect.objectContaining({ kind: "client_tool_approval", approved: false }),
      expect.objectContaining({ kind: "cancel", request_id: requestId }),
      {
        type: FIRST_PARTY_THIN_AGENT_DIAGNOSTIC_TYPE,
        payload: {
          version: 1,
          severity: "warn",
          code: "render_delayed",
          phase: "render",
          conversation_id: conversationId,
          request_id: requestId,
          retryable: true,
        },
      },
    ]);

    expect(() => h.transport.sendSubmit({
      ...submit,
      transcript: [{ role: "assistant", content: "Client authority" }],
    } as unknown as typeof submit)).toThrow("unsupported fields");
    expect(h.sockets[0].sent).toHaveLength(7);
    h.transport.close();
  });
});
