import { PlatformRequestClient } from "../PlatformRequestClient";

export const PRODUCT_INTEGRATION_CONTRACT = "product-integrations-v1" as const;
const PRODUCT_CONTRACT_HEADER = "x-systemsculpt-product-contract";
const REQUEST_ID_HEADER = "x-request-id";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{1,128}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const FORBIDDEN_RESPONSE_FIELDS = new Set([
  "provider", "upstream", "upstreamHostname", "credential", "token", "apiKey", "model", "framework",
]);

export type ProductIntegrationErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "version_unsupported"
  | "idempotency_required"
  | "payment_required"
  | "rate_limited"
  | "temporarily_unavailable"
  | "not_found"
  | "operation_failed"
  | "request_cancelled";

type ProductAdmissionOutcome =
  | "allowed"
  | "license_required"
  | "license_rejected"
  | "temporarily_unavailable"
  | "rate_limited";

export type WebSearchResult = Readonly<{ title: string; url: string; snippet: string }>;
export type ManagedWebSearchResponse = Readonly<{
  query: string;
  results: readonly WebSearchResult[];
  fetchedAt: string;
}>;
export type ManagedWebFetchResponse = Readonly<{
  url: string;
  finalUrl: string;
  title: string | null;
  markdown: string;
  contentType: string | null;
  fetchedAt: string;
  truncated: boolean;
}>;
export type ManagedYouTubeTranscriptResponse =
  | Readonly<{ status: "cached"; text: string; lang: string; metadata: { videoId: string; availableLangs: string[]; cached: true } }>
  | Readonly<{ status: "synchronous"; text: string; lang: string; metadata: { videoId: string; availableLangs: string[] } }>
  | Readonly<{ status: "job_started"; jobId: string; checkUrl: string }>
  | Readonly<{ status: "pending"; jobId: string }>
  | Readonly<{ status: "completed"; text: string; lang: string; metadata: { availableLangs: string[] } }>
  | Readonly<{ status: "failed"; error: string }>;
export type ManagedPluginReleaseResponse = Readonly<{
  status: "success";
  data: Readonly<{
    pluginId: "systemsculpt-ai";
    latestVersion: string;
    releaseUrl: string | null;
    publishedAt: string | null;
    critical: boolean;
    yanked: boolean;
  }>;
}>;

export class ManagedProductIntegrationError extends Error {
  constructor(
    public readonly code: ProductIntegrationErrorCode,
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
  ) {
    super(message.slice(0, MAX_ERROR_MESSAGE_LENGTH));
    this.name = "ManagedProductIntegrationError";
  }
}

export type ManagedProductIntegrationClientOptions = Readonly<{
  baseUrl: string;
  pluginVersion: string;
  licenseKey: () => string;
  acquireAdmission: () => Promise<{ outcome: ProductAdmissionOutcome }>;
  requestClient?: PlatformRequestClient;
  createRequestId?: () => string;
}>;

type LicensedCall<T> = Readonly<{
  prepare: () => T;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function rejectForbiddenFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenFields);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RESPONSE_FIELDS.has(key)) throw new Error("response contains a forbidden field");
    rejectForbiddenFields(nested);
  }
}

function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export class ManagedProductIntegrationClient {
  private readonly requestClient: PlatformRequestClient;
  private readonly baseUrl: string;
  private readonly createRequestId: () => string;

  constructor(private readonly options: ManagedProductIntegrationClientOptions) {
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.createRequestId = options.createRequestId ?? requestId;
  }

  async webSearch(call: LicensedCall<{ query: string; maxResults?: number }>): Promise<ManagedWebSearchResponse> {
    return this.licensed("/api/plugin/web/search", "POST", call, (prepared) => {
      const query = this.nonEmpty(prepared.query, "query", 4_000);
      const maxResults = this.optionalInteger(prepared.maxResults, "maxResults", 1, 10);
      return {
        body: { query, ...(typeof maxResults === "number" ? { max_results: maxResults } : {}) },
        parse: (value: unknown) => this.parseWebSearch(value),
      };
    });
  }

  async webFetch(call: LicensedCall<{ url: string; maxChars?: number }>): Promise<ManagedWebFetchResponse> {
    return this.licensed("/api/plugin/web/fetch", "POST", call, (prepared) => {
      const url = this.httpUrl(prepared.url, "url");
      const maxChars = this.optionalInteger(prepared.maxChars, "maxChars", 1, 200_000);
      return {
        body: { url, ...(typeof maxChars === "number" ? { max_chars: maxChars } : {}) },
        parse: (value: unknown) => this.parseWebFetch(value),
      };
    });
  }

  async startYouTubeTranscript(call: LicensedCall<{ url: string; lang?: string }>): Promise<ManagedYouTubeTranscriptResponse> {
    return this.licensed("/api/plugin/youtube/transcripts", "POST", call, (prepared) => {
      const url = this.httpUrl(prepared.url, "url");
      const lang = typeof prepared.lang === "undefined" ? undefined : this.nonEmpty(prepared.lang, "lang", 64);
      return {
        body: { url, ...(lang ? { lang } : {}) },
        parse: (value: unknown) => this.parseYouTube(value),
      };
    });
  }

  async getYouTubeTranscriptStatus(input: Readonly<{ jobId: string; signal?: AbortSignal }>): Promise<ManagedYouTubeTranscriptResponse> {
    await this.requireAdmission();
    const jobId = input.jobId.trim();
    if (!JOB_ID.test(jobId)) throw this.localError("invalid_request", "Invalid transcript job ID.");
    return this.send({
      path: `/api/plugin/youtube/transcripts/${jobId}`,
      method: "GET",
      licenseKey: this.requireLicenseKey(),
      signal: input.signal,
      parse: (value) => this.parseYouTube(value),
    });
  }

  async latestPluginRelease(input: Readonly<{ includePrerelease?: boolean; signal?: AbortSignal }> = {}): Promise<ManagedPluginReleaseResponse> {
    const query = input.includePrerelease ? "?includePrerelease=true" : "";
    return this.send({
      path: `/api/plugin/plugins/systemsculpt-ai/latest${query}`,
      method: "GET",
      signal: input.signal,
      parse: (value) => this.parsePluginRelease(value),
    });
  }

  private async licensed<P, R>(
    path: string,
    method: "POST",
    call: LicensedCall<P>,
    bind: (prepared: P) => { body: unknown; parse: (value: unknown) => R },
  ): Promise<R> {
    if (!IDEMPOTENCY_KEY.test(call.idempotencyKey)) {
      throw this.localError("idempotency_required", "A valid caller idempotency key is required.");
    }
    await this.requireAdmission();
    const prepared = call.prepare();
    const operation = bind(prepared);
    return this.send({
      path,
      method,
      body: operation.body,
      licenseKey: this.requireLicenseKey(),
      idempotencyKey: call.idempotencyKey,
      signal: call.signal,
      parse: operation.parse,
    });
  }

  private async requireAdmission(): Promise<void> {
    let outcome: ProductAdmissionOutcome;
    try {
      outcome = (await this.options.acquireAdmission()).outcome;
    } catch {
      throw this.localError("temporarily_unavailable", "SystemSculpt is temporarily unavailable.");
    }
    if (outcome === "allowed") return;
    if (outcome === "rate_limited") {
      throw this.localError("rate_limited", "Please retry later.", 429);
    }
    if (outcome === "temporarily_unavailable") {
      throw this.localError("temporarily_unavailable", "SystemSculpt is temporarily unavailable.", 503);
    }
    throw this.localError("authentication_failed", "A valid SystemSculpt license is required.", outcome === "license_required" ? 401 : 403);
  }

  private requireLicenseKey(): string {
    const key = this.options.licenseKey().trim();
    if (!key) throw this.localError("authentication_failed", "A valid SystemSculpt license is required.", 401);
    return key;
  }

  private async send<R>(operation: {
    path: string;
    method: "GET" | "POST";
    body?: unknown;
    licenseKey?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
    parse: (value: unknown) => R;
  }): Promise<R> {
    const outgoingRequestId = this.createRequestId().trim();
    if (!outgoingRequestId || outgoingRequestId.length > 128) {
      throw this.localError("invalid_request", "Unable to create a valid request ID.");
    }
    const headers: Record<string, string> = {
      [PRODUCT_CONTRACT_HEADER]: PRODUCT_INTEGRATION_CONTRACT,
      [REQUEST_ID_HEADER]: outgoingRequestId,
      "x-plugin-version": this.options.pluginVersion,
      ...(operation.idempotencyKey ? { "Idempotency-Key": operation.idempotencyKey } : {}),
    };
    let response: Response;
    try {
      response = await this.requestClient.request({
        url: `${this.baseUrl}${operation.path}`,
        method: operation.method,
        headers,
        body: operation.body,
        signal: operation.signal,
        licenseKey: operation.licenseKey,
        preserveResponseHeaders: true,
      });
    } catch (error) {
      if (operation.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      throw this.localError("temporarily_unavailable", "SystemSculpt is temporarily unavailable.", 503, outgoingRequestId);
    }

    if (
      response.headers.get(PRODUCT_CONTRACT_HEADER) !== PRODUCT_INTEGRATION_CONTRACT
      || response.headers.get(REQUEST_ID_HEADER) !== outgoingRequestId
    ) {
      throw this.invalidResponse();
    }

    let value: unknown;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("response too large");
      value = JSON.parse(text);
      rejectForbiddenFields(value);
    } catch {
      throw this.invalidResponse();
    }

    if (!response.ok) throw this.parseError(value, response.status, outgoingRequestId);
    try {
      return operation.parse(value);
    } catch {
      throw this.invalidResponse();
    }
  }

  private parseError(value: unknown, status: number, outgoingRequestId: string): ManagedProductIntegrationError {
    try {
      const envelope = record(value, "error response");
      exactKeys(envelope, ["status", "error", "requestId"], "error response");
      if (envelope.status !== "error" || envelope.requestId !== outgoingRequestId) throw new Error("invalid envelope");
      const error = record(envelope.error, "error body");
      exactKeys(error, ["code", "message"], "error body");
      const code = error.code;
      const message = error.message;
      if (!this.isErrorCode(code) || typeof message !== "string" || !message.trim() || message.length > MAX_ERROR_MESSAGE_LENGTH) {
        throw new Error("invalid typed error");
      }
      return new ManagedProductIntegrationError(code, message, status, outgoingRequestId);
    } catch {
      return this.invalidResponse();
    }
  }

  private parseWebSearch(value: unknown): ManagedWebSearchResponse {
    const response = record(value, "web search response");
    exactKeys(response, ["query", "results", "fetchedAt"], "web search response");
    if (typeof response.query !== "string" || typeof response.fetchedAt !== "string" || !Array.isArray(response.results)) {
      throw new Error("invalid web search response");
    }
    for (const result of response.results) {
      const item = record(result, "web search result");
      exactKeys(item, ["title", "url", "snippet"], "web search result");
      if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.snippet !== "string") {
        throw new Error("invalid web search result");
      }
    }
    return response as unknown as ManagedWebSearchResponse;
  }

  private parseWebFetch(value: unknown): ManagedWebFetchResponse {
    const response = record(value, "web fetch response");
    exactKeys(response, ["url", "finalUrl", "title", "markdown", "contentType", "fetchedAt", "truncated"], "web fetch response");
    if (
      typeof response.url !== "string" || typeof response.finalUrl !== "string"
      || (response.title !== null && typeof response.title !== "string")
      || typeof response.markdown !== "string"
      || (response.contentType !== null && typeof response.contentType !== "string")
      || typeof response.fetchedAt !== "string" || typeof response.truncated !== "boolean"
    ) throw new Error("invalid web fetch response");
    return response as unknown as ManagedWebFetchResponse;
  }

  private parseYouTube(value: unknown): ManagedYouTubeTranscriptResponse {
    const response = record(value, "YouTube transcript response");
    const status = response.status;
    if (!["cached", "synchronous", "job_started", "pending", "completed", "failed"].includes(String(status))) {
      throw new Error("invalid YouTube transcript status");
    }
    if (status === "job_started") {
      exactKeys(response, ["status", "jobId", "checkUrl"], "YouTube job response");
      if (typeof response.jobId !== "string" || !JOB_ID.test(response.jobId)
        || response.checkUrl !== `/api/plugin/youtube/transcripts/${response.jobId}`) throw new Error("invalid YouTube job response");
    } else if (status === "pending") {
      exactKeys(response, ["status", "jobId"], "YouTube pending response");
      if (typeof response.jobId !== "string" || !JOB_ID.test(response.jobId)) throw new Error("invalid YouTube pending response");
    } else if (status === "failed") {
      exactKeys(response, ["status", "error"], "YouTube failed response");
      if (typeof response.error !== "string" || !response.error || response.error.length > MAX_ERROR_MESSAGE_LENGTH) throw new Error("invalid YouTube failed response");
    } else {
      exactKeys(response, ["status", "text", "lang", "metadata"], "YouTube transcript response");
      if (typeof response.text !== "string" || typeof response.lang !== "string") throw new Error("invalid YouTube transcript response");
      const metadata = record(response.metadata, "YouTube transcript metadata");
      if (status === "completed") {
        exactKeys(metadata, ["availableLangs"], "YouTube completed metadata");
      } else if (status === "cached") {
        exactKeys(metadata, ["videoId", "availableLangs", "cached"], "YouTube cached metadata");
        if (metadata.cached !== true) throw new Error("invalid YouTube cached metadata");
      } else {
        exactKeys(metadata, ["videoId", "availableLangs"], "YouTube synchronous metadata");
      }
      strings(metadata.availableLangs, "availableLangs");
      if (status !== "completed" && typeof metadata.videoId !== "string") throw new Error("invalid YouTube video ID");
    }
    return response as unknown as ManagedYouTubeTranscriptResponse;
  }

  private parsePluginRelease(value: unknown): ManagedPluginReleaseResponse {
    const response = record(value, "plugin release response");
    exactKeys(response, ["status", "data"], "plugin release response");
    if (response.status !== "success") throw new Error("invalid plugin release status");
    const data = record(response.data, "plugin release data");
    exactKeys(data, ["pluginId", "latestVersion", "releaseUrl", "publishedAt", "critical", "yanked"], "plugin release data");
    if (
      data.pluginId !== "systemsculpt-ai" || typeof data.latestVersion !== "string"
      || (data.releaseUrl !== null && typeof data.releaseUrl !== "string")
      || (data.publishedAt !== null && typeof data.publishedAt !== "string")
      || typeof data.critical !== "boolean" || typeof data.yanked !== "boolean"
    ) throw new Error("invalid plugin release response");
    return response as unknown as ManagedPluginReleaseResponse;
  }

  private nonEmpty(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
      throw this.localError("invalid_request", `Invalid ${label}.`);
    }
    return value.trim();
  }

  private httpUrl(value: unknown, label: string): string {
    const raw = this.nonEmpty(value, label, 4_096);
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw this.localError("invalid_request", `Invalid ${label}.`); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw this.localError("invalid_request", `Invalid ${label}.`);
    }
    return raw;
  }

  private optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
    if (typeof value === "undefined") return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw this.localError("invalid_request", `Invalid ${label}.`);
    }
    return value;
  }

  private isErrorCode(value: unknown): value is ProductIntegrationErrorCode {
    return [
      "invalid_request", "authentication_failed", "version_unsupported", "idempotency_required",
      "payment_required", "rate_limited", "temporarily_unavailable", "not_found",
      "operation_failed", "request_cancelled",
    ].includes(String(value));
  }

  private localError(code: ProductIntegrationErrorCode, message: string, status = 400, requestIdValue: string | null = null) {
    return new ManagedProductIntegrationError(code, message, status, requestIdValue);
  }

  private invalidResponse(): ManagedProductIntegrationError {
    return this.localError("temporarily_unavailable", "SystemSculpt returned an invalid response.", 502);
  }
}
