import type { ManagedCapabilityClient } from "../../../managed/ManagedCapabilityClient";
import type { ManagedTransportResult } from "../../../managed/ManagedTypes";
import {
  ManagedEmbeddingsAdapter,
  ManagedEmbeddingsError,
} from "../ManagedEmbeddingsAdapter";
import { MANAGED_EMBEDDING_LIMITS } from "../../ManagedEmbeddingsContract";

function transport(body: unknown, status = 200): ManagedTransportResult {
  return {
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
    }),
    diagnostics: {
      status,
      requestId: "request-1",
      contentType: "application/json",
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfter: null,
      errorText: "",
    },
  };
}

function clientWith(
  request: jest.Mock,
): Pick<ManagedCapabilityClient, "request"> {
  return { request } as unknown as Pick<ManagedCapabilityClient, "request">;
}

describe("ManagedEmbeddingsAdapter", () => {
  it("negotiates generation identity and batching limits from the first-party catalog", async () => {
    const request = jest.fn();
    const getCatalog = jest.fn(async () => ({
      capabilities: [{
        alias: "systemsculpt/embeddings",
        availability: "available",
        limits: { max_texts: 64, max_chars_per_text: 7000, max_total_chars: 120000 },
        generation: {
          id: "semantic-v1",
          index_schema_version: 2,
          index_namespace: "systemsculpt:managed:semantic-v1:v2:<dimensions>",
        },
      }],
    }));
    const adapter = new ManagedEmbeddingsAdapter({ request, getCatalog } as never);

    await adapter.initializeContract();

    expect(adapter.limits).toEqual({ maxTexts: 64, maxCharsPerText: 7000, maxTotalChars: 120000 });
    expect(adapter.activeGeneration).toBeUndefined();
  });

  it("does not evaluate private input before managed admission allows the request", async () => {
    const request = jest.fn(async () => ({ outcome: "license_required" }));
    const prepare = jest.fn(() => ({ input: "private vault text" }));
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));

    await expect(adapter.generate({ prepare, idempotencyKey: "embeddings:file:1" }))
      .rejects.toMatchObject({ code: "license_required", status: 401 });

    expect(prepare).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      alias: "systemsculpt/embeddings",
      requestContract: "embeddings",
      idempotencyKey: "embeddings:file:1",
    }));
  });

  it("sends only the immutable input body and validates a batch response", async () => {
    const request = jest.fn(async (operation) => {
      expect(operation.body()).toEqual({ input: ["one", "two"] });
      expect(operation.signal).toBeUndefined();
      return transport({
        embeddings: [[1, 0], [0, 1]],
        dimensions: 2,
        generation: {
          id: "semantic-v1",
          indexSchemaVersion: 2,
          indexNamespace: "systemsculpt:managed:semantic-v1:v2:2",
        },
        tokenCount: 2,
      });
    });
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));

    await expect(adapter.generate({
      prepare: () => ({ input: ["one", "two"] }),
      idempotencyKey: "embeddings:batch:1",
    })).resolves.toEqual({
      vectors: [[1, 0], [0, 1]],
      dimensions: 2,
      generation: {
        id: "semantic-v1",
        indexSchemaVersion: 2,
        indexNamespace: "systemsculpt:managed:semantic-v1:v2:2",
        dimensions: 2,
        limits: { maxTexts: 128, maxCharsPerText: 8000, maxTotalChars: 200000 },
      },
      tokenCount: 2,
    });
  });

  it("accepts the strict single response variant", async () => {
    const request = jest.fn(async (operation) => {
      expect(operation.body()).toEqual({ input: "query" });
      return transport({
        embedding: [0.25, -0.5],
        dimensions: 2,
        generation: {
          id: "semantic-v1",
          indexSchemaVersion: 2,
          indexNamespace: "systemsculpt:managed:semantic-v1:v2:2",
        },
      });
    });
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));
    const result = await adapter.generate({
      prepare: () => ({ input: "query" }),
      idempotencyKey: "embeddings:query:1",
    });
    expect(result.vectors).toEqual([[0.25, -0.5]]);
  });

  it("rejects dimension drift within an already negotiated generation", async () => {
    const request = jest.fn(async (operation) => {
      operation.body();
      return transport({
        embedding: [1, 0, 0],
        dimensions: 3,
        generation: {
          id: "semantic-v1",
          indexSchemaVersion: 2,
          indexNamespace: "systemsculpt:managed:semantic-v1:v2:3",
        },
      });
    });
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));
    adapter.expectedDimension = 2;

    await expect(adapter.generate({ prepare: () => ({ input: "second" }), idempotencyKey: "embeddings:dimension:2" }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects text beyond the first-party per-input contract before transport", async () => {
    const request = jest.fn(async (operation) => {
      operation.body();
      throw new Error("unreachable");
    });
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));

    await expect(adapter.generate({
      prepare: () => ({ input: "x".repeat(MANAGED_EMBEDDING_LIMITS.maxCharsPerText + 1) }),
      idempotencyKey: "embeddings:too-long:1",
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it.each([
    [{ embedding: [1, 2], embeddings: [[1, 2]], dimensions: 2, generation: { id: "semantic-v1", indexSchemaVersion: 2, indexNamespace: "systemsculpt:managed:semantic-v1:v2:2" } }],
    [{ embedding: [1, 2], dimensions: 3, generation: { id: "semantic-v1", indexSchemaVersion: 2, indexNamespace: "systemsculpt:managed:semantic-v1:v2:2" } }],
    [{ embedding: [1, Number.NaN], dimensions: 2, generation: { id: "semantic-v1", indexSchemaVersion: 2, indexNamespace: "systemsculpt:managed:semantic-v1:v2:2" } }],
    [{ embedding: [1, 2], dimensions: 2, generation: { id: "semantic-v2", indexSchemaVersion: 2, indexNamespace: "systemsculpt:managed:semantic-v2:v2:2" } }],
    [{ embedding: [1, 2], dimensions: 2, generation: { id: "semantic-v1", indexSchemaVersion: 1, indexNamespace: "systemsculpt:managed:v1:2" } }],
    [{ embeddings: [[1, 2]], dimensions: 2, generation: { id: "semantic-v1", indexSchemaVersion: 2, indexNamespace: "systemsculpt:managed:semantic-v1:v2:2" } }],
  ])("rejects malformed or cardinality-mismatched responses", async (body) => {
    const request = jest.fn(async () => transport(body));
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));
    await expect(adapter.generate({
      prepare: () => ({ input: "query" }),
      idempotencyKey: "embeddings:invalid:1",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [400, "invalid_request"],
    [401, "license_required"],
    [402, "payment_required"],
    [403, "license_rejected"],
    [426, "version_unsupported"],
    [429, "rate_limited"],
    [502, "temporarily_unavailable"],
    [503, "temporarily_unavailable"],
  ] as const)("maps HTTP %s to %s without exposing response bodies", async (status, code) => {
    const request = jest.fn(async () => transport({ private: "vault text" }, status));
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));
    const error = await adapter.generate({
      prepare: () => ({ input: "query" }),
      idempotencyKey: `embeddings:http:${status}`,
    }).catch((caught) => caught as ManagedEmbeddingsError);
    expect(error).toMatchObject({ code, status, requestId: "request-1" });
    expect(error.message).not.toContain("vault text");
  });

  it("forwards cancellation to the managed transport and suppresses a late response", async () => {
    const controller = new AbortController();
    let release!: (value: ManagedTransportResult) => void;
    const pending = new Promise<ManagedTransportResult>((resolve) => { release = resolve; });
    const request = jest.fn(async (operation) => {
      expect(operation.signal).toBe(controller.signal);
      operation.body();
      return pending;
    });
    const adapter = new ManagedEmbeddingsAdapter(clientWith(request));
    const result = adapter.generate({
      prepare: () => ({ input: "query" }),
      idempotencyKey: "embeddings:cancel:1",
      signal: controller.signal,
    });
    controller.abort();
    release(transport({
      embedding: [1, 2], dimensions: 2,
      generation: {
        id: "semantic-v1", indexSchemaVersion: 2,
        indexNamespace: "systemsculpt:managed:semantic-v1:v2:2",
      },
    }));
    await expect(result).rejects.toMatchObject({ code: "request_cancelled" });
  });
});
