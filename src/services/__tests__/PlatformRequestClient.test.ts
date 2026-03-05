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
      url: "https://api.systemsculpt.com/api/v1/agent/sessions",
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
      "https://api.systemsculpt.com/api/v1/agent/sessions",
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
      url: "https://api.systemsculpt.com/api/v1/agent/sessions",
      method: "POST",
      body: { ok: true },
      stream: true,
      licenseKey: "license",
    });

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.systemsculpt.com/api/v1/agent/sessions",
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
});
