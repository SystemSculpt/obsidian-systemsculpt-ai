import { PlatformRequestClient } from "../../PlatformRequestClient";
import {
  MANAGED_ADMISSION_CONTRACT, MANAGED_CAPABILITY_CONTRACT,
  ManagedServerOutcome, ManagedTransportOperation, ManagedTransportResult,
} from "../ManagedTypes";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";

export interface HostedTransportOptions { baseUrl: string; pluginVersion: string; licenseKey: () => string; requestClient?: PlatformRequestClient; }
export type ManagedChatTransportTicket = Readonly<{ kind: "managed_chat_transport_ticket" }>;
type ManagedChatConfiguration = Readonly<{ licenseKey: string; pluginVersion: string }>;

function isReplaySafeManagedRead(operation: ManagedTransportOperation): boolean {
  return (operation.method ?? "POST").toUpperCase() === "GET";
}

export class HostedTransportAdapter {
  private readonly client: PlatformRequestClient;
  private readonly managedChatConfigurations = new WeakMap<ManagedChatTransportTicket, ManagedChatConfiguration>();
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

  public beginManagedChatDispatch(): ManagedChatTransportTicket | null {
    const licenseKey = this.options.licenseKey().trim();
    const pluginVersion = this.options.pluginVersion.trim();
    if (!licenseKey || !pluginVersion) return null;
    const ticket: ManagedChatTransportTicket = Object.freeze({ kind: "managed_chat_transport_ticket" });
    this.managedChatConfigurations.set(ticket, Object.freeze({ licenseKey, pluginVersion }));
    return ticket;
  }

  request(operation: ManagedTransportOperation) { return this.send(operation); }
  stream(operation: ManagedTransportOperation) { return this.send({ ...operation, method: operation.method ?? "POST" }, {}, true); }
  streamAcceptedChat(ticket: ManagedChatTransportTicket, operation: ManagedTransportOperation) {
    const configuration = this.managedChatConfigurations.get(ticket);
    if (!configuration) return Promise.reject(new Error("Managed Chat transport configuration is unavailable."));
    return this.send({ ...operation, method: "POST" }, {}, true, false, configuration);
  }
  job(operation: ManagedTransportOperation, readErrorBody = true) { return this.send(operation, operation.headers ?? {}, false, true, undefined, readErrorBody); }

  async uploadSignedInput(url: string, method: string, headers: Record<string, string>, body: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    const response = await this.client.request({ url, method, headers, body, stream: false, preserveResponseHeaders: false, signal });
    if (!response.ok) throw new Error(`Signed upload failed (${response.status})`);
  }

  async uploadSignedJobPart(url: string, method: string, headers: Record<string, string>, body: ArrayBuffer, signal?: AbortSignal): Promise<Response> {
    return this.client.request({ url, method, headers, body, stream: false, preserveResponseHeaders: true, signal });
  }

  managedImageOutput(path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<ManagedTransportResult> {
    if (!/^\/api\/plugin\/images\/generations\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/outputs\/[0-3]$/.test(path)) {
      return Promise.reject(new Error("Invalid managed image output path."));
    }
    return this.send({ path, method: "GET", headers, signal }, headers, false, true, undefined, false);
  }

  private async send(operation: ManagedTransportOperation, extra: Record<string, string> = {}, stream = false, scopedHeaders = false, managedChatConfiguration?: ManagedChatConfiguration, readErrorBody = true): Promise<ManagedTransportResult> {
    const pluginVersion = managedChatConfiguration?.pluginVersion ?? this.options.pluginVersion;
    const headers: Record<string, string> = scopedHeaders ? { ...extra } : { "x-plugin-version": pluginVersion, ...extra };
    if (!extra["x-systemsculpt-admission-contract"]) headers["x-systemsculpt-contract"] = MANAGED_CAPABILITY_CONTRACT;
    if (operation.capability) headers["x-systemsculpt-capability"] = operation.capability;
    if (operation.idempotencyKey) headers["Idempotency-Key"] = operation.idempotencyKey;
    const licenseKey = managedChatConfiguration?.licenseKey ?? this.key();
    if (managedChatConfiguration) headers["x-license-key"] = managedChatConfiguration.licenseKey;
    const response = await this.client.request({
      url: this.url(operation.path), method: operation.method ?? "POST", headers,
      body: operation.body, stream, preserveResponseHeaders: true,
      allowTransportFallback: isReplaySafeManagedRead(operation),
      signal: operation.signal, licenseKey,
    });
    const errorText = response.ok || !readErrorBody ? "" : (await response.clone().text()).slice(0, 2048);
    return { response, diagnostics: {
      status: response.status, requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type"),
      rateLimitLimit: response.headers.get("x-ratelimit-limit"), rateLimitRemaining: response.headers.get("x-ratelimit-remaining"), rateLimitReset: response.headers.get("x-ratelimit-reset"),
      retryAfter: response.headers.get("retry-after"), errorText,
    } };
  }
}
