import { WebResearchApiService } from "../web/WebResearchApiService";

describe("WebResearchApiService", () => {
  function harness() {
    const webSearch = jest.fn(async ({ prepare }: { prepare: () => unknown }) => {
      const body = prepare();
      return {
        ...(body as object),
        query: "systemsculpt",
        fetchedAt: "2026-07-12T00:00:00.000Z",
        results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }],
      };
    });
    const webFetch = jest.fn(async ({ prepare }: { prepare: () => unknown }) => {
      const body = prepare() as { url: string };
      return {
        url: body.url,
        finalUrl: body.url,
        title: "Example",
        markdown: "content",
        contentType: "text/html",
        fetchedAt: "2026-07-12T00:00:00.000Z",
        truncated: false,
      };
    });
    const plugin = {
      getManagedProductIntegrationClient: () => ({ webSearch, webFetch }),
    } as any;
    return { service: new WebResearchApiService(plugin), webSearch, webFetch };
  }

  it("routes search through the fixed managed product method with lazy content and caller idempotency", async () => {
    const { service, webSearch } = harness();
    const response = await service.search({ query: "systemsculpt", maxResults: 3 });

    expect(response.results).toHaveLength(1);
    expect(webSearch).toHaveBeenCalledTimes(1);
    const call = webSearch.mock.calls[0][0];
    expect(call.idempotencyKey).toMatch(/^web-search:[0-9]+:[a-z0-9]+$/);
    expect(call.prepare()).toEqual({ query: "systemsculpt", maxResults: 3 });
  });

  it("routes corpus fetch through the fixed managed method and supplies idempotency", async () => {
    const { service, webFetch } = harness();
    const response = await service.fetch({ url: "https://example.com", maxChars: 1000 });

    expect(response.markdown).toBe("content");
    const call = webFetch.mock.calls[0][0];
    expect(call.idempotencyKey).toMatch(/^web-fetch:[0-9]+:[a-z0-9]+$/);
    expect(call.prepare()).toEqual({ url: "https://example.com", maxChars: 1000 });
  });
});
