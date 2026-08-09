import { sha256HexFromArrayBuffer } from "../../../studio/hash";
import type { ManagedTransportResult } from "../../managed/ManagedTypes";
import type { HostedTransportAdapter } from "../../managed/adapters/HostedTransportAdapter";

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

const SAFE_MANAGED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export class ManagedEmbeddingsError extends Error {
  public readonly requestId: string | null;

  constructor(
    public readonly code: ManagedEmbeddingsErrorCode,
    message: string,
    public readonly status: number,
    requestId: string | null = null,
  ) {
    super(message.slice(0, 256));
    this.name = "ManagedEmbeddingsError";
    this.requestId = typeof requestId === "string" && SAFE_MANAGED_REQUEST_ID.test(requestId)
      ? requestId
      : null;
  }
}

export const MANAGED_EMBEDDINGS_INDEX_CONTRACT = "managed-embeddings-index-v1" as const;
export const MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES = 64 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING = "float32-le-base64" as const;

const MANAGED_EMBEDDINGS_INDEX_MAX_QUERY_BYTES = 16 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_MAX_QUERY_CHARS = 8_000;
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_POSITIVE_DECIMAL = /^[1-9]\d*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_GENERATION_SCHEMA_VERSION = 1_000_000;
const MAX_VECTOR_DIMENSIONS = 8_192;
const MAX_CHUNKS = 100_000;
const MAX_HEADING_DEPTH = 6;
const MAX_HEADING_LENGTH = 256;
const MAX_HEADING_PATH_LENGTH = 1_024;
const MAX_EXCERPT_LENGTH = 512;
const MAX_CHUNK_LENGTH = 1_200_000;
const NORMALIZED_VECTOR_TOLERANCE = 0.001;

const HTTP_CODES: Readonly<Record<number, ManagedEmbeddingsErrorCode>> = {
  400: "invalid_request",
  401: "license_required",
  402: "payment_required",
  403: "license_rejected",
  404: "capability_unavailable",
  413: "invalid_request",
  422: "invalid_request",
  426: "version_unsupported",
  429: "rate_limited",
  502: "temporarily_unavailable",
  503: "temporarily_unavailable",
};
const MANAGED_EMBEDDINGS_MAX_ERROR_BYTES = 4 * 1024;
const MANAGED_EMBEDDINGS_MAX_ERROR_MESSAGE_LENGTH = 256;

type ManagedEmbeddingsErrorPayload = Readonly<{
  message: string;
  creditsRemaining?: number;
}>;

export type ManagedEmbeddingsIndexSource = Readonly<{
  markdown: string;
}>;

export type ManagedEmbeddingsIndexOperation = Readonly<{
  prepare: () => ManagedEmbeddingsIndexSource;
  signal?: AbortSignal;
}>;

export type ManagedEmbeddingsIndexGeneration = Readonly<{
  id: string;
  indexSchemaVersion: number;
  indexNamespace: string;
  dimensions: number;
}>;

export type ManagedEmbeddingsIndexChunk = Readonly<{
  ordinal: number;
  textHash: string;
  headingPath: readonly string[];
  excerpt: string;
  length: number;
  vector: Float32Array;
}>;

export type ManagedEmbeddingsIndexResult = Readonly<{
  contract: typeof MANAGED_EMBEDDINGS_INDEX_CONTRACT;
  source: Readonly<{ contentSha256: string }>;
  empty: boolean;
  vectorEncoding: typeof MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING;
  generation: ManagedEmbeddingsIndexGeneration | null;
  chunks: readonly ManagedEmbeddingsIndexChunk[];
}>;

export type ManagedEmbeddingsIndexMetadata = Readonly<{
  contract: typeof MANAGED_EMBEDDINGS_INDEX_CONTRACT;
  vectorEncoding: typeof MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING;
  generation: Readonly<{
    id: string;
    indexSchemaVersion: number;
    indexNamespaceTemplate: string;
  }>;
  limits: Readonly<{
    maxSourceBytes: number;
    maxResultBytes: number;
  }>;
}>;

export type ManagedEmbeddingsIndexQueryResult = Readonly<{
  contract: typeof MANAGED_EMBEDDINGS_INDEX_CONTRACT;
  vectorEncoding: typeof MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING;
  generation: ManagedEmbeddingsIndexGeneration;
  vector: Float32Array;
}>;

type IndexTransport = Pick<
  HostedTransportAdapter,
  | "managedEmbeddingsIndex"
  | "getManagedEmbeddingsIndexMetadata"
  | "managedEmbeddingsIndexQuery"
>;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requestCancelled(): ManagedEmbeddingsError {
  return new ManagedEmbeddingsError(
    "request_cancelled",
    "Managed embedding index request cancelled.",
    0,
    null,
  );
}

function isAbort(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError",
  );
}

function decodeFloat32Vector(value: unknown, dimensions: number): Float32Array | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > Math.ceil(dimensions * 4 / 3) * 4
    || !BASE64.test(value)
  ) {
    return null;
  }

  let binary: string;
  try {
    binary = atob(value);
    if (btoa(binary) !== value) return null;
  } catch {
    return null;
  }
  if (binary.length !== dimensions * 4) return null;

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const view = new DataView(bytes.buffer);
  const vector = new Float32Array(dimensions);
  let magnitudeSquared = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const entry = view.getFloat32(index * 4, true);
    if (!Number.isFinite(entry)) return null;
    vector[index] = entry;
    magnitudeSquared += entry * entry;
  }
  const magnitude = Math.sqrt(magnitudeSquared);
  if (
    !Number.isFinite(magnitude)
    || magnitude <= 0
    || Math.abs(magnitude - 1) > NORMALIZED_VECTOR_TOLERANCE
  ) {
    return null;
  }
  return vector;
}

function parseGeneration(value: unknown): ManagedEmbeddingsIndexGeneration | null {
  if (!isRecord(value) || !exactKeys(value, [
    "id",
    "index_schema_version",
    "index_namespace",
    "dimensions",
  ])) {
    return null;
  }
  const { id, index_schema_version: schemaVersion, index_namespace: namespace, dimensions } = value;
  if (
    typeof id !== "string"
    || !GENERATION_ID.test(id)
    || !Number.isInteger(schemaVersion)
    || (schemaVersion as number) < 1
    || (schemaVersion as number) > MAX_GENERATION_SCHEMA_VERSION
    || !Number.isInteger(dimensions)
    || (dimensions as number) < 1
    || (dimensions as number) > MAX_VECTOR_DIMENSIONS
    || namespace !== `systemsculpt:managed:${id}:v${schemaVersion}:${dimensions}`
  ) {
    return null;
  }
  return {
    id,
    indexSchemaVersion: schemaVersion as number,
    indexNamespace: namespace as string,
    dimensions: dimensions as number,
  };
}

function parseChunk(
  value: unknown,
  expectedOrdinal: number,
  dimensions: number,
): ManagedEmbeddingsIndexChunk | null {
  if (!isRecord(value) || !exactKeys(value, [
    "ordinal",
    "text_hash",
    "heading_path",
    "excerpt",
    "length",
    "vector_base64",
  ])) {
    return null;
  }
  if (
    value.ordinal !== expectedOrdinal
    || typeof value.text_hash !== "string"
    || !SHA256.test(value.text_hash)
    || !Array.isArray(value.heading_path)
    || value.heading_path.length > MAX_HEADING_DEPTH
    || value.heading_path.some((heading) => (
      typeof heading !== "string"
      || heading.length < 1
      || heading.length > MAX_HEADING_LENGTH
    ))
    || value.heading_path.reduce((length, heading) => length + (heading as string).length, 0)
      > MAX_HEADING_PATH_LENGTH
    || typeof value.excerpt !== "string"
    || value.excerpt.length < 1
    || value.excerpt.length > MAX_EXCERPT_LENGTH
    || !Number.isInteger(value.length)
    || (value.length as number) < 1
    || (value.length as number) > MAX_CHUNK_LENGTH
  ) {
    return null;
  }
  const vector = decodeFloat32Vector(value.vector_base64, dimensions);
  if (!vector) return null;
  return {
    ordinal: expectedOrdinal,
    textHash: value.text_hash,
    headingPath: [...value.heading_path] as string[],
    excerpt: value.excerpt,
    length: value.length as number,
    vector,
  };
}

export class ManagedEmbeddingsIndexAdapter {
  public activeGeneration?: ManagedEmbeddingsIndexGeneration;
  public metadata?: ManagedEmbeddingsIndexMetadata;

  constructor(private readonly transport: IndexTransport) {}

  async getMetadata(signal?: AbortSignal): Promise<ManagedEmbeddingsIndexMetadata> {
    if (signal?.aborted) throw requestCancelled();
    let result: ManagedTransportResult;
    try {
      result = await this.transport.getManagedEmbeddingsIndexMetadata(signal);
    } catch (error) {
      throw this.transportError(error, signal);
    }
    if (signal?.aborted) throw requestCancelled();
    await this.requireSuccess(result);
    const payload = await this.readBoundedJson(result, signal);

    try {
      if (!isRecord(payload) || !exactKeys(payload, [
        "contract",
        "generation",
        "vector_encoding",
        "limits",
      ])) {
        throw new Error();
      }
      if (
        payload.contract !== MANAGED_EMBEDDINGS_INDEX_CONTRACT
        || payload.vector_encoding !== MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING
        || !isRecord(payload.generation)
        || !exactKeys(payload.generation, [
          "id",
          "index_schema_version",
          "index_namespace_template",
        ])
        || typeof payload.generation.id !== "string"
        || !GENERATION_ID.test(payload.generation.id)
        || !Number.isInteger(payload.generation.index_schema_version)
        || (payload.generation.index_schema_version as number) < 1
        || (payload.generation.index_schema_version as number) > MAX_GENERATION_SCHEMA_VERSION
        || payload.generation.index_namespace_template
          !== `systemsculpt:managed:${payload.generation.id}:v${payload.generation.index_schema_version}:<dimensions>`
        || !isRecord(payload.limits)
        || !exactKeys(payload.limits, ["max_source_bytes", "max_result_bytes"])
        || !Number.isInteger(payload.limits.max_source_bytes)
        || (payload.limits.max_source_bytes as number) < 1
        || (payload.limits.max_source_bytes as number) > MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES
        || !Number.isInteger(payload.limits.max_result_bytes)
        || (payload.limits.max_result_bytes as number) < 1
        || (payload.limits.max_result_bytes as number) > MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES
      ) {
        throw new Error();
      }
      const metadata: ManagedEmbeddingsIndexMetadata = {
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation: {
          id: payload.generation.id,
          indexSchemaVersion: payload.generation.index_schema_version as number,
          indexNamespaceTemplate: payload.generation.index_namespace_template as string,
        },
        limits: {
          maxSourceBytes: payload.limits.max_source_bytes as number,
          maxResultBytes: payload.limits.max_result_bytes as number,
        },
      };
      this.metadata = metadata;
      return metadata;
    } catch {
      throw this.invalidResponse(result);
    }
  }

  async query(query: string, signal?: AbortSignal): Promise<ManagedEmbeddingsIndexQueryResult> {
    if (signal?.aborted) throw requestCancelled();
    const normalized = typeof query === "string" ? query.trim() : "";
    if (
      normalized.length < 1
      || normalized.length > MANAGED_EMBEDDINGS_INDEX_MAX_QUERY_CHARS
      || new TextEncoder().encode(JSON.stringify({ query: normalized })).byteLength
        > MANAGED_EMBEDDINGS_INDEX_MAX_QUERY_BYTES
    ) {
      throw new ManagedEmbeddingsError(
        "invalid_request",
        "Managed embedding index query is invalid.",
        400,
      );
    }
    const querySha256 = await sha256HexFromArrayBuffer(
      new TextEncoder().encode(normalized).buffer as ArrayBuffer,
    );
    if (signal?.aborted) throw requestCancelled();

    let result: ManagedTransportResult;
    try {
      result = await this.transport.managedEmbeddingsIndexQuery(
        normalized,
        querySha256,
        signal,
      );
    } catch (error) {
      throw this.transportError(error, signal);
    }
    if (signal?.aborted) throw requestCancelled();
    await this.requireSuccess(result);
    const payload = await this.readBoundedJson(result, signal);

    try {
      if (!isRecord(payload) || !exactKeys(payload, [
        "contract",
        "vector_encoding",
        "generation",
        "vector_base64",
      ])) {
        throw new Error();
      }
      const generation = parseGeneration(payload.generation);
      if (
        payload.contract !== MANAGED_EMBEDDINGS_INDEX_CONTRACT
        || payload.vector_encoding !== MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING
        || !generation
      ) {
        throw new Error();
      }
      const vector = decodeFloat32Vector(payload.vector_base64, generation.dimensions);
      if (!vector) throw new Error();
      const queryResult: ManagedEmbeddingsIndexQueryResult = {
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation,
        vector,
      };
      return queryResult;
    } catch {
      throw this.invalidResponse(result);
    }
  }

  async index(operation: ManagedEmbeddingsIndexOperation): Promise<ManagedEmbeddingsIndexResult> {
    if (operation.signal?.aborted) throw requestCancelled();
    if (typeof operation.prepare !== "function") {
      throw new ManagedEmbeddingsError(
        "invalid_request",
        "Managed embedding index source is invalid.",
        400,
      );
    }

    let prepared: ManagedEmbeddingsIndexSource;
    try {
      prepared = operation.prepare();
    } catch (error) {
      if (error instanceof ManagedEmbeddingsError) throw error;
      throw new ManagedEmbeddingsError(
        "local_preparation_failed",
        "Managed embedding index source preparation failed.",
        0,
      );
    }
    if (
      !isRecord(prepared)
      || !exactKeys(prepared, ["markdown"])
      || typeof prepared.markdown !== "string"
    ) {
      throw new ManagedEmbeddingsError(
        "invalid_request",
        "Managed embedding index source is invalid.",
        400,
      );
    }

    const encoded = new TextEncoder().encode(prepared.markdown);
    if (
      encoded.byteLength < 1
      || encoded.byteLength > MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES
    ) {
      throw new ManagedEmbeddingsError(
        "invalid_request",
        "Managed embedding index source is invalid.",
        400,
      );
    }
    const body = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
    const contentSha256 = await sha256HexFromArrayBuffer(body);
    if (operation.signal?.aborted) throw requestCancelled();

    let result: ManagedTransportResult;
    try {
      result = await this.transport.managedEmbeddingsIndex(
        body,
        contentSha256,
        operation.signal,
      );
    } catch (error) {
      throw this.transportError(error, operation.signal);
    }
    if (operation.signal?.aborted) throw requestCancelled();
    await this.requireSuccess(result);

    const indexed = await this.readResult(result, contentSha256, operation.signal);
    if (indexed.generation) this.activeGeneration = indexed.generation;
    return indexed;
  }

  private async requireSuccess(result: ManagedTransportResult): Promise<void> {
    if (!result.response.ok) {
      const code = HTTP_CODES[result.response.status] ?? "temporarily_unavailable";
      const payload = await this.readErrorPayload(result, code);
      const message = code === "payment_required"
        ? payload?.creditsRemaining === 0
          ? "You have no credits left. Add credits to continue indexing notes."
          : "Not enough credits are available. Add credits to continue indexing notes."
        : payload?.message ?? "Managed embedding index request failed.";
      throw new ManagedEmbeddingsError(
        code,
        message,
        result.response.status,
        result.diagnostics.requestId,
      );
    }
    if (result.response.status !== 200) throw this.invalidResponse(result);
  }

  private async readErrorPayload(
    result: ManagedTransportResult,
    expectedCode: ManagedEmbeddingsErrorCode,
  ): Promise<ManagedEmbeddingsErrorPayload | null> {
    const response = result.response;
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength)
      && declaredLength > MANAGED_EMBEDDINGS_MAX_ERROR_BYTES
    ) return null;
    if (!response.body) return null;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MANAGED_EMBEDDINGS_MAX_ERROR_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    } finally {
      reader.releaseLock();
    }
    if (byteLength < 1) return null;

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
      if (!isRecord(value) || !isRecord(value.error)) return null;
      const error = value.error;
      if (
        (
          error.code !== expectedCode
          && !(expectedCode === "payment_required" && error.code === "insufficient_credits")
        )
        || typeof error.message !== "string"
        || error.message.length < 1
        || error.message.length > MANAGED_EMBEDDINGS_MAX_ERROR_MESSAGE_LENGTH
        || /[\u0000-\u001f\u007f]/u.test(error.message)
      ) return null;
      if (
        error.request_id !== undefined
        && (
          typeof error.request_id !== "string"
          || !SAFE_MANAGED_REQUEST_ID.test(error.request_id)
          || (
            result.diagnostics.requestId !== null
            && error.request_id !== result.diagnostics.requestId
          )
        )
      ) return null;
      if (
        error.credits_remaining !== undefined
        && (
          !Number.isSafeInteger(error.credits_remaining)
          || (error.credits_remaining as number) < 0
        )
      ) return null;
      return {
        message: error.message,
        ...(typeof error.credits_remaining === "number"
          ? { creditsRemaining: error.credits_remaining }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private transportError(error: unknown, signal?: AbortSignal): ManagedEmbeddingsError {
    if (signal?.aborted || isAbort(error)) return requestCancelled();
    return new ManagedEmbeddingsError(
      "temporarily_unavailable",
      "Managed embedding index request failed.",
      0,
    );
  }

  private validateJsonResponseHeaders(result: ManagedTransportResult): void {
    const headers = result.response.headers;
    const requestId = headers.get("x-request-id");
    if (
      headers.get("content-type")?.trim().toLowerCase() !== "application/json"
      || headers.get("cache-control")?.trim().toLowerCase() !== "no-store, max-age=0"
      || headers.get("x-systemsculpt-embeddings-index-contract")
        !== MANAGED_EMBEDDINGS_INDEX_CONTRACT
      || !requestId
      || requestId.length > 256
      || /[\u0000-\u001f\u007f]/.test(requestId)
    ) {
      throw this.invalidResponse(result);
    }
  }

  private async readBoundedJson(
    result: ManagedTransportResult,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.validateJsonResponseHeaders(result);
    let bytes: ArrayBuffer;
    try {
      bytes = await result.response.arrayBuffer();
    } catch {
      throw this.invalidResponse(result);
    }
    if (signal?.aborted) throw requestCancelled();
    if (bytes.byteLength < 1 || bytes.byteLength > MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES) {
      throw this.invalidResponse(result);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw this.invalidResponse(result);
    }
  }

  private async readResult(
    result: ManagedTransportResult,
    expectedSourceSha256: string,
    signal?: AbortSignal,
  ): Promise<ManagedEmbeddingsIndexResult> {
    const headers = result.response.headers;
    const responseSha256 = headers.get("x-systemsculpt-content-sha256");
    const responseSize = headers.get("x-systemsculpt-content-size");
    this.validateJsonResponseHeaders(result);
    if (
      !responseSha256
      || !SHA256.test(responseSha256)
      || !responseSize
      || !CANONICAL_POSITIVE_DECIMAL.test(responseSize)
    ) {
      throw this.invalidResponse(result);
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await result.response.arrayBuffer();
    } catch {
      throw this.invalidResponse(result);
    }
    if (signal?.aborted) throw requestCancelled();
    if (
      bytes.byteLength < 1
      || bytes.byteLength > MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES
      || Number(responseSize) !== bytes.byteLength
    ) {
      throw this.invalidResponse(result);
    }
    if (await sha256HexFromArrayBuffer(bytes) !== responseSha256) {
      throw this.invalidResponse(result);
    }
    if (signal?.aborted) throw requestCancelled();

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw this.invalidResponse(result);
    }
    return this.parsePayload(payload, expectedSourceSha256, result);
  }

  private parsePayload(
    payload: unknown,
    expectedSourceSha256: string,
    result: ManagedTransportResult,
  ): ManagedEmbeddingsIndexResult {
    try {
      if (!isRecord(payload) || !exactKeys(payload, [
        "contract",
        "source",
        "empty",
        "vector_encoding",
        "generation",
        "chunks",
      ])) {
        throw new Error();
      }
      if (
        payload.contract !== MANAGED_EMBEDDINGS_INDEX_CONTRACT
        || payload.vector_encoding !== MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING
        || typeof payload.empty !== "boolean"
        || !isRecord(payload.source)
        || !exactKeys(payload.source, ["content_sha256"])
        || payload.source.content_sha256 !== expectedSourceSha256
        || !Array.isArray(payload.chunks)
        || payload.chunks.length > MAX_CHUNKS
      ) {
        throw new Error();
      }

      if (payload.empty) {
        if (payload.generation !== null || payload.chunks.length !== 0) throw new Error();
        return {
          contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
          source: { contentSha256: expectedSourceSha256 },
          empty: true,
          vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
          generation: null,
          chunks: [],
        };
      }

      const generation = parseGeneration(payload.generation);
      if (!generation || payload.chunks.length < 1) throw new Error();
      const chunks = payload.chunks.map((chunk, ordinal) => (
        parseChunk(chunk, ordinal, generation.dimensions)
      ));
      if (chunks.some((chunk) => chunk === null)) throw new Error();
      return {
        contract: MANAGED_EMBEDDINGS_INDEX_CONTRACT,
        source: { contentSha256: expectedSourceSha256 },
        empty: false,
        vectorEncoding: MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING,
        generation,
        chunks: chunks as ManagedEmbeddingsIndexChunk[],
      };
    } catch {
      throw this.invalidResponse(result);
    }
  }

  private invalidResponse(result: ManagedTransportResult): ManagedEmbeddingsError {
    return new ManagedEmbeddingsError(
      "invalid_response",
      "Managed embedding index returned an invalid response.",
      result.response.status,
      result.diagnostics.requestId,
    );
  }
}
