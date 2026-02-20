import { requestUrl } from "obsidian";
import { PlatformContext } from "../PlatformContext";
import { WebResearchApiService } from "../web/WebResearchApiService";

describe("WebResearchApiService", () => {
  const originalFetch = globalThis.fetch;
  let platformGetSpy: jest.SpyInstance;

  const buildPluginStub = () =>
    ({
      settings: {
        licenseKey: "license-key",
        licenseValid: true,
      },
      manifest: {
        version: "4.13.0",
      },
    }) as any;

  beforeEach(() => {
    (requestUrl as jest.Mock).mockReset();
    (globalThis as any).fetch = jest.fn();
    platformGetSpy = jest.spyOn(PlatformContext, "get");
    platformGetSpy.mockReturnValue({
      preferredTransport: jest.fn(() => "fetch"),
    } as any);
  });

  afterEach(() => {
    platformGetSpy?.mockRestore();
  });

  afterAll(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("sends plugin contract headers for web_search", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        query: "systemsculpt",
        fetchedAt: "2026-02-18T00:00:00.000Z",
        results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }],
      }),
    });

    const service = new WebResearchApiService(buildPluginStub());
    const response = await service.search({ query: "systemsculpt", maxResults: 3 });

    expect(response.results).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(init.headers["x-license-key"]).toBe("license-key");
    expect(init.headers["x-plugin-version"]).toBe("4.13.0");
    expect(init.headers["Idempotency-Key"]).toMatch(/^web-search:\d+:[a-z0-9]+$/);
  });

  it("falls back to requestUrl when fetch transport fails", async () => {
    (globalThis.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      json: {
        query: "fallback path",
        fetchedAt: "2026-02-18T00:00:00.000Z",
        results: [{ title: "Fallback", url: "https://example.org", snippet: "Snippet" }],
      },
    });

    const service = new WebResearchApiService(buildPluginStub());
    const response = await service.search({ query: "fallback path" });

    expect(response.results[0].title).toBe("Fallback");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    const args = (requestUrl as jest.Mock).mock.calls[0][0];
    expect(args.headers["x-plugin-version"]).toBe("4.13.0");
    expect(args.headers["Idempotency-Key"]).toMatch(/^web-search:\d+:[a-z0-9]+$/);
  });

  it("sends plugin version on web_fetch without forcing idempotency key", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        url: "https://example.com",
        finalUrl: "https://example.com",
        title: "Example",
        markdown: "content",
        contentType: "text/html",
        fetchedAt: "2026-02-18T00:00:00.000Z",
        truncated: false,
      }),
    });

    const service = new WebResearchApiService(buildPluginStub());
    await service.fetch({ url: "https://example.com" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(init.headers["x-plugin-version"]).toBe("4.13.0");
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
  });
});
