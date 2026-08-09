import { sha256HexFromBytesPortable } from "../../../../studio/hash";
import type { ManagedTransportResult } from "../../../managed/ManagedTypes";
import {
  MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
  type ManagedEmbeddingsError,
  ManagedEmbeddingsIndexAdapter,
} from "../ManagedEmbeddingsIndexAdapter";

const MARKDOWN = "# Heading\n\nPrivate vault text.";
const UTF8 = new TextEncoder();

function sourceHash(markdown = MARKDOWN): string {
  return sha256HexFromBytesPortable(UTF8.encode(markdown));
}

function float32Base64(values: readonly number[]): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function chunk(
  ordinal: number,
  vector = [1, 0],
  textHash = "b".repeat(64),
): Record<string, unknown> {
  return {
    ordinal,
    text_hash: textHash,
    heading_path: ["Heading"],
    excerpt: "Heading: Private vault text.",
    length: 24,
    vector_base64: float32Base64(vector),
  };
}

function payload(
  contentSha256 = sourceHash(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    source: { content_sha256: contentSha256 },
    empty: false,
    vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
    generation: {
      id: "semantic-v1",
      index_schema_version: 3,
      index_namespace: "systemsculpt:managed:semantic-v1:v3:2",
      dimensions: 2,
    },
    chunks: [chunk(0)],
    ...overrides,
  };
}

function transport(
  body: unknown,
  options: {
    status?: number;
    headers?: Record<string, string | null>;
    raw?: Uint8Array;
  } = {},
): ManagedTransportResult {
  const raw = options.raw ?? UTF8.encode(JSON.stringify(body));
  const responseSha256 = sha256HexFromBytesPortable(raw);
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store, max-age=0",
    "x-request-id": "request-1",
    "x-systemsculpt-embeddings-index-contract": MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    "x-systemsculpt-content-sha256": responseSha256,
    "x-systemsculpt-content-size": String(raw.byteLength),
  });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const status = options.status ?? 200;
  const response = new Response(raw, { status, headers });
  return {
    response,
    diagnostics: {
      status,
      requestId: headers.get("x-request-id"),
      contentType: headers.get("content-type"),
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfter: null,
      errorText: "",
    },
  };
}

function adapterWith(request: jest.Mock): ManagedEmbeddingsIndexAdapter {
  return new ManagedEmbeddingsIndexAdapter({
    managedEmbeddingsIndex: request,
  } as never);
}

describe("ManagedEmbeddingsIndexAdapter", () => {
  it("loads exact bounded metadata through the dedicated contract", async () => {
    const getMetadata = jest.fn(async () => transport({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      generation: {
        id: "semantic-v1",
        index_schema_version: 3,
        index_namespace_template: "systemsculpt:managed:semantic-v1:v3:<dimensions>",
      },
      vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      limits: {
        max_source_bytes: 8 * 1024 * 1024,
        max_result_bytes: 16 * 1024 * 1024,
      },
    }));
    const adapter = new ManagedEmbeddingsIndexAdapter({
      getManagedEmbeddingsIndexMetadata: getMetadata,
    } as never);

    await expect(adapter.getMetadata()).resolves.toEqual({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      generation: {
        id: "semantic-v1",
        indexSchemaVersion: 3,
        indexNamespaceTemplate: "systemsculpt:managed:semantic-v1:v3:<dimensions>",
      },
      limits: {
        maxSourceBytes: 8 * 1024 * 1024,
        maxResultBytes: 16 * 1024 * 1024,
      },
    });
    expect(getMetadata).toHaveBeenCalledTimes(1);
  });

  it("rejects metadata namespace drift and unbounded advertised limits", async () => {
    const invalid = {
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      generation: {
        id: "semantic-v1",
        index_schema_version: 3,
        index_namespace_template: "systemsculpt:managed:semantic-v1:v2:<dimensions>",
      },
      vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      limits: {
        max_source_bytes: 8 * 1024 * 1024 + 1,
        max_result_bytes: 16 * 1024 * 1024,
      },
    };
    const adapter = new ManagedEmbeddingsIndexAdapter({
      getManagedEmbeddingsIndexMetadata: jest.fn(async () => transport(invalid)),
    } as never);

    await expect(adapter.getMetadata())
      .rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("trims, hashes, and dispatches an exact semantic query once", async () => {
    const query = jest.fn(async (
      value: string,
      contentSha256: string,
      signal?: AbortSignal,
    ) => {
      expect(value).toBe("café");
      expect(contentSha256).toBe(sourceHash("café"));
      expect(signal).toBeUndefined();
      return transport({
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: {
          id: "semantic-v1",
          index_schema_version: 3,
          index_namespace: "systemsculpt:managed:semantic-v1:v3:2",
          dimensions: 2,
        },
        vector_base64: float32Base64([0, 1]),
      });
    });
    const adapter = new ManagedEmbeddingsIndexAdapter({
      managedEmbeddingsIndexQuery: query,
    } as never);

    const result = await adapter.query("  café  ");

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      generation: {
        id: "semantic-v1",
        indexSchemaVersion: 3,
        indexNamespace: "systemsculpt:managed:semantic-v1:v3:2",
        dimensions: 2,
      },
    });
    expect(Array.from(result.vector)).toEqual([0, 1]);
  });

  it("rejects invalid queries and malformed query vectors without replay", async () => {
    const query = jest.fn(async () => transport({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      vector_encoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      generation: {
        id: "semantic-v1",
        index_schema_version: 3,
        index_namespace: "systemsculpt:managed:semantic-v1:v3:2",
        dimensions: 2,
      },
      vector_base64: float32Base64([1, 1]),
    }));
    const adapter = new ManagedEmbeddingsIndexAdapter({
      managedEmbeddingsIndexQuery: query,
    } as never);

    await expect(adapter.query("  "))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(adapter.query("q".repeat(8_001)))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(adapter.query("valid"))
      .rejects.toMatchObject({ code: "invalid_response", status: 200 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("sends exact raw UTF-8 bytes with their SHA-256 and validates schema-v3 Float32 chunks", async () => {
    const signal = new AbortController().signal;
    const request = jest.fn(async (body: ArrayBuffer, contentSha256: string, actualSignal?: AbortSignal) => {
      expect(new TextDecoder().decode(body)).toBe(MARKDOWN);
      expect(body.byteLength).toBe(UTF8.encode(MARKDOWN).byteLength);
      expect(contentSha256).toBe(sourceHash());
      expect(actualSignal).toBe(signal);
      return transport(payload(contentSha256));
    });
    const prepare = jest.fn(() => ({ markdown: MARKDOWN }));
    const adapter = adapterWith(request);

    const result = await adapter.index({ prepare, signal });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
      source: { contentSha256: sourceHash() },
      empty: false,
      vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
      generation: {
        id: "semantic-v1",
        indexSchemaVersion: 3,
        indexNamespace: "systemsculpt:managed:semantic-v1:v3:2",
        dimensions: 2,
      },
      chunks: [{
        ordinal: 0,
        textHash: "b".repeat(64),
        headingPath: ["Heading"],
        excerpt: "Heading: Private vault text.",
        length: 24,
      }],
    });
    expect(Array.from(result.chunks[0].vector)).toEqual([1, 0]);
  });

  it("accepts a future bounded generation only when its namespace matches exactly", async () => {
    const future = payload(sourceHash(), {
      generation: {
        id: "semantic-v2.1",
        index_schema_version: 17,
        index_namespace: "systemsculpt:managed:semantic-v2.1:v17:2",
        dimensions: 2,
      },
    });
    const adapter = adapterWith(jest.fn(async () => transport(future)));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .resolves.toMatchObject({
        generation: {
          id: "semantic-v2.1",
          indexSchemaVersion: 17,
          indexNamespace: "systemsculpt:managed:semantic-v2.1:v17:2",
          dimensions: 2,
        },
      });
  });

  it("accepts the exact empty-source result", async () => {
    const empty = payload(sourceHash(), {
      empty: true,
      generation: null,
      chunks: [],
    });
    const adapter = adapterWith(jest.fn(async () => transport(empty)));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .resolves.toMatchObject({ empty: true, generation: null, chunks: [] });
  });

  it("accepts repeated text hashes while enforcing contiguous ordered ordinals", async () => {
    const repeated = "c".repeat(64);
    const valid = payload(sourceHash(), {
      chunks: [
        chunk(0, [1, 0], repeated),
        chunk(1, [0, 1], repeated),
      ],
    });
    const adapter = adapterWith(jest.fn(async () => transport(valid)));

    const result = await adapter.index({ prepare: () => ({ markdown: MARKDOWN }) });

    expect(result.chunks.map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(result.chunks.map((entry) => entry.textHash)).toEqual([repeated, repeated]);
  });

  it.each([
    ["extra top-level key", () => ({ ...payload(), private_path: "Secret.md" })],
    ["wrong source hash", () => payload("d".repeat(64))],
    ["wrong vector encoding", () => payload(sourceHash(), { vector_encoding: "json" })],
    ["generation namespace drift", () => payload(sourceHash(), {
      generation: {
        id: "semantic-v1",
        index_schema_version: 3,
        index_namespace: "systemsculpt:managed:semantic-v1:v2:2",
        dimensions: 2,
      },
    })],
    ["non-contiguous ordinal", () => payload(sourceHash(), { chunks: [chunk(1)] })],
    ["duplicate ordinal", () => payload(sourceHash(), { chunks: [chunk(0), chunk(0)] })],
    ["non-normalized vector", () => payload(sourceHash(), { chunks: [chunk(0, [1, 1])] })],
    ["zero vector", () => payload(sourceHash(), { chunks: [chunk(0, [0, 0])] })],
    ["non-finite vector", () => payload(sourceHash(), {
      chunks: [chunk(0, [Number.POSITIVE_INFINITY, 0])],
    })],
    ["oversized heading", () => payload(sourceHash(), {
      chunks: [{ ...chunk(0), heading_path: ["h".repeat(257)] }],
    })],
    ["oversized excerpt", () => payload(sourceHash(), {
      chunks: [{ ...chunk(0), excerpt: "e".repeat(513) }],
    })],
    ["extra chunk key", () => payload(sourceHash(), {
      chunks: [{ ...chunk(0), markdown: "private" }],
    })],
  ])("rejects %s without returning unvalidated data", async (_name, build) => {
    const adapter = adapterWith(jest.fn(async () => transport(build())));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it.each([
    ["content-type", "application/json; charset=utf-8"],
    ["cache-control", "no-store"],
    ["x-systemsculpt-embeddings-index-contract", "managed-embeddings-index-v2"],
    ["x-systemsculpt-content-sha256", "e".repeat(64)],
    ["x-systemsculpt-content-size", "01"],
    ["x-request-id", null],
  ] as const)("rejects an invalid required response header %s", async (name, value) => {
    const adapter = adapterWith(jest.fn(async () => transport(payload(), {
      headers: { [name]: value },
    })));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("rejects a response whose declared size does not match its exact bytes", async () => {
    const adapter = adapterWith(jest.fn(async () => transport(payload(), {
      headers: { "x-systemsculpt-content-size": "999" },
    })));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [400, "invalid_request"],
    [401, "license_required"],
    [402, "payment_required"],
    [403, "license_rejected"],
    [404, "capability_unavailable"],
    [413, "invalid_request"],
    [422, "invalid_request"],
    [426, "version_unsupported"],
    [429, "rate_limited"],
    [502, "temporarily_unavailable"],
    [503, "temporarily_unavailable"],
  ] as const)("maps HTTP %s to %s without exposing an unsafe response body", async (status, code) => {
    const body = { private_markdown: "do not expose this vault text" };
    const adapter = adapterWith(jest.fn(async () => transport(body, { status })));

    const error = await adapter.index({
      prepare: () => ({ markdown: MARKDOWN }),
    }).catch((caught) => caught as ManagedEmbeddingsError);

    expect(error).toMatchObject({ code, status, requestId: "request-1" });
    expect(error.message).not.toContain("vault text");
    expect(error.message).not.toContain("private_markdown");
    if (status === 402) {
      expect(error.message).toBe(
        "Not enough credits are available. Add credits to continue indexing notes.",
      );
    }
  });

  it("uses a bounded safe managed error message", async () => {
    const adapter = adapterWith(jest.fn(async () => transport({
      error: {
        code: "rate_limited",
        message: "Indexing is busy. Try again soon.",
        request_id: "request-1",
      },
    }, { status: 429 })));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .rejects.toMatchObject({
        code: "rate_limited",
        message: "Indexing is busy. Try again soon.",
        requestId: "request-1",
      });
  });

  it.each([
    [0, "You have no credits left. Add credits to continue indexing notes."],
    [5, "Not enough credits are available. Add credits to continue indexing notes."],
  ])("uses authoritative remaining credits for 402 copy (%s)", async (creditsRemaining, message) => {
    const adapter = adapterWith(jest.fn(async () => transport({
      error: {
        code: "insufficient_credits",
        message: "Untrusted billing copy.",
        request_id: "request-1",
        credits_remaining: creditsRemaining,
      },
    }, { status: 402 })));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .rejects.toMatchObject({ code: "payment_required", message });
  });

  it("does not retain an oversized managed error body", async () => {
    const privateCanary = "PRIVATE_ERROR_CANARY";
    const adapter = adapterWith(jest.fn(async () => transport({
      error: {
        code: "rate_limited",
        message: `${privateCanary}${"x".repeat(5_000)}`,
        request_id: "request-1",
      },
    }, { status: 429 })));

    const error = await adapter.index({
      prepare: () => ({ markdown: MARKDOWN }),
    }).catch((caught) => caught as ManagedEmbeddingsError);

    expect(error.message).toBe("Managed embedding index request failed.");
    expect(JSON.stringify(error)).not.toContain(privateCanary);
  });

  it("rejects invalid UTF-8 without retaining managed error bytes", async () => {
    const privateCanary = "PRIVATE_INVALID_UTF8_CANARY";
    const prefix = UTF8.encode(privateCanary);
    const raw = new Uint8Array(prefix.byteLength + 2);
    raw.set(prefix);
    raw.set([0xc3, 0x28], prefix.byteLength);
    const adapter = adapterWith(jest.fn(async () => transport(null, {
      status: 429,
      raw,
    })));

    const error = await adapter.index({
      prepare: () => ({ markdown: MARKDOWN }),
    }).catch((caught) => caught as ManagedEmbeddingsError);

    expect(error.message).toBe("Managed embedding index request failed.");
    expect(JSON.stringify(error)).not.toContain(privateCanary);
  });

  it("drops unsafe managed request IDs before persistence", async () => {
    const adapter = adapterWith(jest.fn(async () => transport({
      error: {
        code: "rate_limited",
        message: "Indexing is busy. Try again soon.",
      },
    }, {
      status: 429,
      headers: { "x-request-id": "unsafe request id" },
    })));

    await expect(adapter.index({ prepare: () => ({ markdown: MARKDOWN }) }))
      .rejects.toMatchObject({
        code: "rate_limited",
        requestId: null,
      });
  });

  it("maps preparation failures and invalid local sources without dispatch", async () => {
    const request = jest.fn();
    const adapter = adapterWith(request);

    await expect(adapter.index({ prepare: () => { throw new Error("private path"); } }))
      .rejects.toMatchObject({ code: "local_preparation_failed", status: 0 });
    await expect(adapter.index({ prepare: () => ({ markdown: "" }) }))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(adapter.index({
      prepare: () => ({ markdown: MARKDOWN, path: "Secret.md" } as never),
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("suppresses a late native response after local cancellation", async () => {
    const controller = new AbortController();
    let release!: (value: ManagedTransportResult) => void;
    let markDispatched!: () => void;
    const pending = new Promise<ManagedTransportResult>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const request = jest.fn(async () => {
      markDispatched();
      return pending;
    });
    const adapter = adapterWith(request);

    const result = adapter.index({
      prepare: () => ({ markdown: MARKDOWN }),
      signal: controller.signal,
    });
    await dispatched;
    controller.abort();
    release(transport(payload()));

    await expect(result).rejects.toMatchObject({ code: "request_cancelled", status: 0 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps transport failures to a body-free public error without retrying", async () => {
    const request = jest.fn(async () => {
      throw new TypeError("requestUrl exposed private response");
    });
    const adapter = adapterWith(request);

    const error = await adapter.index({
      prepare: () => ({ markdown: MARKDOWN }),
    }).catch((caught) => caught as ManagedEmbeddingsError);

    expect(request).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "temporarily_unavailable", status: 0 });
    expect(error.message).not.toContain("private response");
  });
});
