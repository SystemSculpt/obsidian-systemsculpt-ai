import fixture from "../../../../testing/fixtures/managed/product-integrations-v1.json";
import { PlatformRequestClient, type PlatformRequestInput } from "../../PlatformRequestClient";
import {
  ManagedProductIntegrationClient,
  ManagedProductIntegrationError,
} from "../ManagedProductIntegrationClient";

class QueueRequestClient extends PlatformRequestClient {
  readonly inputs: PlatformRequestInput[] = [];
  readonly responses: Response[] = [];

  override async request(input: PlatformRequestInput): Promise<Response> {
    this.inputs.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("Missing deterministic response");
    return response;
  }
}

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const contractHeaders = {
  "content-type": "application/json",
  "x-request-id": REQUEST_ID,
  "x-systemsculpt-product-contract": "product-integrations-v1",
};

function jsonResponse(body: unknown, status = 200, headers = contractHeaders): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function createHarness(outcome: "allowed" | "license_required" = "allowed") {
  const requestClient = new QueueRequestClient();
  const admission = jest.fn(async () => ({ outcome }));
  const licenseKey = jest.fn(() => "license-secret");
  const client = new ManagedProductIntegrationClient({
    baseUrl: "https://systemsculpt.com/",
    pluginVersion: "6.0.0",
    licenseKey,
    acquireAdmission: admission,
    requestClient,
    createRequestId: () => REQUEST_ID,
  });
  return { client, requestClient, admission, licenseKey };
}

describe("ManagedProductIntegrationClient", () => {
  it("consumes the exact product-integrations-v1 fixture and exposes no generic request escape hatch", () => {
    expect(fixture.contract_version).toBe("product-integrations-v1");
    expect(fixture.operations.plugin_release_info.path).toBe("/api/plugin/plugins/{pluginId}/latest");
    const { client } = createHarness();
    expect((client as unknown as Record<string, unknown>).request).toBeUndefined();
  });

  it("acquires licensed admission before evaluating lazy web-search content", async () => {
    const { client, requestClient, admission, licenseKey } = createHarness("license_required");
    const prepare = jest.fn(() => ({ query: "private query", maxResults: 3 }));

    await expect(client.webSearch({ prepare, idempotencyKey: "web-search:stable" }))
      .rejects.toMatchObject({ name: "ManagedProductIntegrationError", code: "authentication_failed" });

    expect(admission).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(licenseKey).not.toHaveBeenCalled();
    expect(requestClient.inputs).toHaveLength(0);
  });

  it("sends and validates a fixed licensed web-search request", async () => {
    const { client, requestClient } = createHarness();
    requestClient.responses.push(jsonResponse({
      query: "systemsculpt",
      results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }],
      fetchedAt: "2026-07-12T00:00:00.000Z",
    }));

    const result = await client.webSearch({
      prepare: () => ({ query: "systemsculpt", maxResults: 3 }),
      idempotencyKey: "web-search:stable",
    });

    expect(result.results).toHaveLength(1);
    expect(requestClient.inputs).toEqual([expect.objectContaining({
      url: "https://systemsculpt.com/api/plugin/web/search",
      method: "POST",
      licenseKey: "license-secret",
      body: { query: "systemsculpt", max_results: 3 },
      headers: expect.objectContaining({
        "x-plugin-version": "6.0.0",
        "x-request-id": REQUEST_ID,
        "x-systemsculpt-product-contract": "product-integrations-v1",
        "Idempotency-Key": "web-search:stable",
      }),
    })]);
  });

  it("requires a stable caller idempotency key for web fetch and uses the fixed route", async () => {
    const { client, requestClient } = createHarness();
    await expect(client.webFetch({
      prepare: () => ({ url: "https://example.com" }),
      idempotencyKey: "has spaces",
    })).rejects.toThrow("idempotency");
    expect(requestClient.inputs).toHaveLength(0);

    requestClient.responses.push(jsonResponse({
      url: "https://example.com",
      finalUrl: "https://example.com/final",
      title: null,
      markdown: "# Example",
      contentType: "text/html",
      fetchedAt: "2026-07-12T00:00:00.000Z",
      truncated: false,
    }));
    const response = await client.webFetch({
      prepare: () => ({ url: "https://example.com", maxChars: 1000 }),
      idempotencyKey: "web-fetch:stable",
    });
    expect(response.markdown).toBe("# Example");
    expect(requestClient.inputs[0]).toMatchObject({
      url: "https://systemsculpt.com/api/plugin/web/fetch",
      body: { url: "https://example.com", max_chars: 1000 },
    });
  });

  it("starts and polls YouTube through only the declared job routes", async () => {
    const { client, requestClient } = createHarness();
    requestClient.responses.push(
      jsonResponse({ status: "job_started", jobId: "job-1", checkUrl: "/api/plugin/youtube/transcripts/job-1" }),
      jsonResponse({ status: "pending", jobId: "job-1" }),
    );

    const started = await client.startYouTubeTranscript({
      prepare: () => ({ url: "https://www.youtube.com/watch?v=ABCDEFGHIJK", lang: "en" }),
      idempotencyKey: "youtube:stable",
    });
    const pending = await client.getYouTubeTranscriptStatus({ jobId: "job-1" });

    expect(started).toEqual({ status: "job_started", jobId: "job-1", checkUrl: "/api/plugin/youtube/transcripts/job-1" });
    expect(pending).toEqual({ status: "pending", jobId: "job-1" });
    expect(requestClient.inputs.map((input) => [input.method, input.url])).toEqual([
      ["POST", "https://systemsculpt.com/api/plugin/youtube/transcripts"],
      ["GET", "https://systemsculpt.com/api/plugin/youtube/transcripts/job-1"],
    ]);
  });

  it("loads public latest release without consulting admission or license state", async () => {
    const { client, requestClient, admission, licenseKey } = createHarness("license_required");
    requestClient.responses.push(jsonResponse({
      status: "success",
      data: {
        pluginId: "systemsculpt-ai",
        latestVersion: "6.0.1",
        releaseUrl: null,
        publishedAt: null,
        critical: false,
        yanked: false,
      },
    }));

    const release = await client.latestPluginRelease({ includePrerelease: true });

    expect(release.data.latestVersion).toBe("6.0.1");
    expect(admission).not.toHaveBeenCalled();
    expect(licenseKey).not.toHaveBeenCalled();
    expect(requestClient.inputs[0]).toMatchObject({
      url: "https://systemsculpt.com/api/plugin/plugins/systemsculpt-ai/latest?includePrerelease=true",
      method: "GET",
    });
    expect(requestClient.inputs[0].licenseKey).toBeUndefined();
  });

  it("rejects mismatched request IDs, forbidden fields, and malformed errors without leaking bodies", async () => {
    const { client, requestClient } = createHarness();
    requestClient.responses.push(jsonResponse(
      { query: "q", results: [], fetchedAt: "now" },
      200,
      { ...contractHeaders, "x-request-id": "wrong" },
    ));
    await expect(client.webSearch({ prepare: () => ({ query: "q" }), idempotencyKey: "web:q" }))
      .rejects.toThrow("invalid");

    requestClient.responses.push(jsonResponse({
      query: "q", results: [], fetchedAt: "now", provider: "secret-vendor",
    }));
    await expect(client.webSearch({ prepare: () => ({ query: "q" }), idempotencyKey: "web:q2" }))
      .rejects.not.toThrow("secret-vendor");

    requestClient.responses.push(jsonResponse({ raw: "license-secret" }, 500));
    const error = await client.webSearch({ prepare: () => ({ query: "q" }), idempotencyKey: "web:q3" })
      .catch((caught) => caught as Error);
    expect(error.message).not.toContain("license-secret");
  });

  it("returns a bounded typed first-party error", async () => {
    const { client, requestClient } = createHarness();
    requestClient.responses.push(jsonResponse({
      status: "error",
      error: { code: "rate_limited", message: "Please retry later." },
      requestId: REQUEST_ID,
    }, 429));

    const error = await client.startYouTubeTranscript({
      prepare: () => ({ url: "https://www.youtube.com/watch?v=ABCDEFGHIJK" }),
      idempotencyKey: "youtube:rate",
    }).catch((caught) => caught as ManagedProductIntegrationError);

    expect(error).toBeInstanceOf(ManagedProductIntegrationError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, requestId: REQUEST_ID });
    expect(error.message).toBe("Please retry later.");
  });
});
