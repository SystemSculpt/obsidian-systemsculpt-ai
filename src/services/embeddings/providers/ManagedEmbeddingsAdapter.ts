import type { ManagedCapabilityClient } from "../../managed/ManagedCapabilityClient";
import type {
  ManagedAdmissionOutcome,
  ManagedLease,
  ManagedTransportResult,
} from "../../managed/ManagedTypes";
import type { EmbeddingsGenerateOptions, EmbeddingsProvider } from "../types";

export type ManagedEmbeddingsErrorCode =
  | "invalid_request"
  | "license_required"
  | "payment_required"
  | "license_rejected"
  | "version_unsupported"
  | "rate_limited"
  | "temporarily_unavailable"
  | "capability_unavailable"
  | "invalid_response"
  | "local_preparation_failed"
  | "request_cancelled";

export class ManagedEmbeddingsError extends Error {
  constructor(
    public readonly code: ManagedEmbeddingsErrorCode,
    message: string,
    public readonly status: number,
    public readonly requestId: string | null = null,
  ) {
    super(message.slice(0, 256));
    this.name = "ManagedEmbeddingsError";
  }
}

export type ManagedEmbeddingsRequest = Readonly<{ input: string | readonly string[] }>;
export type ManagedEmbeddingsResult = Readonly<{
  vectors: readonly (readonly number[])[];
  dimensions: number;
  namespace: `systemsculpt:managed:v1:${number}`;
  tokenCount?: number;
}>;

export type ManagedEmbeddingsCall = Readonly<{
  prepare: () => ManagedEmbeddingsRequest;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{1,128}$/;
const HTTP_CODES: Readonly<Record<number, ManagedEmbeddingsErrorCode>> = {
  400: "invalid_request",
  401: "license_required",
  402: "payment_required",
  403: "license_rejected",
  426: "version_unsupported",
  429: "rate_limited",
  502: "temporarily_unavailable",
  503: "temporarily_unavailable",
};

function isTransportResult(value: ManagedTransportResult | ManagedLease): value is ManagedTransportResult {
  return Boolean(value && typeof value === "object" && "response" in value && "diagnostics" in value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function finiteVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value)
    && value.length === dimensions
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export class ManagedEmbeddingsAdapter implements EmbeddingsProvider {
  readonly id = "systemsculpt" as const;
  readonly model = "managed" as const;
  expectedDimension?: number;
  activeNamespace?: `systemsculpt:managed:v1:${number}`;

  constructor(private readonly client: Pick<ManagedCapabilityClient, "request">) {}

  async generateEmbeddings(texts: string[], options: EmbeddingsGenerateOptions): Promise<number[][]> {
    const result = await this.generate({
      prepare: () => ({ input: [...texts] }),
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
    this.expectedDimension = result.dimensions;
    this.activeNamespace = result.namespace;
    return result.vectors.map((vector) => [...vector]);
  }

  async generate(call: ManagedEmbeddingsCall): Promise<ManagedEmbeddingsResult> {
    if (!IDEMPOTENCY_KEY.test(call.idempotencyKey)) {
      throw new ManagedEmbeddingsError("invalid_request", "A valid idempotency key is required.", 400);
    }
    if (call.signal?.aborted) {
      throw new ManagedEmbeddingsError("request_cancelled", "Embeddings request cancelled.", 0);
    }

    let cardinality: "single" | "batch" | null = null;
    let expectedCount = 0;
    const result = await this.client.request({
      alias: "systemsculpt/embeddings",
      requestContract: "embeddings",
      idempotencyKey: call.idempotencyKey,
      body: () => {
        const prepared = call.prepare();
        if (!prepared || typeof prepared !== "object" || !exactKeys(prepared as Record<string, unknown>, ["input"])) {
          throw new ManagedEmbeddingsError("invalid_request", "Embeddings input is invalid.", 400);
        }
        if (typeof prepared.input === "string") {
          if (!prepared.input.length) throw new ManagedEmbeddingsError("invalid_request", "Embeddings input is empty.", 400);
          cardinality = "single";
          expectedCount = 1;
          return { input: prepared.input };
        }
        if (
          !Array.isArray(prepared.input) || prepared.input.length === 0
          || prepared.input.some((entry) => typeof entry !== "string" || entry.length === 0)
        ) {
          throw new ManagedEmbeddingsError("invalid_request", "Embeddings input is invalid.", 400);
        }
        cardinality = "batch";
        expectedCount = prepared.input.length;
        return { input: [...prepared.input] };
      },
    });

    if (call.signal?.aborted) {
      throw new ManagedEmbeddingsError("request_cancelled", "Embeddings request cancelled.", 0);
    }
    if (!isTransportResult(result)) throw this.admissionError(result.outcome);
    if (!result.response.ok) {
      const code = HTTP_CODES[result.response.status] ?? "temporarily_unavailable";
      throw new ManagedEmbeddingsError(code, "Managed embeddings request failed.", result.response.status, result.diagnostics.requestId);
    }
    if (!String(result.diagnostics.contentType || "").toLowerCase().includes("application/json")) {
      throw this.invalidResponse(result);
    }

    let payload: unknown;
    try {
      payload = await result.response.json();
    } catch {
      throw this.invalidResponse(result);
    }
    return this.parse(payload, cardinality, expectedCount, result);
  }

  private parse(
    payload: unknown,
    cardinality: "single" | "batch" | null,
    expectedCount: number,
    transport: ManagedTransportResult,
  ): ManagedEmbeddingsResult {
    try {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !cardinality) throw new Error();
      const record = payload as Record<string, unknown>;
      const hasSingle = Object.prototype.hasOwnProperty.call(record, "embedding");
      const hasBatch = Object.prototype.hasOwnProperty.call(record, "embeddings");
      if (hasSingle === hasBatch) throw new Error();

      const keys = hasSingle
        ? ["embedding", "dimensions", "indexSchemaVersion", "indexNamespace"]
        : ["embeddings", "dimensions", "indexSchemaVersion", "indexNamespace"];
      if (Object.prototype.hasOwnProperty.call(record, "tokenCount")) keys.push("tokenCount");
      if (!exactKeys(record, keys)) throw new Error();

      const dimensions = record.dimensions;
      if (!Number.isInteger(dimensions) || (dimensions as number) <= 0) throw new Error();
      if (record.indexSchemaVersion !== 1) throw new Error();
      const namespace = `systemsculpt:managed:v1:${dimensions}` as `systemsculpt:managed:v1:${number}`;
      if (record.indexNamespace !== namespace) throw new Error();
      if (
        Object.prototype.hasOwnProperty.call(record, "tokenCount")
        && (!Number.isInteger(record.tokenCount) || (record.tokenCount as number) < 0)
      ) throw new Error();

      let vectors: number[][];
      if (cardinality === "single") {
        if (!hasSingle || !finiteVector(record.embedding, dimensions as number)) throw new Error();
        vectors = [record.embedding];
      } else {
        if (!hasBatch || !Array.isArray(record.embeddings) || record.embeddings.length !== expectedCount) throw new Error();
        if (!record.embeddings.every((vector) => finiteVector(vector, dimensions as number))) throw new Error();
        vectors = record.embeddings as number[][];
      }

      return {
        vectors,
        dimensions: dimensions as number,
        namespace,
        ...(typeof record.tokenCount === "number" ? { tokenCount: record.tokenCount } : {}),
      };
    } catch {
      throw this.invalidResponse(transport);
    }
  }

  private admissionError(outcome: ManagedAdmissionOutcome): ManagedEmbeddingsError {
    const map: Readonly<Record<Exclude<ManagedAdmissionOutcome, "allowed">, readonly [ManagedEmbeddingsErrorCode, number]>> = {
      license_required: ["license_required", 401],
      license_rejected: ["license_rejected", 403],
      rate_limited: ["rate_limited", 429],
      temporarily_unavailable: ["temporarily_unavailable", 503],
      capability_unavailable: ["capability_unavailable", 503],
    };
    const [code, status] = map[outcome === "allowed" ? "capability_unavailable" : outcome];
    return new ManagedEmbeddingsError(code, "Managed embeddings admission was not allowed.", status);
  }

  private invalidResponse(result: ManagedTransportResult): ManagedEmbeddingsError {
    return new ManagedEmbeddingsError(
      "invalid_response",
      "Managed embeddings returned an invalid response.",
      result.response.status,
      result.diagnostics.requestId,
    );
  }
}
