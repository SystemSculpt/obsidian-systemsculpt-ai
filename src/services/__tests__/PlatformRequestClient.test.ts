import { requestUrl } from "obsidian";
import { PlatformContext } from "../PlatformContext";
import { PlatformRequestClient } from "../PlatformRequestClient";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  requestUrl: jest.fn(),
}));

jest.mock("../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(),
  },
}));

describe("PlatformRequestClient", () => {
  const preferredTransport = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    preferredTransport.mockReset();
    preferredTransport.mockReturnValue("fetch");
    (PlatformContext.get as jest.Mock).mockReturnValue({
      preferredTransport,
    });
  });

  it("uses fetch when the platform prefers fetch", async () => {
    const client = new PlatformRequestClient();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as any;

    const response = await client.request({
      url: "https://api.systemsculpt.com/api/v1/chat/completions",
      method: "POST",
      body: { ok: true },
      stream: false,
      licenseKey: "license",
      headers: {
        "x-plugin-version": "4.15.0",
      },
    });

    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.systemsculpt.com/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-license-key": "license",
          "x-plugin-version": "4.15.0",
        }),
        body: JSON.stringify({ ok: true }),
        cache: "no-store",
      })
    );
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("falls back to requestUrl when fetch fails before a streaming request", async () => {
    const client = new PlatformRequestClient();
    global.fetch = jest.fn().mockRejectedValue(new Error("Failed to fetch")) as any;
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      text: "data: [DONE]\n\n",
      json: null,
    });

    const response = await client.request({
      url: "https://api.systemsculpt.com/api/v1/chat/completions",
      method: "POST",
      body: { ok: true },
      stream: true,
      licenseKey: "license",
    });

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.systemsculpt.com/api/v1/chat/completions",
        method: "POST",
        body: JSON.stringify({ ok: true }),
        headers: expect.objectContaining({
          "x-license-key": "license",
          Accept: "text/event-stream",
        }),
        throw: false,
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("does not replay through requestUrl when transport fallback is forbidden", async () => {
    const client = new PlatformRequestClient();
    const failure = new Error("Outcome unknown");
    global.fetch = jest.fn().mockRejectedValue(failure) as any;

    await expect(client.request({
      url: "https://api.systemsculpt.com/api/v1/chat/completions",
      method: "POST",
      body: { purpose: "workflow_automation" },
      stream: false,
      licenseKey: "license",
      allowTransportFallback: false,
    })).rejects.toBe(failure);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("forces requestUrl for a raw ArrayBuffer without adding or changing signed headers", async () => {
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
      headers: { "content-type": "audio/wav", "x-amz-meta-part": "1" },
      body,
      bodyEncoding: "raw",
      transport: "requestUrl",
      preserveResponseHeaders: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(PlatformContext.get).not.toHaveBeenCalled();
    expect(preferredTransport).not.toHaveBeenCalled();
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

  it("rejects a non-ArrayBuffer raw body before selecting a transport", async () => {
    const client = new PlatformRequestClient();

    await expect(client.request({
      url: "https://signed.example.com/upload",
      method: "PUT",
      body: "not raw bytes",
      bodyEncoding: "raw",
      transport: "requestUrl",
    })).rejects.toThrow("Raw platform request bodies must be an ArrayBuffer");

    expect(PlatformContext.get).not.toHaveBeenCalled();
    expect(preferredTransport).not.toHaveBeenCalled();
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
      url: "https://api.systemsculpt.com/api/plugin/images/generations/jobs/job/outputs/0",
      method: "GET",
      headers: { "x-request-id": "output-1" },
      licenseKey: "license",
      transport: "requestUrl",
      responseEncoding: "arrayBuffer",
      preserveResponseHeaders: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(PlatformContext.get).not.toHaveBeenCalled();
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
});
