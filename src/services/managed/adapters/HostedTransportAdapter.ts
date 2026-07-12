import { PlatformRequestClient } from "../../PlatformRequestClient";
import {
  MANAGED_ADMISSION_CONTRACT, MANAGED_CAPABILITY_CONTRACT,
  ManagedServerOutcome, ManagedTransportOperation, ManagedTransportResult,
} from "../ManagedTypes";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";

export interface HostedTransportOptions { baseUrl: string; pluginVersion: string; licenseKey: () => string; requestClient?: PlatformRequestClient; }

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
    let code: unknown;
    try { code = (await result.response.clone().json())?.code; } catch {}
    const exactMappings = new Map<string, ManagedServerOutcome>([
      ["200:allowed", "allowed"],
      ["401:license_required", "license_required"],
      ["403:license_rejected", "license_rejected"],
      ["429:rate_limited", "rate_limited"],
      ["503:temporarily_unavailable", "temporarily_unavailable"],
    ]);
    return {
      outcome: exactMappings.get(`${result.response.status}:${String(code)}`) ?? "temporarily_unavailable",
      diagnostics: result.diagnostics,
    };
  }

  public hasManagedChatConfiguration(): boolean {
    return this.options.licenseKey().trim().length > 0 && this.options.pluginVersion.trim().length > 0;
  }

  request(operation: ManagedTransportOperation) { return this.send(operation); }
  stream(operation: ManagedTransportOperation) { return this.send({ ...operation, method: operation.method ?? "POST" }, {}, true); }
  streamAcceptedChat(operation: ManagedTransportOperation) { return this.send({ ...operation, method: "POST" }, {}, true, false, true); }
  job(operation: ManagedTransportOperation) { return this.send(operation, operation.headers ?? {}, false, true); }

  async uploadSignedInput(url: string, method: string, headers: Record<string, string>, body: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    const response = await this.client.request({ url, method, headers, body, stream: false, preserveResponseHeaders: false, signal });
    if (!response.ok) throw new Error(`Signed upload failed (${response.status})`);
  }

  async uploadSignedJobPart(url: string, method: string, headers: Record<string, string>, body: ArrayBuffer, signal?: AbortSignal): Promise<Response> {
    return this.client.request({ url, method, headers, body, stream: false, preserveResponseHeaders: true, signal });
  }

  async downloadSignedImageOutput(url: string, signal?: AbortSignal): Promise<Response> {
    return this.client.request({ url, method: "GET", headers: {}, stream: false, preserveResponseHeaders: true, signal });
  }

  private async send(operation: ManagedTransportOperation, extra: Record<string, string> = {}, stream = false, scopedHeaders = false, exposeLicenseHeader = false): Promise<ManagedTransportResult> {
    const headers: Record<string, string> = scopedHeaders ? { ...extra } : { "x-plugin-version": this.options.pluginVersion, ...extra };
    if (!extra["x-systemsculpt-admission-contract"]) headers["x-systemsculpt-contract"] = MANAGED_CAPABILITY_CONTRACT;
    if (operation.capability) headers["x-systemsculpt-capability"] = operation.capability;
    if (operation.idempotencyKey) headers["Idempotency-Key"] = operation.idempotencyKey;
    const licenseKey = this.key();
    if (exposeLicenseHeader && licenseKey) headers["x-license-key"] = licenseKey;
    const response = await this.client.request({
      url: this.url(operation.path), method: operation.method ?? "POST", headers,
      body: operation.body, stream, preserveResponseHeaders: true,
      signal: operation.signal, licenseKey,
    });
    const errorText = response.ok ? "" : (await response.clone().text()).slice(0, 2048);
    return { response, diagnostics: {
      status: response.status, requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type"),
      rateLimitLimit: response.headers.get("x-ratelimit-limit"), rateLimitRemaining: response.headers.get("x-ratelimit-remaining"), rateLimitReset: response.headers.get("x-ratelimit-reset"),
      retryAfter: response.headers.get("retry-after"), errorText,
    } };
  }
}
