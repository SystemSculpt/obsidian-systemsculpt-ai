import { requestUrl } from "obsidian";
import {
  AgentStreamingTransport,
  type AgentTransportTimingEvent,
} from "../StreamingTransport";
import {
  PlatformRequestClient,
  type PlatformResponseDeliveryMode,
} from "../../../../services/PlatformRequestClient";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  requestUrl: jest.fn(),
}));

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
  timing?: Readonly<{
    monotonicNow: () => number;
    onTiming: (event: AgentTransportTimingEvent) => void;
    classifyResponseDelivery?: (
      response: Response,
    ) => PlatformResponseDeliveryMode | undefined;
  }>,
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
    ...timing,
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

function toolResult(requestId: string, toolCallId: string) {
  return {
    type: "systemsculpt.agent.command.v1",
    version: 1,
    kind: "client_tool_result",
    request_id: requestId,
    tool_call_id: toolCallId,
    tool_name: "read",
    state: "output-available",
    output: { success: true },
  } as never;
}

function regenerate(id: string) {
  return {
    type: "systemsculpt.agent.command.v1",
    version: 1,
    kind: "regenerate",
    request_id: id,
    root_message_id: "user_original",
  } as never;
}

describe("AgentStreamingTransport", () => {
  it("opens after authoritative synchronization without awaiting observational prewarm", async () => {
    let releasePrewarm!: () => void;
    const prewarm = new Promise<boolean>((resolve) => {
      releasePrewarm = () => resolve(true);
    });
    const request = jest.fn(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) return bootstrapResponse();
      if (url.includes("/get-messages")) return snapshotResponse();
      return sseResponse([]);
    });
    const prewarmStreamingFetch = jest.fn(() => prewarm);
    const transport = new AgentStreamingTransport({
      baseUrl: "https://systemsculpt.test",
      licenseKey: () => "license_test",
      pluginVersion: "6.3.1",
      bootstrapRequest,
      requestClient: { request, prewarmStreamingFetch } as never,
    });

    await transport.connect();
    expect(transport.state).toBe("open");
    expect(prewarmStreamingFetch).toHaveBeenCalledTimes(1);
    releasePrewarm();
    await prewarm;
  });

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
      preserveResponseHeaders: true,
      streamingProbeUrl: "https://systemsculpt.test/api/plugin/connectivity",
      allowTransportFallback: false,
    });
  });

  it("selects requestUrl once before a supported-host turn when the CORS probe fails", async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockRejectedValue(
      new TypeError("Direct CORS fetch is unavailable on this host."),
    );
    global.fetch = fetchMock as typeof fetch;
    const nativeRequest = requestUrl as jest.Mock;
    nativeRequest.mockImplementation(async (input: { url: string }) => {
      if (input.url.endsWith("/agent/bootstrap")) {
        const encoded = new TextEncoder().encode(await bootstrapResponse().text());
        return {
          status: 200,
          arrayBuffer: encoded.buffer,
          text: "",
          json: null,
          headers: { "content-type": "application/json" },
        };
      }
      if (input.url.endsWith("/get-messages")) {
        const text = await snapshotResponse().text();
        return {
          status: 200,
          arrayBuffer: new ArrayBuffer(0),
          text,
          json: JSON.parse(text),
          headers: { "content-type": "application/json" },
        };
      }
      return {
        status: 200,
        arrayBuffer: new ArrayBuffer(0),
        text: `data: ${JSON.stringify({
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "run_state",
        })}\n\ndata: ${JSON.stringify({
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "terminal",
        })}\n\n`,
        json: null,
        headers: { "content-type": "text/event-stream" },
      };
    });
    const timingEvents: AgentTransportTimingEvent[] = [];
    const transport = new AgentStreamingTransport({
      baseUrl: "https://systemsculpt.test",
      licenseKey: () => "license_test",
      pluginVersion: "6.2.7",
      bootstrapRequest,
      requestClient: new PlatformRequestClient(),
      monotonicNow: () => 50,
      onTiming: (event) => timingEvents.push(event),
    });
    const seen: string[] = [];
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push(frame.kind);
    });

    try {
      await transport.connect();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://systemsculpt.test/api/plugin/connectivity",
        expect.objectContaining({ method: "GET" }),
      );
      await transport.sendSubmit(submit("user_native_buffered"));

      // The submit consumes the prewarmed failure decision; it does not put a
      // new connectivity round trip on the state-changing command's TTFT.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const stateChangingRequests = nativeRequest.mock.calls.filter(
        ([input]) => input.url.endsWith("/agent/turn"),
      );
      expect(stateChangingRequests).toHaveLength(1);
      expect(stateChangingRequests[0]?.[0]).toMatchObject({
        method: "POST",
        body: JSON.stringify(submit("user_native_buffered")),
      });
      expect(seen).toEqual(["session_snapshot", "run_state", "terminal"]);
      expect(timingEvents).toEqual([
        expect.objectContaining({
          milestone: "command_dispatch_started",
          observedAtMonotonicMs: 50,
        }),
        expect.objectContaining({
          milestone: "response_available",
          observedAtMonotonicMs: 50,
          responseDeliveryMode: "request_url_buffered",
        }),
        expect.objectContaining({
          milestone: "first_body_chunk",
          observedAtMonotonicMs: 50,
          responseDeliveryMode: "request_url_buffered",
        }),
        expect.objectContaining({
          milestone: "first_sse_frame",
          observedAtMonotonicMs: 50,
          responseDeliveryMode: "request_url_buffered",
        }),
      ]);
      expect(timingEvents.every((event) =>
        event.requestId === "user_native_buffered"
        && event.commandKind === "submit"
        && event.commandSegmentOrdinal === 1)).toBe(true);
      expect(transport.state).toBe("open");
    } finally {
      transport.close();
      nativeRequest.mockReset();
      global.fetch = originalFetch;
    }
  });

  it("reports response availability, body observation, and parsed frame once for fetch_stream", async () => {
    const responseDeliveryMode = "fetch_stream" as const;
    const timingEvents: AgentTransportTimingEvent[] = [];
    let now = 10;
    const { transport, request } = harness([], undefined, undefined, {
      monotonicNow: () => now,
      onTiming: (event) => timingEvents.push(event),
      classifyResponseDelivery: () => responseDeliveryMode,
    });
    await transport.connect();

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    request.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    }), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-systemsculpt-agent-latency-trace": "f".repeat(32),
        "server-timing": "app;dur=12.3456, auth;dur=2.5, private;desc=ignored",
      },
    }));

    const pending = transport.sendSubmit(submit("user_timing"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timingEvents).toEqual([
      expect.objectContaining({
        milestone: "command_dispatch_started",
        requestId: "user_timing",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 10,
      }),
      expect.objectContaining({
        milestone: "response_available",
        requestId: "user_timing",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 10,
        status: 200,
        responseDeliveryMode,
        latencyTraceId: "f".repeat(32),
        serverTimingAppMs: 12.346,
        serverTimingAuthMs: 2.5,
      }),
    ]);

    now = 20;
    controller.enqueue(new TextEncoder().encode(
      'data: {"type":"systemsculpt.agent.event.v1","version":1,"kind":"run_state"}',
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timingEvents.map((event) => event.milestone)).toEqual([
      "command_dispatch_started",
      "response_available",
      "first_body_chunk",
    ]);

    now = 30;
    controller.enqueue(new TextEncoder().encode("\n\n"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timingEvents.map((event) => event.milestone)).toEqual([
      "command_dispatch_started",
      "response_available",
      "first_body_chunk",
      "first_sse_frame",
    ]);
    controller.enqueue(new TextEncoder().encode(
      'data: {"type":"systemsculpt.agent.event.v1","version":1,"kind":"terminal"}\n\n',
    ));
    controller.close();
    await pending;

    expect(timingEvents.map((event) => event.milestone)).toEqual([
      "command_dispatch_started",
      "response_available",
      "first_body_chunk",
      "first_sse_frame",
    ]);
    expect(timingEvents.filter((event) => event.milestone !== "command_dispatch_started")
      .every((event) => event.responseDeliveryMode === responseDeliveryMode)).toBe(true);
    expect(timingEvents.every((event) =>
      event.commandKind === "submit"
      && event.commandSegmentOrdinal === 1)).toBe(true);
    expect(timingEvents.filter((event) => event.milestone !== "command_dispatch_started")
      .every((event) => event.latencyTraceId === "f".repeat(32))).toBe(true);
  });

  it("assigns distinct joinable ordinals to every command segment in one run", async () => {
    const timingEvents: AgentTransportTimingEvent[] = [];
    const { transport } = harness([
      { type: "systemsculpt.agent.event.v1", version: 1, kind: "terminal" },
    ], undefined, undefined, {
      monotonicNow: () => 17,
      onTiming: (event) => timingEvents.push(event),
    });
    await transport.connect();

    await transport.sendSubmit(submit("user_segment_join"));
    await transport.sendToolResult(toolResult("user_segment_join", "call_segment_join"));

    const dispatches = timingEvents.filter((event) =>
      event.milestone === "command_dispatch_started");
    expect(dispatches).toEqual([
      expect.objectContaining({
        requestId: "user_segment_join",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
      }),
      expect.objectContaining({
        requestId: "user_segment_join",
        commandKind: "client_tool_result",
        commandSegmentOrdinal: 2,
        toolCallId: "call_segment_join",
      }),
    ]);
    expect(timingEvents.filter((event) => event.commandSegmentOrdinal === 1)
      .every((event) => event.commandKind === "submit")).toBe(true);
    expect(timingEvents.filter((event) => event.commandSegmentOrdinal === 2)
      .every((event) => event.commandKind === "client_tool_result"
        && event.toolCallId === "call_segment_join")).toBe(true);
  });

  it("orders exact ACK, assistant, and terminal segment timing around delivery", async () => {
    const requestId = "user_exact_segment_frames";
    const toolCallId = "call_exact_segment_frames";
    const responseDeliveryMode = "fetch_stream" as const;
    const chronology: string[] = [];
    const timingEvents: AgentTransportTimingEvent[] = [];
    const frames = [
      {
        type: "systemsculpt.agent.event.v1",
        version: 1,
        kind: "command_ack",
        conversation_id: CONVERSATION_ID,
        request_id: requestId,
        command_kind: "client_tool_result",
        tool_call_id: toolCallId,
        status: "accepted",
      },
      {
        type: "systemsculpt.agent.event.v1",
        version: 1,
        kind: "assistant_snapshot",
        conversation_id: CONVERSATION_ID,
        request_id: requestId,
        message: {
          id: "assistant_exact_segment_frames",
          role: "assistant",
          parts: [{ type: "text", text: "Continued", state: "streaming" }],
        },
      },
      {
        type: "systemsculpt.agent.event.v1",
        version: 1,
        kind: "terminal",
        conversation_id: CONVERSATION_ID,
        request_id: requestId,
        terminal: {
          version: 1,
          run_id: `run_${"d".repeat(32)}`,
          root_message_id: requestId,
          outcome: "succeeded",
          code: "completed",
        },
      },
    ];
    const { transport } = harness(frames, undefined, undefined, {
      monotonicNow: () => 29,
      onTiming: (event) => {
        timingEvents.push(event);
        if (event.milestone.includes("assistant")
          || event.milestone.includes("ack")
          || event.milestone.includes("terminal")) {
          chronology.push(`timing:${event.milestone}`);
        }
      },
      classifyResponseDelivery: () => responseDeliveryMode,
    });
    transport.addAuthoritativeFrameListener((frame) => {
      if (["command_ack", "assistant_snapshot", "terminal"].includes(frame.kind)) {
        chronology.push(`frame:${frame.kind}`);
      }
    });
    await transport.connect();

    await transport.sendToolResult(toolResult(requestId, toolCallId));

    expect(chronology).toEqual([
      "timing:command_ack_sse_frame",
      "frame:command_ack",
      "timing:command_ack_sse_frame_delivery_completed",
      "timing:first_assistant_sse_frame",
      "frame:assistant_snapshot",
      "timing:assistant_sse_frame_delivery_completed",
      "timing:terminal_sse_frame",
      "frame:terminal",
      "timing:terminal_sse_frame_delivery_completed",
    ]);
    expect(timingEvents.filter((event) =>
      event.milestone.includes("assistant")
      || event.milestone.includes("ack")
      || event.milestone.includes("terminal")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          requestId,
          commandKind: "client_tool_result",
          commandSegmentOrdinal: 1,
          toolCallId,
          responseDeliveryMode,
        }),
      ]));
  });

  it("keeps sparse timing diagnostics non-blocking at an unterminated boundary", async () => {
    const timingEvents: AgentTransportTimingEvent[] = [];
    const onTiming = jest.fn((event: AgentTransportTimingEvent) => {
      timingEvents.push(event);
      throw new Error("The optional timing observer failed.");
    });
    const { transport, request } = harness([], undefined, undefined, {
      monotonicNow: () => Number.NaN,
      onTiming,
    });
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
    request.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode(`data: ${terminal}`));
        controller.close();
      },
    }), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-systemsculpt-agent-latency-trace": "not-a-trace",
        "server-timing": 'app;dur="7.25", auth;desc=ignored',
      },
    }));

    await expect(transport.sendSubmit(submit("user_sparse_timing")))
      .resolves.toBeUndefined();

    expect(seen).toEqual(["terminal"]);
    expect(timingEvents).toEqual([
      {
        milestone: "command_dispatch_started",
        requestId: "user_sparse_timing",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 0,
      },
      {
        milestone: "response_available",
        requestId: "user_sparse_timing",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 0,
        status: 200,
        serverTimingAppMs: 7.25,
      },
      {
        milestone: "first_body_chunk",
        requestId: "user_sparse_timing",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 0,
      },
      {
        milestone: "first_sse_frame",
        requestId: "user_sparse_timing",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 0,
      },
    ]);
    expect(timingEvents.every(Object.isFrozen)).toBe(true);
    expect(onTiming).toHaveBeenCalledTimes(4);
    expect(transport.state).toBe("open");
  });

  it("falls back to a platform clock when the injected timing clock fails", async () => {
    const timingEvents: AgentTransportTimingEvent[] = [];
    const { transport } = harness([
      { type: "systemsculpt.agent.event.v1", version: 1, kind: "terminal" },
    ], undefined, undefined, {
      monotonicNow: () => {
        throw new Error("The injected monotonic clock failed.");
      },
      onTiming: (event) => timingEvents.push(event),
    });
    await transport.connect();

    await expect(transport.sendSubmit(submit("user_clock_fallback")))
      .resolves.toBeUndefined();

    expect(timingEvents).not.toHaveLength(0);
    expect(timingEvents.every((event) =>
      Number.isFinite(event.observedAtMonotonicMs)
      && event.observedAtMonotonicMs >= 0)).toBe(true);
    expect(transport.state).toBe("open");
  });

  it("ignores malformed timing metrics and does not count SSE metadata as a frame", async () => {
    const timingEvents: AgentTransportTimingEvent[] = [];
    const { transport, request } = harness([], undefined, undefined, {
      monotonicNow: () => 42,
      onTiming: (event) => timingEvents.push(event),
    });
    await transport.connect();
    const seen: unknown[] = [];
    transport.addAuthoritativeFrameListener((frame) => seen.push(frame));
    request.mockResolvedValueOnce(new Response(": heartbeat\nretry: 1000\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "server-timing": "app;dur=NaN, auth;dur=NaN",
      },
    }));

    await expect(transport.sendSubmit(submit("user_metadata_only")))
      .resolves.toBeUndefined();

    expect(seen).toEqual([]);
    expect(timingEvents).toEqual([
      {
        milestone: "command_dispatch_started",
        requestId: "user_metadata_only",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 42,
      },
      {
        milestone: "response_available",
        requestId: "user_metadata_only",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 42,
        status: 200,
      },
      {
        milestone: "first_body_chunk",
        requestId: "user_metadata_only",
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        observedAtMonotonicMs: 42,
      },
    ]);
    expect(transport.state).toBe("open");
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
    await expect(failed.transport.forceReconnect()).rejects.toThrow("connection is closed");
  });

  it("preserves safe root error metadata from a failed bootstrap", async () => {
    const failed = harness([]);
    failed.request.mockResolvedValueOnce(new Response(JSON.stringify({
      code: "unauthorized_agent_session",
      incident_id: "incident_0123456789abcdef0123456789abcdef",
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    await expect(failed.transport.connect()).rejects.toMatchObject({
      code: "unauthorized_agent_session",
      requestId: "incident_0123456789abcdef0123456789abcdef",
      status: 401,
      retryable: true,
    });
  });

  it("ignores unstructured bootstrap error bodies", async () => {
    const failed = harness([]);
    failed.request.mockResolvedValueOnce(new Response(JSON.stringify("service detail"), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));

    const failure = await failed.transport.connect().catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503, retryable: true });
    expect(failure).not.toHaveProperty("code");
    expect(failure).not.toHaveProperty("requestId");
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

  it("treats HTTP 402 as definite non-admission without recovery replay", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    request.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "insufficient_credits",
        message: "private provider and vault data must not surface",
      },
      incident_id: `incident_${"a".repeat(32)}`,
    }), {
      status: 402,
      headers: { "content-type": "application/json" },
    }));

    const error = await transport.sendSubmit(submit("user_payment"))
      .catch((caught) => caught as Error & Record<string, unknown>);

    expect(error).toMatchObject({
      code: "insufficient_credits",
      status: 402,
      serverAdmissionPossible: false,
      requestId: `incident_${"a".repeat(32)}`,
    });
    expect(error.message).not.toContain("private provider");
    expect(transport.state).toBe("open");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("preserves a safe code for a definitely rejected command", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    request.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "conversation_capacity_reached",
        message: "This chat reached its history limit.",
      },
    }), {
      status: 413,
      headers: { "content-type": "application/json" },
    }));

    await expect(transport.sendSubmit(submit("user_capacity"))).rejects
      .toMatchObject({
        code: "conversation_capacity_reached",
        status: 413,
        serverAdmissionPossible: false,
      });
    expect(transport.state).toBe("open");
  });

  it("preserves a safe nested incident while dropping an unsafe error code", async () => {
    const { transport, request } = harness([]);
    await transport.connect();
    request.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "UNSAFE-CODE",
        incident_id: `incident_${"b".repeat(32)}`,
      },
    }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }));

    const error = await transport.sendSubmit(submit("user_nested_incident"))
      .catch((caught) => caught as Error & Record<string, unknown>);

    expect(error).toMatchObject({
      requestId: `incident_${"b".repeat(32)}`,
      status: 422,
      serverAdmissionPossible: false,
    });
    expect(error).not.toHaveProperty("code");
    expect(transport.state).toBe("open");
  });

  it.each([
    ["submit", submit("user_payment_submit")],
    ["regenerate", regenerate("request_payment_regenerate")],
  ])("treats a 402 %s rejection as definite non-admission", async (_kind, command) => {
    const { transport, request } = harness([]);
    await transport.connect();
    request.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "insufficient_credits",
        message: "Not enough credits are available.",
      },
    }), {
      status: 402,
      headers: { "content-type": "application/json" },
    }));

    await expect(transport.sendSubmit(command)).rejects.toMatchObject({
      code: "insufficient_credits",
      status: 402,
      serverAdmissionPossible: false,
    });
    expect(transport.state).toBe("open");
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

  it("force-reconnects from a dead-open tool result, fences its late ACK, and retires its reader", async () => {
    const { transport, request } = harness([]);
    const seen: string[] = [];
    const requestId = "user_dead_open_reconnect";
    const toolCallId = "call_dead_open_reconnect";
    transport.addAuthoritativeFrameListener((frame) => {
      seen.push((frame as { kind: string }).kind);
    });
    await transport.connect();
    seen.length = 0;

    let staleController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let releaseSnapshot: ((response: Response) => void) | null = null;
    const streamCancelled = jest.fn();
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/get-messages")) {
        return await new Promise<Response>((resolve) => { releaseSnapshot = resolve; });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { staleController = controller; },
        cancel() { streamCancelled(); },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const staleTurn = transport.sendToolResult(toolResult(requestId, toolCallId));
    while (!staleController) await Promise.resolve();
    const recovery = transport.forceReconnect();
    while (!releaseSnapshot) await Promise.resolve();

    // The replacement generation is already active while its snapshot is
    // gated, so the orphaned command's late ACK cannot settle a replay even
    // before its reader is physically cancelled.
    const controller = staleController as ReadableStreamDefaultController<Uint8Array>;
    controller.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({
        type: "systemsculpt.agent.event.v1",
        version: 1,
        kind: "command_ack",
        conversation_id: CONVERSATION_ID,
        request_id: requestId,
        command_kind: "client_tool_result",
        tool_call_id: toolCallId,
        status: "accepted",
      })}\n\n`,
    ));
    releaseSnapshot(snapshotResponse());

    await recovery;
    await staleTurn;
    expect(seen).toEqual(["session_snapshot"]);
    expect(streamCancelled).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe("open");
  });

  it("retires a silent superseded turn only after replacement authority settles", async () => {
    const { transport, request } = harness([]);
    await transport.connect();

    let staleController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let staleSignal: AbortSignal | null = null;
    let releaseSnapshot: ((response: Response) => void) | null = null;
    const streamCancelled = jest.fn();
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/get-messages")) {
        return await new Promise<Response>((resolve) => { releaseSnapshot = resolve; });
      }
      staleSignal = input.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { staleController = controller; },
        cancel() { streamCancelled(); },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const staleTurn = transport.sendSubmit(submit("user_silent_dead_open_reconnect"));
    while (!staleController || !staleSignal) await Promise.resolve();
    const recovery = transport.forceReconnect();
    while (!releaseSnapshot) await Promise.resolve();

    expect((staleSignal as AbortSignal).aborted).toBe(false);
    expect(streamCancelled).not.toHaveBeenCalled();

    releaseSnapshot(snapshotResponse());
    await recovery;
    await staleTurn;

    expect((staleSignal as AbortSignal).aborted).toBe(true);
    expect(streamCancelled).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe("open");
  });

  it("contains a stale turn error while replacement synchronization is gated", async () => {
    const { transport, request } = harness([]);
    await transport.connect();

    let staleController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let releaseSnapshot: ((response: Response) => void) | null = null;
    request.mockImplementation(async (input: Record<string, unknown>) => {
      const url = String(input.url);
      if (url.includes("/get-messages")) {
        return await new Promise<Response>((resolve) => { releaseSnapshot = resolve; });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { staleController = controller; },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const staleTurn = transport.sendSubmit(submit("user_stale_error_during_reconnect"));
    while (!staleController) await Promise.resolve();
    const recovery = transport.forceReconnect();
    while (!releaseSnapshot) await Promise.resolve();

    (staleController as ReadableStreamDefaultController<Uint8Array>)
      .error(new Error("orphaned Worker stream failed"));
    await expect(staleTurn).resolves.toBeUndefined();
    expect(transport.state).toBe("connecting");

    releaseSnapshot(snapshotResponse());
    await recovery;
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
