import {
  FirstPartyThinAgentStreamingTransport,
} from "../FirstPartyThinAgentStreamingTransport";

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
    access: {
      token: "access_token_streaming_transport",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
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

function harness(frames: readonly unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  const request = jest.fn(async (input: Record<string, unknown>) => {
    calls.push(input);
    return String(input.url).includes("/agent/bootstrap")
      ? bootstrapResponse()
      : sseResponse(frames);
  });
  const transport = new FirstPartyThinAgentStreamingTransport({
    baseUrl: "https://systemsculpt.test",
    licenseKey: () => "license_test",
    pluginVersion: "6.2.7",
    bootstrapRequest,
    requestClient: { request } as never,
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

describe("FirstPartyThinAgentStreamingTransport", () => {
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
    expect(seen).toEqual(["run_state", "terminal"]);
    expect(transport.state).toBe("open");
    const turnCall = calls.find((call) => String(call.url).includes("/agent/turn"));
    expect(turnCall?.method).toBe("POST");
    expect(String(turnCall?.url)).toContain("access_token=");
  });

  it("reuses one bootstrap across turns instead of re-authenticating each time", async () => {
    const { transport, calls } = harness([
      { type: "systemsculpt.agent.event.v1", version: 1, kind: "terminal" },
    ]);

    await transport.connect();
    await transport.sendSubmit(submit("user_one"));
    await transport.sendSubmit(submit("user_two"));

    // The socket transport bootstrapped on every reconnect, which is how one
    // turn came to open 37 of them.
    const bootstraps = calls.filter((call) =>
      String(call.url).includes("/agent/bootstrap"));
    expect(bootstraps).toHaveLength(1);
  });

  it("ignores a frame it cannot parse rather than surfacing partial state", async () => {
    const { transport } = harness([]);
    const seen: unknown[] = [];
    transport.addAuthoritativeFrameListener((frame) => seen.push(frame));

    await transport.connect();
    // Reach the private emitter the way a truncated stream chunk would.
    (transport as unknown as { emit: (chunk: string) => void })
      .emit("data: {not json");

    expect(seen).toEqual([]);
  });

  it("rejects a command of the wrong kind for its sender", async () => {
    const { transport } = harness([]);
    await transport.connect();

    await expect(transport.sendToolResult(submit("user_wrong")))
      .rejects.toThrow("client tool results");
  });
});
