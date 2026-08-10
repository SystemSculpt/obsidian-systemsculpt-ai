import { requestUrl } from "obsidian";
import {
  getPlatformResponseDeliveryMode,
  isSafeLoopbackHttpUrl,
  PlatformRequestClient,
} from "../PlatformRequestClient";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  requestUrl: jest.fn(),
}));

describe("PlatformRequestClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    "http://127.0.0.1:8787/api/plugin/license/validate",
    "http://localhost:8787/api/plugin/releases/latest",
    "http://[::1]:8787/api/plugin/credits/balance",
  ])("uses direct fetch for the exact safe loopback HTTP origin %s", async (url) => {
    const client = new PlatformRequestClient();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as any;

    await expect(client.request({ url, method: "GET" })).resolves.toMatchObject({
      status: 200,
    });

    expect(isSafeLoopbackHttpUrl(url)).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: "GET" }),
    );
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:8787/api/plugin/license/validate",
    "http://127.0.0.2:8787/api/plugin/license/validate",
    "http://user@localhost:8787/api/plugin/license/validate",
    "not a URL",
  ])("does not classify a non-exact loopback URL as safe: %s", (url) => {
    expect(isSafeLoopbackHttpUrl(url)).toBe(false);
  });

  it("never falls back to the native gateway after a loopback fetch failure", async () => {
    const client = new PlatformRequestClient();
    const failure = new Error("loopback worker unavailable");
    global.fetch = jest.fn().mockRejectedValue(failure) as any;
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      text: JSON.stringify({ ok: true }),
      json: { ok: true },
    });

    await expect(client.request({
      url: "http://127.0.0.1:8787/api/plugin/license/validate",
      method: "GET",
    })).rejects.toBe(failure);

    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("fails closed when a loopback request has no direct fetch implementation", async () => {
    const client = new PlatformRequestClient();
    const originalFetch = global.fetch;
    Object.defineProperty(global, "fetch", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    try {
      await expect(client.request({
        url: "http://127.0.0.1:8787/api/plugin/license/validate",
        method: "GET",
      })).rejects.toThrow("Direct loopback fetch is unavailable");
      expect(requestUrl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(global, "fetch", {
        value: originalFetch,
        writable: true,
        configurable: true,
      });
    }
  });

  it("uses direct fetch for streaming requests when fetch is available", async () => {
    const client = new PlatformRequestClient();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as any;

    const response = await client.request({
      url: "https://systemsculpt.com/api/plugin/chat/completions",
      method: "POST",
      body: { ok: true },
      stream: true,
      licenseKey: "license",
      headers: {
        "x-plugin-version": "4.15.0",
      },
    });

    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://systemsculpt.com/api/plugin/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-license-key": "license",
          "x-plugin-version": "4.15.0",
        }),
        body: JSON.stringify({ ok: true }),
      })
    );
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("observes the selected native transport without letting diagnostics alter delivery", async () => {
    const client = new PlatformRequestClient();
    const onTransportSelected = jest.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      text: JSON.stringify({ ok: true }),
      json: { ok: true },
      headers: { "Content-Type": "application/json" },
    });

    await expect(client.request({
      url: "https://systemsculpt.com/api/plugin/credits/balance",
      method: "GET",
      onTransportSelected,
    })).resolves.toMatchObject({ status: 200 });

    expect(onTransportSelected).toHaveBeenCalledTimes(1);
    expect(onTransportSelected).toHaveBeenCalledWith("requestUrl");
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("chooses requestUrl before a streaming POST when the replay-safe CORS probe fails", async () => {
    const client = new PlatformRequestClient();
    global.fetch = jest.fn().mockRejectedValue(new Error("Failed to fetch")) as any;
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      text: "data: [DONE]\n\n",
      json: null,
      headers: { "x-systemsculpt-response-delivery-mode": "fetch_stream" },
    });

    const response = await client.request({
      url: "https://systemsculpt.com/api/plugin/chat/completions",
      method: "POST",
      body: { ok: true },
      stream: true,
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      licenseKey: "license",
      streamingProbeUrl: "https://systemsculpt.com/api/plugin/connectivity",
    });

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://systemsculpt.com/api/plugin/chat/completions",
        method: "POST",
        body: JSON.stringify({ ok: true }),
        headers: expect.objectContaining({
          "x-license-key": "license",
          Accept: "text/event-stream",
        }),
        throw: false,
      })
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://systemsculpt.com/api/plugin/connectivity",
      expect.objectContaining({ method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-systemsculpt-response-delivery-mode"))
      .toBe("fetch_stream");
    expect(getPlatformResponseDeliveryMode(response)).toBe("request_url_buffered");
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight prewarm with an immediate streaming request", async () => {
    const client = new PlatformRequestClient();
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/plugin/connectivity")) {
        await probeGate;
        return new Response(null, { status: 204 });
      }
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const prewarm = client.prewarmStreamingFetch(
      "https://systemsculpt.com/api/plugin/connectivity",
    );
    await Promise.resolve();
    const request = client.request({
      url: "https://systemsculpt.com/api/plugin/agent/turn",
      method: "POST",
      body: { ok: true },
      stream: true,
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      streamingProbeUrl: "https://systemsculpt.com/api/plugin/connectivity",
    });
    await Promise.resolve();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    releaseProbe();
    await expect(prewarm).resolves.toBe(true);
    await expect(request).resolves.toMatchObject({ status: 200 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).endsWith("/api/plugin/connectivity"))).toHaveLength(1);
  });

  it("streams through fetch only after the replay-safe CORS probe succeeds", async () => {
    const client = new PlatformRequestClient();
    const probe = new Response("{}", { status: 426 });
    const streamed = new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce(streamed) as any;

    const response = await client.request({
      url: "https://systemsculpt.com/api/plugin/chat/completions",
      method: "POST",
      body: { ok: true },
      stream: true,
      licenseKey: "license",
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      streamingProbeUrl: "https://systemsculpt.com/api/plugin/connectivity",
    });

    expect(response).toBe(streamed);
    expect(getPlatformResponseDeliveryMode(response)).toBe("fetch_stream");
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://systemsculpt.com/api/plugin/connectivity",
      expect.objectContaining({ method: "GET" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://systemsculpt.com/api/plugin/chat/completions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ok: true }) }),
    );
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("does not replay through requestUrl when transport fallback is forbidden", async () => {
    const client = new PlatformRequestClient();
    const failure = new Error("Outcome unknown");
    global.fetch = jest.fn().mockRejectedValue(failure) as any;

    await expect(client.request({
      url: "https://systemsculpt.com/api/plugin/chat/completions",
      method: "POST",
      body: { purpose: "workflow_automation" },
      stream: true,
      licenseKey: "license",
      allowTransportFallback: false,
    })).rejects.toBe(failure);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("lets the host derive a validated Content-Length for raw requestUrl uploads", async () => {
    const client = new PlatformRequestClient();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const body = new Uint8Array([0, 1, 2, 255]).buffer;
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      text: "",
      json: null,
      headers: { ETag: '"0123456789abcdef"', "x-amz-request-id": "r2-1" },
    });

    const response = await client.request({
      url: "https://signed.example.com/upload?signature=exact",
      method: "PUT",
      headers: {
        "content-type": "audio/wav",
        "Content-Length": "4",
        "x-amz-meta-part": "1",
      },
      body,
      bodyEncoding: "raw",
      transport: "requestUrl",
      preserveResponseHeaders: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledWith({
      url: "https://signed.example.com/upload?signature=exact",
      method: "PUT",
      headers: { "content-type": "audio/wav", "x-amz-meta-part": "1" },
      body,
      throw: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"0123456789abcdef"');
    expect(response.headers.get("x-amz-request-id")).toBe("r2-1");
  });

  it("rejects a signed Content-Length that does not match the raw body", async () => {
    const client = new PlatformRequestClient();
    const body = new Uint8Array([0, 1, 2, 3]).buffer;

    await expect(client.request({
      url: "https://signed.example.com/upload?signature=exact",
      method: "PUT",
      headers: { "Content-Length": "5" },
      body,
      bodyEncoding: "raw",
      transport: "requestUrl",
    })).rejects.toThrow("Content-Length must match the ArrayBuffer size");

    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("rejects a non-ArrayBuffer raw body before selecting a transport", async () => {
    const client = new PlatformRequestClient();

    await expect(client.request({
      url: "https://signed.example.com/upload",
      method: "PUT",
      body: "not raw bytes",
      bodyEncoding: "raw",
      transport: "requestUrl",
    })).rejects.toThrow("Raw platform request bodies must be an ArrayBuffer");

    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("reconstructs a native binary response from untouched bytes and complete headers", async () => {
    const client = new PlatformRequestClient();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const bytes = new Uint8Array([0, 255, 128, 1]).buffer;
    const headers = {
      "Content-Type": "image/png",
      "Content-Length": "4",
      "X-Request-Id": "output-1",
      "X-SystemSculpt-Contract": "managed-capabilities-v2",
      "X-SystemSculpt-Image-Output-Contract": "managed-image-output-v1",
    };
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      headers,
      arrayBuffer: bytes,
      text: "\u0000��\u0001",
      json: null,
    });

    const response = await client.request({
      url: "https://systemsculpt.com/api/plugin/images/generations/jobs/job/outputs/0",
      method: "GET",
      headers: { "x-request-id": "output-1" },
      licenseKey: "license",
      transport: "requestUrl",
      responseEncoding: "arrayBuffer",
      preserveResponseHeaders: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "x-request-id": "output-1", "x-license-key": "license" }),
      throw: false,
    }));
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 128, 1]);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("x-request-id")).toBe("output-1");
    expect(response.headers.get("x-systemsculpt-contract")).toBe("managed-capabilities-v2");
    expect(response.headers.get("x-systemsculpt-image-output-contract")).toBe("managed-image-output-v1");
  });

  it("rejects an oversized native binary response before reconstructing another body", async () => {
    const client = new PlatformRequestClient();
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      headers: { "Content-Type": "image/png" },
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      text: "\u0001\u0002\u0003",
      json: null,
    });

    await expect(client.request({
      url: "https://systemsculpt.com/api/plugin/images/generations/jobs/job/outputs/0",
      method: "GET",
      transport: "requestUrl",
      responseEncoding: "arrayBuffer",
      maxResponseBytes: 2,
    })).rejects.toThrow("Native response exceeded the configured maximum size");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid maximum native response size %p before transport", async (maxResponseBytes) => {
    const client = new PlatformRequestClient();

    await expect(client.request({
      url: "https://systemsculpt.com/api/plugin/images/generations/jobs/job/outputs/0",
      method: "GET",
      transport: "requestUrl",
      responseEncoding: "arrayBuffer",
      maxResponseBytes,
    })).rejects.toThrow("Maximum platform response size must be a positive integer");

    expect(requestUrl).not.toHaveBeenCalled();
  });
});
