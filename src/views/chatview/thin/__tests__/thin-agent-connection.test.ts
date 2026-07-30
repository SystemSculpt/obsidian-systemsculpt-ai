import {
  ThinAgentConnection,
  ThinAgentConnectionError,
  userSafeServiceCode,
  userSafeServiceMessage,
} from "../ThinAgentConnection";
import { parseThinAgentBootstrapResponse } from "../../../../services/managed/ThinAgentV1Contract";
import { ThinAgentLifecycle } from "../ThinAgentLifecycle";

const bootstrapRequest = {
  contract_version: "thin-agent-v1" as const,
  conversation_id: "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  client_id: "client_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  plugin_build_id: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  capability_manifest: {
    contract_version: "thin-agent-capabilities-v1" as const,
    capabilities: [{ id: "obsidian.vault" as const, version: 1 as const }],
  },
};

const bootstrapResponse = {
  contract_version: "thin-agent-v1",
  conversation_id: bootstrapRequest.conversation_id,
  session: { id: "session_dddddddddddddddddddddddddddddddd" },
  access: {
    token: "fixture.access.signature",
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
};

const refreshedBootstrapResponse = {
  ...bootstrapResponse,
  access: {
    token: "refreshed.access.signature",
    expires_at: "2030-01-01T00:02:00.000Z",
  },
};

describe("ThinAgentConnection bootstrap failures", () => {
  it("records ordered lifecycle frames without request content or connection secrets", async () => {
    const stagedResponse = {
      contract_version: "thin-agent-v1",
      context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      expires_at: "2030-01-01T02:00:00.000Z",
      bytes: 10,
      sha256: `sha256:${"e".repeat(64)}`,
    };
    const requestClient = {
      request: jest.fn(async ({ method, url }: { method: string; url: string }) => {
        if (url.endsWith("/api/plugin/agent/bootstrap")) {
          return new Response(JSON.stringify(bootstrapResponse), { status: 200 });
        }
        if (url.includes("/api/plugin/agent/context")) {
          return new Response(JSON.stringify(stagedResponse), { status: 201 });
        }
        if (method === "GET") return new Response("[]", { status: 200 });
        throw new Error("unexpected request");
      }),
    };
    const records: unknown[] = [];
    const lifecycle = new ThinAgentLifecycle((record) => records.push(record), () => records.length);
    const client = new EventTarget() as EventTarget & {
      ready: Promise<void>;
      send: jest.Mock;
      close: jest.Mock;
    };
    client.ready = Promise.resolve();
    client.send = jest.fn();
    client.close = jest.fn();
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "private-license",
      bootstrapRequest: () => bootstrapRequest,
      lifecycle,
      requestClient: requestClient as any,
      createAgentClient: (() => client) as any,
      createTransport: jest.fn(() => ({
        resetResumeState: jest.fn(),
      }) as any),
    });

    await connection.prepare();
    connection.connect();
    client.dispatchEvent(new Event("open"));
    const closeEvent = new Event("close") as CloseEvent;
    Object.defineProperties(closeEvent, {
      code: { value: 1006 },
      reason: { value: "private socket reason" },
    });
    client.dispatchEvent(closeEvent);
    await connection.stageContext("user-root", [{
      kind: "text",
      path: "Private.md",
      content: "private context content",
    }]);
    connection.disconnect();

    expect(records.map((record: any) => record.code)).toEqual([
      "response_prepare_started",
      "response_prepare_completed",
      "session_opened",
      "session_interrupted",
      "context_prepare_started",
      "response_prepare_started",
      "response_prepare_completed",
      "context_prepare_completed",
    ]);
    const serialized = JSON.stringify({
      records,
      frames: client.send.mock.calls.map(([frame]) => JSON.parse(frame)),
    });
    for (const forbidden of [
      "private-license",
      "fixture.access.signature",
      "Private.md",
      "private context content",
      "private socket reason",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("runs the complete native lifecycle with short-lived access reconnects", async () => {
    const history = [{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    }];
    const requestClient = {
      request: jest.fn(async ({ method }: { method: string }) =>
        method === "POST"
          ? new Response(JSON.stringify(bootstrapResponse), { status: 200 })
          : new Response(JSON.stringify(history), { status: 200 })),
    };
    let clientOptions: any;
    const client = new EventTarget() as EventTarget & {
      ready: Promise<void>;
      send: jest.Mock;
      close: jest.Mock;
    };
    client.ready = Promise.resolve();
    client.send = jest.fn();
    client.close = jest.fn();
    const transport = {
      cancelActiveServerTurn: jest.fn(() => true),
      resetResumeState: jest.fn(),
      handleStreamResuming: jest.fn(() => true),
      handleStreamResumeNone: jest.fn(() => true),
      handleStreamPending: jest.fn(() => true),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "http://example.com/",
      pluginVersion: "6.2.7",
      licenseKey: () => " license ",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
      createAgentClient: ((options: any) => {
        clientOptions = options;
        return client;
      }) as any,
      createTransport: jest.fn(() => transport as any),
    });

    await expect(connection.prepare()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "user-1" })],
      inputLimits: { maxImagesPerTurn: 6 },
    });
    expect(connection.sessionId).toBe(bootstrapResponse.session.id);
    connection.connect();
    connection.connect();
    expect(clientOptions).toMatchObject({
      agent: "SystemSculptAgent",
      host: "example.com",
      protocol: "ws",
      basePath: "api/plugin/agent/connect",
      defaultCallTimeout: 0,
    });
    await expect(clientOptions.query()).resolves.toEqual({
      access_token: bootstrapResponse.access.token,
    });
    await expect(clientOptions.query()).resolves.toEqual({
      access_token: bootstrapResponse.access.token,
    });
    expect(requestClient.request.mock.calls.filter(([request]) =>
      request.method === "POST")).toHaveLength(2);
    expect(connection.agentClient()).toBe(client);
    expect(connection.chatTransport()).toBe(transport);
    await expect(connection.whenReady()).resolves.toBeUndefined();
    expect(connection.cancel()).toBe(true);

    const buffered = new MessageEvent("message", { data: "buffered" });
    client.dispatchEvent(buffered);
    const messageListener = jest.fn();
    const detachMessage = connection.addMessageListener(messageListener);
    expect(messageListener).toHaveBeenCalledWith(buffered);
    client.dispatchEvent(new MessageEvent("message", { data: "live" }));
    expect(messageListener).toHaveBeenCalledTimes(2);
    detachMessage();

    const openListener = jest.fn();
    const closeListener = jest.fn();
    const detachOpen = connection.addOpenListener(openListener);
    const detachClose = connection.addCloseListener(closeListener);
    client.dispatchEvent(new Event("open"));
    client.dispatchEvent(new Event("close"));
    expect(openListener).toHaveBeenCalledTimes(1);
    expect(closeListener).toHaveBeenCalledTimes(1);
    detachOpen();
    detachClose();

    expect(connection.handleProtocolFrame(null)).toBe(false);
    expect(connection.handleProtocolFrame({
      type: "cf_agent_stream_resuming",
      id: "request-1",
    })).toBe(true);
    expect(connection.handleProtocolFrame({
      type: "cf_agent_stream_resume_none",
      probeId: "probe-1",
    })).toBe(true);
    expect(connection.handleProtocolFrame({
      type: "cf_agent_stream_pending",
    })).toBe(true);
    expect(connection.handleProtocolFrame({ type: "future-frame" })).toBe(false);

    connection.disconnect();
    expect(transport.resetResumeState).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledWith(1000, "Chat changed.");
    expect(connection.cancel()).toBe(false);
    expect(() => connection.agentClient()).toThrow("not ready");
    expect(() => connection.chatTransport()).toThrow("not ready");
    connection.close();
    connection.close();
    await expect(connection.prepare()).rejects.toThrow("no longer available");
    expect(() => connection.connect()).toThrow("no longer available");
  });

  it("dispatches buffered and live messages exactly once across repeated connect/disconnect cycles", async () => {
    const history = [{
      id: "user-reconnect",
      role: "user",
      parts: [{ type: "text", text: "Reconnect" }],
    }];
    const requestClient = {
      request: jest.fn(async ({ method }: { method: string }) =>
        method === "POST"
          ? new Response(JSON.stringify(bootstrapResponse), { status: 200 })
          : new Response(JSON.stringify(history), { status: 200 })),
    };
    const clients: Array<EventTarget & {
      ready: Promise<void>;
      send: jest.Mock;
      close: jest.Mock;
    }> = [];
    const transport = {
      cancelActiveServerTurn: jest.fn(() => true),
      resetResumeState: jest.fn(),
      handleStreamResuming: jest.fn(() => true),
      handleStreamResumeNone: jest.fn(() => true),
      handleStreamPending: jest.fn(() => true),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
      createAgentClient: (() => {
        const client = new EventTarget() as EventTarget & {
          ready: Promise<void>;
          send: jest.Mock;
          close: jest.Mock;
        };
        client.ready = Promise.resolve();
        client.send = jest.fn();
        client.close = jest.fn();
        clients.push(client);
        return client;
      }) as any,
      createTransport: jest.fn(() => transport as any),
    });
    const listener = jest.fn();

    await connection.prepare();
    connection.connect();
    const detachFirst = connection.addMessageListener(listener);
    clients[0].dispatchEvent(new MessageEvent("message", { data: "first-live" }));
    expect(listener).toHaveBeenCalledTimes(1);

    connection.disconnect();

    await connection.prepare();
    connection.connect();
    clients[1].dispatchEvent(new MessageEvent("message", { data: "second-buffered" }));
    const detachSecond = connection.addMessageListener(listener);
    clients[1].dispatchEvent(new MessageEvent("message", { data: "second-live" }));

    expect(listener.mock.calls.map(([event]) => (event as MessageEvent).data)).toEqual([
      "first-live",
      "second-buffered",
      "second-live",
    ]);

    detachFirst();
    detachSecond();
  });

  it("preserves bounded 429 diagnostics without adding a custom retry loop", async () => {
    const lifecycleRecords: unknown[] = [];
    const lifecycle = new ThinAgentLifecycle((record) => lifecycleRecords.push(record));
    const requestClient = {
      request: jest.fn(async () => new Response(JSON.stringify({
        error: {
          code: "provider_rate_limited",
          message: "The model provider is temporarily rate limited.",
          incident_id: "incident_dddddddddddddddddddddddddddddddd",
        },
      }), {
        status: 429,
        headers: { "Retry-After": "7" },
      })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
      lifecycle,
    });

    const error = await (connection as any).issueBootstrap()
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "SystemSculptSessionError",
      code: "response_start_rate_limited",
      status: 429,
      retryable: true,
      incidentId: "incident_dddddddddddddddddddddddddddddddd",
      retryAfterSeconds: 7,
      message: expect.stringContaining("Try again shortly."),
    });
    expect(error).not.toHaveProperty("serverCode");
    expect(error.message).not.toMatch(/provider|openrouter|cloudflare|protocol|socket/i);
    expect(requestClient.request).toHaveBeenCalledTimes(1);
    expect(lifecycleRecords).toEqual([
      expect.objectContaining({
        code: "response_prepare_started",
        phase: "start",
      }),
      expect.objectContaining({
        code: "response_prepare_failed",
        phase: "start",
        status: 429,
        retryable: true,
        incidentId: "incident_dddddddddddddddddddddddddddddddd",
      }),
    ]);
  });

  it("does not parse oversized or malformed error bodies", async () => {
    const requestClient = {
      request: jest.fn(async () => new Response(`{"message":"${"x".repeat(5_000)}"}`, {
        status: 503,
        headers: { "X-Request-Id": "request-safe" },
      })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });

    const error = await (connection as any).issueBootstrap().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ThinAgentConnectionError);
    expect(error).toMatchObject({
      code: "response_start_failed",
      status: 503,
      retryable: true,
      incidentId: "request-safe",
      message: "SystemSculpt could not start the response (503).",
    });
    expect(error.message).not.toContain("xxxxx");
  });

  it("strictly loads authoritative native history through short-lived access", async () => {
    const requestClient = {
      request: jest.fn(async ({ method }: { method: string }) =>
        method === "POST"
          ? new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 })
          : new Response(JSON.stringify([
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "Question" }],
            },
            {
              id: "assistant-1",
              role: "assistant",
              parts: [{ type: "text", text: "Answer" }],
            },
          ]), { status: 200 })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });
    (connection as any).bootstrap = {
      contract_version: "thin-agent-v1",
      conversation_id: bootstrapRequest.conversation_id,
      session: { id: "session_dddddddddddddddddddddddddddddddd" },
      access: {
        token: "fixture.access.signature",
        expires_at: "2030-01-01T00:01:00.000Z",
      },
      accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
    };

    await expect(connection.fetchAuthoritativeMessages()).resolves.toEqual([
      expect.objectContaining({ id: "user-1", role: "user" }),
      expect.objectContaining({ id: "assistant-1", role: "assistant" }),
    ]);
    expect(requestClient.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: "POST",
      url: "https://example.com/api/plugin/agent/bootstrap",
    }));
    expect(requestClient.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: "GET",
      url: "https://example.com/api/plugin/agent/connect/get-messages?access_token=refreshed.access.signature",
      responseEncoding: "arrayBuffer",
      maxResponseBytes: 32 * 1024 * 1024,
    }));
    for (const [request] of requestClient.request.mock.calls) {
      expect(request.headers).toEqual({ "x-plugin-version": "6.2.7" });
      expect(request.headers).not.toHaveProperty("x-systemsculpt-agent-protocol");
    }
  });

  it("accepts the canonical empty history of a newly initialized durable conversation", async () => {
    const requestClient = {
      request: jest.fn(async ({ method }: { method: string }) =>
        method === "POST"
          ? new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 })
          : new Response("[]", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });
    (connection as any).bootstrap = parseThinAgentBootstrapResponse(bootstrapResponse);

    await expect(connection.fetchAuthoritativeMessages()).resolves.toEqual([]);
  });

  it("never converts an ambiguous history failure into authoritative empty history", async () => {
    const requestClient = {
      request: jest.fn(async ({ method }: { method: string }) =>
        method === "POST"
          ? new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 })
          : new Response("upstream unavailable", { status: 503 })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });
    (connection as any).bootstrap = {
      contract_version: "thin-agent-v1",
      conversation_id: bootstrapRequest.conversation_id,
      session: { id: "session_dddddddddddddddddddddddddddddddd" },
      access: {
        token: "fixture.access.signature",
        expires_at: "2030-01-01T00:01:00.000Z",
      },
      accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
    };

    await expect(connection.fetchAuthoritativeMessages()).rejects.toMatchObject({
      code: "session_history_load_failed",
      status: 503,
      retryable: true,
    });
  });

  it("stages raw context once through short-lived access and returns only the opaque reference", async () => {
    const stagedResponse = {
      contract_version: "thin-agent-v1",
      context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      expires_at: "2030-01-01T02:00:00.000Z",
      bytes: 49,
      sha256: `sha256:${"e".repeat(64)}`,
    };
    const requestClient = {
      request: jest.fn(async ({ url }: { url: string }) =>
        url.endsWith("/api/plugin/agent/bootstrap")
          ? new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 })
          : new Response(JSON.stringify(stagedResponse), {
            status: 201,
          })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com/",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });
    (connection as any).bootstrap = parseThinAgentBootstrapResponse(bootstrapResponse);
    const signal = new AbortController().signal;
    const sources = [{
      kind: "text" as const,
      path: "Private.md",
      content: "raw private context",
    }];

    await expect(connection.stageContext("user-root", sources, signal))
      .resolves.toEqual(stagedResponse);
    expect(requestClient.request).toHaveBeenCalledTimes(2);
    expect(requestClient.request).toHaveBeenNthCalledWith(2, {
      url: "https://example.com/api/plugin/agent/context?access_token=refreshed.access.signature",
      method: "POST",
      headers: {
        "x-plugin-version": "6.2.7",
      },
      body: {
        contract_version: "thin-agent-v1",
        root_message_id: "user-root",
        context_sources: sources,
      },
      signal,
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
      maxResponseBytes: 16 * 1024,
    });
  });

  it("does not retry failed context staging or expose raw context through its error", async () => {
    const requestClient = {
      request: jest.fn(async ({ url }: { url: string }) =>
        url.endsWith("/api/plugin/agent/bootstrap")
          ? new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 })
          : new Response(JSON.stringify({
            error: {
              code: "agent_context_unavailable",
              message: "Context staging is temporarily unavailable.",
              incident_id: "incident_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
          }), { status: 503 })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });
    (connection as any).bootstrap = parseThinAgentBootstrapResponse(bootstrapResponse);

    const error = await connection.stageContext("user-root", [{
      kind: "text",
      path: "Secret.md",
      content: "never include this raw value",
    }]).catch((value: unknown) => value);

    expect(requestClient.request).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      code: "context_prepare_failed",
      status: 503,
      retryable: true,
      incidentId: "incident_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    expect(error).not.toHaveProperty("serverCode");
    expect(error.message).not.toContain("never include this raw value");
    expect(error.message).not.toContain("Secret.md");
  });

  it("presents expired context access naturally while preserving retry diagnostics", async () => {
    const requestClient = {
      request: jest.fn(async ({ url }: { url: string }) =>
        url.endsWith("/api/plugin/agent/bootstrap")
          ? new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 })
          : new Response(JSON.stringify({
            error: {
              code: "invalid_session_access",
              message: "This session has expired or is unavailable. Start the response again.",
              incident_id: "incident_ffffffffffffffffffffffffffffffff",
            },
          }), { status: 401 })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
    });
    (connection as any).bootstrap = parseThinAgentBootstrapResponse(bootstrapResponse);

    const error = await connection.stageContext("user-root", [])
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: "session_expired",
      status: 401,
      retryable: true,
      incidentId: "incident_ffffffffffffffffffffffffffffffff",
      message: "Your SystemSculpt session expired. Retry this message.",
    });
    expect(error.message).not.toMatch(/agent|connection|ticket|websocket/i);
  });

  it("passes cancellation into the one context staging request", async () => {
    const lifecycleRecords: any[] = [];
    const lifecycle = new ThinAgentLifecycle((record) => lifecycleRecords.push(record));
    const requestClient = {
      request: jest.fn(({ url, signal }: { url: string; signal?: AbortSignal }) =>
        url.endsWith("/api/plugin/agent/bootstrap")
          ? Promise.resolve(new Response(JSON.stringify(refreshedBootstrapResponse), { status: 200 }))
          : signal?.aborted
            ? Promise.reject(new DOMException("The operation was aborted", "AbortError"))
            : new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted", "AbortError"));
              }, { once: true });
            })),
    };
    const connection = new ThinAgentConnection({
      baseUrl: "https://example.com",
      pluginVersion: "6.2.7",
      licenseKey: () => "license",
      bootstrapRequest: () => bootstrapRequest,
      requestClient: requestClient as any,
      lifecycle,
    });
    (connection as any).bootstrap = parseThinAgentBootstrapResponse(bootstrapResponse);
    const controller = new AbortController();
    const staging = connection.stageContext("user-root", [], controller.signal);
    controller.abort();

    await expect(staging).rejects.toMatchObject({ name: "AbortError" });
    expect(requestClient.request).toHaveBeenCalledTimes(2);
    expect(lifecycleRecords.filter((record) =>
      record.code.startsWith("context_prepare_")).map((record) => record.code)).toEqual([
      "context_prepare_started",
      "context_prepare_cancelled",
    ]);
  });

  it("keeps internal service terminology out of public error codes and messages", () => {
    const fallbackMessage = "SystemSculpt could not complete the response. Retry this message.";
    for (const message of [
      "OpenRouter provider failed.",
      "Cloudflare WebSocket protocol error.",
      "Pi transport bootstrap failed.",
      "The AI SDK connection ticket expired.",
    ]) {
      expect(userSafeServiceMessage(message, fallbackMessage)).toBe(fallbackMessage);
    }
    for (const code of [
      "provider_failed",
      "openrouter_rate_limited",
      "cloudflare_protocol_error",
      "pi_transport_failed",
      "websocket_closed",
      "bootstrap_failed",
    ]) {
      expect(userSafeServiceCode(code, "response_failed")).toBe("response_failed");
    }
    expect(userSafeServiceMessage("The response was interrupted.", fallbackMessage))
      .toBe("The response was interrupted.");
    expect(userSafeServiceCode("session_interrupted", "response_failed"))
      .toBe("session_interrupted");
  });
});
