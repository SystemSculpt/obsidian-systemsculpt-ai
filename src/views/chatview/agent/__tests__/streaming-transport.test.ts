import {
  AgentStreamingTransport,
} from "../StreamingTransport";

const CONVERSATION_ID = `conversation_${"a".repeat(32)}`;
const CLIENT_ID = `client_${"b".repeat(32)}`;

function bootstrapRequest() {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: CONVERSATION_ID,
    client_id: CLIENT_ID,
    plugin_build_id: `sha256:${"e".repeat(64)}`,
    capability_manifest: {
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{ id: "obsidian.vault", version: 1 }],
    },
  } as never;
}

function bootstrapResponse() {
  return new Response(JSON.stringify({
    contract_version: "thin-agent-v1",
    conversation_id: CONVERSATION_ID,
    session: { id: `session_${"c".repeat(32)}` },
    access: {
      token: "access_token_streaming_transport",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
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
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function snapshotResponse(): Response {
  return new Response(JSON.stringify({
    type: "systemsculpt.agent.event.v1",
    version: 1,
    kind: "session_snapshot",
    conversation_id: CONVERSATION_ID,
    messages: [],
    run_state: { version: 1, cursor: 0, state: "idle" },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(frames: readonly unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function characterChunkedSseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const character of text) controller.enqueue(encoder.encode(character));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function harness(
  frames: readonly unknown[],
  initialSnapshot?: unknown,
  isAuthoritativeFrame?: (value: unknown) => boolean,
) {
  const calls: Array<Record<string, unknown>> = [];
  const request = jest.fn(async (input: Record<string, unknown>) => {
    calls.push(input);
    const url = String(input.url);
    if (url.includes("/agent/bootstrap")) return bootstrapResponse();
    if (url.includes("/get-messages")) {
      return initialSnapshot === undefined
        ? snapshotResponse()
        : new Response(JSON.stringify(initialSnapshot), { status: 200 });
    }
    return sseResponse(frames);
  });
  const transport = new AgentStreamingTransport({
    baseUrl: "https://systemsculpt.test",
    licenseKey: () => "license_test",
    pluginVersion: "6.2.7",
    bootstrapRequest,
    requestClient: { request } as never,
    ...(isAuthoritativeFrame ? { isAuthoritativeFrame } : {}),
  });
  return { transport, calls, request };
}

function submit(id: string) {
  return {
    type: "systemsculpt.agent.command.v1",
    version: 1,
    kind: "submit",
    request_id: id,
    user_message: { id, role: "user", parts: [{ type: "text", text: "hi" }] },
  } as never;
}

describe("AgentStreamingTransport", () => {
  it("streams a turn's authoritative frames and settles when the stream ends", async () => {
    const turnId = "user_stream_ok";
    const { transport, calls } = harness([
      { type: "systemsculpt.agent.event.v1", version: 1, kind: "run_state" },
      { type: "systemsculpt.agent.event.v1", version: 1, kind: "terminal" },
    ]);
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });

    await transport.connect();
    await transport.sendSubmit(submit(turnId));

    // The promise resolving is the turn boundary: the server closed the
    // stream, so there is nothing left to wait on.
    // connect() synchronizes first, so the snapshot leads the turn's frames.
    expect(seen).toEqual(["session_snapshot", "run_state", "terminal"]);
    expect(transport.state).toBe("open");
    const turnCall = calls.find((call) => String(call.url).includes("/agent/turn"));
    expect(turnCall).toMatchObject({
      method: "POST",
      url: "https://systemsculpt.test/api/plugin/agent/turn",
      headers: { Authorization: "Bearer access_token_streaming_transport" },
    });
  });

  it("reuses one validated bootstrap for identity, context, and turns", async () => {
    const { transport, calls } = harness([
      { type: "systemsculpt.agent.event.v1", version: 1, kind: "terminal" },
    ]);

    await transport.connect();
    const bootstrap = await transport.bootstrap();
    await transport.sendSubmit(submit("user_one"));
    await transport.sendSubmit(submit("user_two"));

    expect(bootstrap.conversation_id).toBe(CONVERSATION_ID);
    const bootstraps = calls.filter((call) =>
      String(call.url).includes("/agent/bootstrap"));
    expect(bootstraps).toHaveLength(1);
  });

  it.each([
    {
      type: "systemsculpt.agent.event.v1",
      version: 1,
      kind: "run_state",
      conversation_id: CONVERSATION_ID,
      run_state: { version: 1, cursor: 0, state: "idle" },
    },
    { invalid: true },
    {
      type: "systemsculpt.agent.event.v1",
      version: 1,
      kind: "session_snapshot",
      conversation_id: CONVERSATION_ID,
      messages: [],
      run_state: { version: 1, cursor: 0, state: "idle" },
      queued_request_ids: ["request_duplicate", "request_duplicate"],
    },
    {
      type: "systemsculpt.agent.event.v1",
      version: 1,
      kind: "session_snapshot",
      conversation_id: CONVERSATION_ID,
      messages: [],
      run_state: { version: 1, cursor: 0, state: "idle" },
      cancelled_queued_request_ids: null,
    },
  ])("requires a valid authoritative session snapshot before opening", async (
    initialSnapshot,
  ) => {
    const { transport } = harness([], initialSnapshot);

    await expect(transport.connect())
      .rejects.toThrow("unusable chat snapshot");

    expect(transport.state).toBe("closed");
  });

  it("does not truncate authoritative history at the legacy message cap", async () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      id: `message_history_${index}`,
      role: "user",
      parts: [{ type: "text", text: `Message ${index}` }],
    }));
    const { transport } = harness([], {
      type: "systemsculpt.agent.event.v1",
      version: 1,
      kind: "session_snapshot",
      conversation_id: CONVERSATION_ID,
      messages,
      run_state: { version: 1, cursor: 1, state: "idle" },
    });
    const snapshots: unknown[] = [];
    transport.addAuthoritativeFrameListener((frame) => snapshots.push(frame));

    await transport.connect();

    expect(transport.state).toBe("open");
    expect((snapshots[0] as { messages: unknown[] }).messages).toHaveLength(300);
  });

  it.each([
    [
      "oversized",
      () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(65 * 1024 * 1024) },
      }),
      "oversized chat snapshot",
    ],
    [
      "empty",
      () => new Response(null, { status: 200 }),
      "unusable chat snapshot",
    ],
  ])("rejects an %s snapshot response", async (
    _case,
    response,
    message,
  ) => {
    const { transport, request } = harness([]);
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) return bootstrapResponse();
      if (url.includes("/get-messages")) return response();
      return sseResponse([]);
    });

    await expect(transport.connect()).rejects.toThrow(message);
    expect(transport.state).toBe("closed");
  });

  it("does not open when its authoritative-frame validator rejects the snapshot", async () => {
    const { transport } = harness([], undefined, () => false);

    await expect(transport.connect())
      .rejects.toThrow("unusable chat snapshot");
    expect(transport.state).toBe("closed");
  });

  it("accepts multiline CRLF data at an unterminated stream boundary", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });
    request.mockResolvedValueOnce(new Response([
      "event: message",
      "data: {\"type\":\"systemsculpt.agent.event.v1\"",
      "data: ,\"version\":1,\"kind\":\"terminal\"}",
    ].join("\r\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    await transport.sendSubmit(submit("user_crlf"));

    expect(seen).toEqual(["terminal"]);
  });

  it("parses split SSE boundaries in linear-sized fragment batches", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });
    const terminal = JSON.stringify({
      type: "systemsculpt.agent.event.v1",
      version: 1,
      kind: "terminal",
    });
    request.mockResolvedValueOnce(characterChunkedSseResponse(
      `data: ${" ".repeat(8_192)}${terminal}\r\n\r\n`,
    ));

    await transport.sendSubmit(submit("user_tiny_chunks"));

    expect(seen).toEqual(["terminal"]);
  });

  it("invalidates an unauthorized bootstrap before restoring synchronization", async () => {
    const { transport, calls, request } = harness([]);
    let turnRequests = 0;
    request.mockImplementation(async (input: Record<string, unknown>) => {
      calls.push(input);
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) return bootstrapResponse();
      if (url.includes("/get-messages")) return snapshotResponse();
      turnRequests += 1;
      return turnRequests === 1
        ? new Response(null, { status: 401 })
        : sseResponse([]);
    });

    await transport.connect();
    await expect(transport.sendSubmit(submit("user_unauthorized")))
      .rejects.toThrow("could not run");
    await transport.connect();

    expect(calls.filter((call) =>
      String(call.url).includes("/agent/bootstrap"))).toHaveLength(2);
    expect(transport.state).toBe("open");
  });

  it("refreshes access invalidated by another session route", async () => {
    const { transport, calls } = harness([]);
    await transport.connect();

    transport.invalidateBootstrap();
    await transport.bootstrap();

    expect(calls.filter((call) =>
      String(call.url).includes("/agent/bootstrap"))).toHaveLength(2);
  });

  it("rejects bootstrap failure and cannot reconnect after close", async () => {
    const failed = harness([]);
    failed.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(failed.transport.connect()).rejects.toThrow("could not start");
    expect(failed.transport.state).toBe("closed");

    failed.transport.close();
    await expect(failed.transport.connect()).rejects.toThrow("connection is closed");
  });

  it("does not bootstrap or send after close", async () => {
    const { transport, calls } = harness([]);
    transport.close();

    await expect(transport.sendSubmit(submit("user_closed"))).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("marks a failed command unsynchronized so its owner can restore state", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(transport.sendSubmit(submit("user_uncertain")))
      .rejects.toThrow("could not run");

    expect(transport.state).toBe("closed");
  });

  it("aborts every concurrent turn stream when it closes", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    const turnSignals: AbortSignal[] = [];
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const signal = input.signal as AbortSignal;
      turnSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });

    const first = transport.sendSubmit(submit("user_concurrent_one"));
    const second = transport.sendSubmit(submit("user_concurrent_two"));
    while (turnSignals.length < 2) await Promise.resolve();
    transport.close();

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    expect(turnSignals.every((signal) => signal.aborted)).toBe(true);
    expect(transport.state).toBe("closed");
  });

  it("does not publish a stale overlapping synchronization response", async () => {
    const { transport, request } = harness([]);
    let releaseFirst!: (response: Response) => void;
    let snapshotRequests = 0;
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) return bootstrapResponse();
      snapshotRequests += 1;
      if (snapshotRequests === 1) {
        return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      }
      return snapshotResponse();
    });
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });

    const stale = transport.connect();
    while (!releaseFirst) await Promise.resolve();
    await transport.connect();
    releaseFirst(new Response("{not json", { status: 200 }));

    await expect(stale).resolves.toBeUndefined();
    expect(seen).toEqual(["session_snapshot"]);
    expect(transport.state).toBe("open");
  });

  it("does not deliver a stale turn callback after a newer synchronization opens", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });
    let staleController: ReadableStreamDefaultController<Uint8Array> | null = null;
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) return bootstrapResponse();
      if (url.includes("/get-messages")) return snapshotResponse();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { staleController = controller; },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const staleTurn = transport.sendSubmit(submit("user_stale_reconnect"));
    while (!staleController) await Promise.resolve();
    await transport.connect();
    const controller = staleController as ReadableStreamDefaultController<Uint8Array>;
    controller.enqueue(new TextEncoder().encode(
      'data: {"type":"systemsculpt.agent.event.v1","version":1,"kind":"terminal"}\n\n',
    ));
    controller.close();
    await staleTurn;

    expect(seen).toEqual(["session_snapshot"]);
    expect(transport.state).toBe("open");
  });

  it("cancels a dormant turn stream and settles it when the transport closes", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });
    let turnRequested = false;
    const streamCancelled = jest.fn();
    request.mockImplementationOnce(async () => {
      turnRequested = true;
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { streamCancelled(); },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const staleTurn = transport.sendSubmit(submit("user_stale_close"));
    while (!turnRequested) await Promise.resolve();
    transport.close();
    await staleTurn;

    expect(streamCancelled).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(transport.state).toBe("closed");
  });

  it("closes synchronization when a streamed event is malformed", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    request.mockResolvedValueOnce(new Response("data: {not json\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    await expect(transport.sendSubmit(submit("user_malformed")))
      .rejects.toThrow("invalid session event");
    expect(transport.state).toBe("closed");
  });

  it("ignores a frame it cannot parse rather than surfacing partial state", async () => {
    const { transport } = harness([]);
    await transport.connect();
    // Listen after synchronizing so only the malformed chunk could appear.
    const seen: unknown[] = [];
    transport.addAuthoritativeFrameListener((frame) => seen.push(frame));

    // Reach the private emitter the way a truncated stream chunk would.
    (transport as unknown as { emit: (chunk: string) => void })
      .emit("data: {not json");

    expect(seen).toEqual([]);
  });

  it("rejects a command of the wrong kind for each sender", async () => {
    const { transport } = harness([]);
    await transport.connect();
    const wrongSubmit = submit("user_wrong");
    const cancel = {
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "cancel",
      request_id: "user_wrong",
    } as never;

    await expect(transport.sendSubmit(cancel)).rejects.toThrow("submit and regenerate");
    await expect(transport.sendToolResult(wrongSubmit)).rejects.toThrow("client tool results");
    await expect(transport.sendApproval(wrongSubmit)).rejects.toThrow("client tool approvals");
    await expect(transport.sendCancel(wrongSubmit)).rejects.toThrow("cancellation commands");
  });
});
