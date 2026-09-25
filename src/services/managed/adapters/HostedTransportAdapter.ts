import { PlatformRequestClient, type PlatformRequestInput } from "../../PlatformRequestClient";
import {
  MANAGED_ADMISSION_CONTRACT, MANAGED_CAPABILITY_CONTRACT, MANAGED_IMAGE_OUTPUT_MAX_BYTES, MANAGED_VIDEO_OUTPUT_MAX_BYTES,
  ManagedServerOutcome, ManagedTransportOperation, ManagedTransportResult,
} from "../ManagedTypes";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";
import {
  decodeLegacyLicenseProfile,
  decodeManagedAdmissionResponse,
  type LegacyLicenseProfile,
  type ManagedLicenseRejectReason,
} from "../ManagedAdmissionResponse";
import { SharedFlight } from "../SharedFlight";
import { SystemSculptEnvironment } from "../../api/SystemSculptEnvironment";
import {
  MANAGED_EMBEDDINGS_INDEX_CONTRACT,
  MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES,
  MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES,
  MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES,
} from "../../embeddings/gateway/ManagedEmbeddingsIndexAdapter";

export interface HostedTransportOptions { baseUrl: string; pluginVersion: string; licenseKey: () => string; requestClient?: PlatformRequestClient; }

/** One license admission read: the admission-v1 outcome, plus what license validation needs. */
export type HostedLicenseAdmission = Readonly<{
  outcome: ManagedServerOutcome;
  reason?: ManagedLicenseRejectReason;
  /** Only from pre-admission-v1 servers; never makes the outcome `allowed`. */
  legacyProfile?: LegacyLicenseProfile;
  diagnostics: ManagedTransportResult["diagnostics"];
}>;

const ADMISSION_PATH = "/api/plugin/license/validate";
const CONFIG_PATH = "/api/plugin/config";
const MAX_PLUGIN_CONFIG_CHARS = 1024 * 1024;

function isReplaySafeManagedRead(operation: ManagedTransportOperation): boolean {
  return (operation.method ?? "POST").toUpperCase() === "GET";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HostedTransportAdapter {
  private readonly client: PlatformRequestClient;
  /** Identical concurrent discovery and admission reads share one request (#386). */
  private readonly reads = new SharedFlight();
  private readonly authorizationRejectedListeners = new Set<() => void>();
  constructor(private readonly options: HostedTransportOptions) { this.client = options.requestClient ?? new PlatformRequestClient(); }

  /**
   * Hears every 401 or 403 from a managed endpoint other than admission
   * itself: the cached license admission is then stale.
   */
  onAuthorizationRejected(listener: () => void): () => void {
    this.authorizationRejectedListeners.add(listener);
    return () => {
      this.authorizationRejectedListeners.delete(listener);
    };
  }

  get pluginVersion(): string { return this.options.pluginVersion; }

  private url(path: string): string { return `${this.options.baseUrl.replace(/\/$/, "")}${path}`; }
  private key(): string | undefined { const key = this.options.licenseKey().trim(); return key || undefined; }

  /** The managed-capabilities-v2 catalog negotiated from /config. */
  getCatalog(signal?: AbortSignal) {
    return this.reads.run(`config:${MANAGED_CAPABILITY_CONTRACT}:${this.key() ?? ""}`, async (shared) => {
      const result = await this.send({ path: CONFIG_PATH, method: "GET", signal: shared }, { "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT });
      if (!result.response.ok) throw new Error(`Catalog unavailable (${result.response.status})`);
      return ManagedCapabilityCatalog.parse(await result.response.json());
    }, signal);
  }

  /**
   * The additive capability flags of the plugin-config-v1 document, the
   * other negotiation of /config. Advisory: any failure is null.
   */
  getPluginConfigCapabilities(signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const licenseKey = this.key();
    if (!licenseKey) return Promise.resolve(null);
    return this.reads.run(`config:plugin-config-v1:${licenseKey}`, async (shared) => {
      try {
        const response = await this.client.request({
          url: this.url(CONFIG_PATH),
          method: "GET",
          headers: {
            ...SystemSculptEnvironment.buildHeaders(),
            "x-plugin-version": this.options.pluginVersion.trim(),
          },
          licenseKey,
          preserveResponseHeaders: true,
          signal: shared,
        });
        if (!response.ok) return null;
        const text = await response.text();
        if (!text || text.length > MAX_PLUGIN_CONFIG_CHARS) return null;
        const payload: unknown = JSON.parse(text);
        return isRecord(payload) && payload.contract === "systemsculpt-plugin-config-v1" && isRecord(payload.capabilities)
          ? payload.capabilities
          : null;
      } catch {
        return null;
      }
    }, signal);
  }

  /**
   * One admission-v1 license read; concurrent callers of the same epoch share
   * it. A caller that invalidated its admission passes a new epoch so it
   * never joins a read that started before the invalidation.
   */
  getAdmission(signal?: AbortSignal, options: Readonly<{ epoch?: number }> = {}): Promise<HostedLicenseAdmission> {
    return this.reads.run(`admission:${this.key() ?? ""}:${options.epoch ?? 0}`, async (shared) => {
      const result = await this.send({ path: ADMISSION_PATH, method: "GET", signal: shared }, { "x-systemsculpt-admission-contract": MANAGED_ADMISSION_CONTRACT });
      let body: unknown;
      try { body = await result.response.clone().json(); } catch {
        // Admission decoding handles an absent response body.
      }
      const decoded = decodeManagedAdmissionResponse(result.response.status, body);
      const legacyProfile = decoded.outcome === "allowed" ? null : decodeLegacyLicenseProfile(result.response.status, body);
      return {
        outcome: decoded.outcome,
        ...(decoded.reason ? { reason: decoded.reason } : {}),
        ...(legacyProfile ? { legacyProfile } : {}),
        diagnostics: result.diagnostics,
      };
    }, signal);
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

  // managed-job-protocol-v2 media downloads: same identity-pinned path shape
  // as the v1 image output companion, plus video outputs with their larger
  // byte cap.
  managedMediaOutput(path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<ManagedTransportResult> {
    const identity = /^\/api\/plugin\/(images|videos)\/generations\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/outputs\/[0-3]$/.exec(path);
    if (!identity) return Promise.reject(new Error("Invalid managed media output path."));
    return this.send(
      { path, method: "GET", headers, signal },
      headers, true, false,
      {
        transport: "requestUrl",
        responseEncoding: "arrayBuffer",
        maxResponseBytes: identity[1] === "videos" ? MANAGED_VIDEO_OUTPUT_MAX_BYTES : MANAGED_IMAGE_OUTPUT_MAX_BYTES,
      },
    );
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
      ...(operation.timeoutMs !== undefined ? { timeoutMs: operation.timeoutMs } : {}),
      ...requestOverrides,
    });
    if ((response.status === 401 || response.status === 403) && !operation.path.startsWith(ADMISSION_PATH)) {
      for (const listener of [...this.authorizationRejectedListeners]) {
        try { listener(); } catch { /* A listener must not change the response. */ }
      }
    }
    const errorText = response.ok || !readErrorBody ? "" : (await response.clone().text()).slice(0, 2048);
    return { response, diagnostics: {
      status: response.status, requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type"),
      rateLimitLimit: response.headers.get("x-ratelimit-limit"), rateLimitRemaining: response.headers.get("x-ratelimit-remaining"), rateLimitReset: response.headers.get("x-ratelimit-reset"),
      retryAfter: response.headers.get("retry-after"), errorText,
    } };
  }
}
