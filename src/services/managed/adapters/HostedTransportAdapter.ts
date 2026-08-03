import { PlatformRequestClient, type PlatformRequestInput } from "../../PlatformRequestClient";
import {
  MANAGED_ADMISSION_CONTRACT, MANAGED_CAPABILITY_CONTRACT, MANAGED_IMAGE_OUTPUT_MAX_BYTES,
  ManagedServerOutcome, ManagedTransportOperation, ManagedTransportResult,
} from "../ManagedTypes";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";
import { decodeManagedAdmissionResponse } from "../ManagedAdmissionResponse";
import {
  MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES,
  MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES,
  MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES,
} from "../../embeddings/gateway/ManagedEmbeddingsIndexAdapter";

export interface HostedTransportOptions { baseUrl: string; pluginVersion: string; licenseKey: () => string; requestClient?: PlatformRequestClient; }

function isReplaySafeManagedRead(operation: ManagedTransportOperation): boolean {
  return (operation.method ?? "POST").toUpperCase() === "GET";
}

export class HostedTransportAdapter {
  private readonly client: PlatformRequestClient;
  constructor(private readonly options: HostedTransportOptions) { this.client = options.requestClient ?? new PlatformRequestClient(); }

  private url(path: string): string { return `${this.options.baseUrl.replace(/\/$/, "")}${path}`; }
  private key(): string | undefined { const key = this.options.licenseKey().trim(); return key || undefined; }

  async getCatalog() {
    const result = await this.send({ path: "/api/plugin/config", method: "GET" }, { "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT });
    if (!result.response.ok) throw new Error(`Catalog unavailable (${result.response.status})`);
    return ManagedCapabilityCatalog.parse(await result.response.json());
  }

  async getAdmission(): Promise<{ outcome: ManagedServerOutcome; diagnostics: ManagedTransportResult["diagnostics"] }> {
    const result = await this.send({ path: "/api/plugin/license/validate", method: "GET" }, { "x-systemsculpt-admission-contract": MANAGED_ADMISSION_CONTRACT });
    let body: unknown;
    try { body = await result.response.clone().json(); } catch {}
    return {
      outcome: decodeManagedAdmissionResponse(result.response.status, body).outcome,
      diagnostics: result.diagnostics,
    };
  }

  request(operation: ManagedTransportOperation) { return this.send(operation); }
  job(operation: ManagedTransportOperation, readErrorBody = true) { return this.send(operation, operation.headers ?? {}, true, readErrorBody); }

  async uploadSignedInput(url: string, method: string, headers: Record<string, string>, body: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    const response = await this.client.request({
      url, method, headers, body, signal,
      stream: false, preserveResponseHeaders: false,
      transport: "requestUrl", bodyEncoding: "raw",
    });
    if (!response.ok) throw new Error(`Signed upload failed (${response.status})`);
  }

  async uploadSignedJobPart(url: string, method: string, headers: Record<string, string>, body: ArrayBuffer, signal?: AbortSignal): Promise<Response> {
    return this.client.request({
      url, method, headers, body, signal,
      stream: false, preserveResponseHeaders: true,
      transport: "requestUrl", bodyEncoding: "raw",
    });
  }

  managedImageOutput(path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<ManagedTransportResult> {
    if (!/^\/api\/plugin\/images\/generations\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/outputs\/[0-3]$/.test(path)) {
      return Promise.reject(new Error("Invalid managed image output path."));
    }
    return this.send(
      { path, method: "GET", headers, signal },
      headers, true, false,
      { transport: "requestUrl", responseEncoding: "arrayBuffer", maxResponseBytes: MANAGED_IMAGE_OUTPUT_MAX_BYTES },
    );
  }

  async managedEmbeddingsIndex(
    body: ArrayBuffer,
    contentSha256: string,
    signal?: AbortSignal,
  ): Promise<ManagedTransportResult> {
    if (
      body.byteLength < 1
      || body.byteLength > MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES
      || !/^[a-f0-9]{64}$/.test(contentSha256)
    ) {
      throw new TypeError("Invalid managed embeddings index source.");
    }
    return this.managedEmbeddingsIndexRequest({
      path: "/api/plugin/embeddings/index",
      method: "POST",
      headers: {
        ...this.managedEmbeddingsIndexHeaders(),
        "content-type": "text/markdown; charset=utf-8",
        "x-systemsculpt-content-sha256": contentSha256,
        "x-systemsculpt-content-size": String(body.byteLength),
        "Idempotency-Key": `idx:${contentSha256}`,
      },
      body,
      bodyEncoding: "raw",
      maxResponseBytes: MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES,
      signal,
    });
  }

  getManagedEmbeddingsIndexMetadata(signal?: AbortSignal): Promise<ManagedTransportResult> {
    return this.managedEmbeddingsIndexRequest({
      path: "/api/plugin/embeddings/index",
      method: "GET",
      headers: this.managedEmbeddingsIndexHeaders(),
      maxResponseBytes: MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES,
      signal,
    });
  }

  managedEmbeddingsIndexQuery(
    query: string,
    contentSha256: string,
    signal?: AbortSignal,
  ): Promise<ManagedTransportResult> {
    if (!query || !/^[a-f0-9]{64}$/.test(contentSha256)) {
      return Promise.reject(new TypeError("Invalid managed embeddings index query."));
    }
    return this.managedEmbeddingsIndexRequest({
      path: "/api/plugin/embeddings/index/query",
      method: "POST",
      headers: {
        ...this.managedEmbeddingsIndexHeaders(),
        "Idempotency-Key": `idxq:${contentSha256}`,
      },
      body: { query },
      maxResponseBytes: MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES,
      signal,
    });
  }

  private managedEmbeddingsIndexHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "x-plugin-version": this.options.pluginVersion.trim(),
      "x-license-key": this.options.licenseKey().trim(),
      "x-systemsculpt-capability": "embeddings",
      "x-systemsculpt-embeddings-index-contract": MANAGED_EMBEDDINGS_INDEX_CONTRACT,
    };
  }

  private async managedEmbeddingsIndexRequest(input: {
    path: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: unknown;
    bodyEncoding?: "raw";
    maxResponseBytes: number;
    signal?: AbortSignal;
  }): Promise<ManagedTransportResult> {
    const response = await this.client.request({
      url: this.url(input.path),
      method: input.method,
      headers: input.headers,
      body: input.body,
      stream: false,
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      transport: "requestUrl",
      ...(input.bodyEncoding ? { bodyEncoding: input.bodyEncoding } : {}),
      responseEncoding: "arrayBuffer",
      maxResponseBytes: input.maxResponseBytes,
      signal: input.signal,
    });
    return {
      response,
      diagnostics: {
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        contentType: response.headers.get("content-type"),
        rateLimitLimit: response.headers.get("x-ratelimit-limit"),
        rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
        rateLimitReset: response.headers.get("x-ratelimit-reset"),
        retryAfter: response.headers.get("retry-after"),
        errorText: "",
      },
    };
  }

  private async send(operation: ManagedTransportOperation, extra: Record<string, string> = {}, scopedHeaders = false, readErrorBody = true, requestOverrides: Pick<PlatformRequestInput, "transport" | "responseEncoding" | "maxResponseBytes"> = {}): Promise<ManagedTransportResult> {
    const headers: Record<string, string> = scopedHeaders ? { ...extra } : { "x-plugin-version": this.options.pluginVersion, ...extra };
    if (!extra["x-systemsculpt-admission-contract"]) headers["x-systemsculpt-contract"] = MANAGED_CAPABILITY_CONTRACT;
    if (operation.capability) headers["x-systemsculpt-capability"] = operation.capability;
    if (operation.idempotencyKey) headers["Idempotency-Key"] = operation.idempotencyKey;
    const licenseKey = this.key();
    const response = await this.client.request({
      url: this.url(operation.path), method: operation.method ?? "POST", headers,
      body: operation.body, stream: false, preserveResponseHeaders: true,
      allowTransportFallback: isReplaySafeManagedRead(operation),
      signal: operation.signal, licenseKey,
      ...requestOverrides,
    });
    const errorText = response.ok || !readErrorBody ? "" : (await response.clone().text()).slice(0, 2048);
    return { response, diagnostics: {
      status: response.status, requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type"),
      rateLimitLimit: response.headers.get("x-ratelimit-limit"), rateLimitRemaining: response.headers.get("x-ratelimit-remaining"), rateLimitReset: response.headers.get("x-ratelimit-reset"),
      retryAfter: response.headers.get("retry-after"), errorText,
    } };
  }
}
