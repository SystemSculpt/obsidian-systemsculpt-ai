import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import SystemSculptPlugin from "../main";
import { PlatformRequestClient } from "./PlatformRequestClient";
import { openExternalUrl } from "../utils/externalUrl";

export type AccountConnectMode = "sign-in" | "sign-up";

type PendingConnectRequest = Readonly<{
  state: string;
  verifier: string;
  createdAt: number;
}>;

type ExchangeAccount = Readonly<{ email: string | null; name: string | null }>;
type ExchangeSuccess =
  | Readonly<{ status: "ok"; licenseKey: string; account: ExchangeAccount }>
  | Readonly<{ status: "no_license"; account: ExchangeAccount }>;

export type ConnectErrorReason =
  | "expired"
  | "state-mismatch"
  | "missing-code"
  | "network"
  | "invalid-code"
  | "rate-limited"
  | "unavailable";

/**
 * Result of a callback or manual-code exchange. Presentation (the connect
 * modal) owns the user-facing copy for each outcome.
 */
export type ConnectOutcome =
  | Readonly<{ kind: "signed-in"; name: string | null; email: string | null; licenseValid: boolean }>
  | Readonly<{ kind: "no-license"; name: string | null; email: string | null }>
  | Readonly<{ kind: "error"; reason: ConnectErrorReason }>;

/** Pending browser sign-in requests expire after ten minutes. */
const PENDING_CONNECT_TTL_MS = 10 * 60_000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Browser-based "Sign in with SystemSculpt" for the plugin.
 *
 * Owns the in-memory PKCE-style pending request (state + verifier), opens the
 * website sign-in flow, receives the obsidian://systemsculpt-connect deep link
 * (or a manually pasted code), and exchanges the one-time code for the
 * account's license key. The verifier and state live only in this service and
 * are never persisted to settings or data.json.
 */
export class AccountConnectService {
  private readonly requestClient: Pick<PlatformRequestClient, "request">;
  private readonly openUrl: (url: string, ownerWindow?: Window) => Promise<boolean>;
  private pending: PendingConnectRequest | null = null;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    requestClient: Pick<PlatformRequestClient, "request"> = new PlatformRequestClient(),
    openUrl: (url: string, ownerWindow?: Window) => Promise<boolean> = openExternalUrl,
  ) {
    this.requestClient = requestClient;
    this.openUrl = openUrl;
  }

  public hasPendingRequest(): boolean {
    return this.activePending() !== null;
  }

  public cancelPending(): void {
    this.pending = null;
  }

  /**
   * Starts a browser sign-in or sign-up and records the pending request.
   * Resolves false when the browser could not be opened so callers can show
   * the manual path instead of failing silently.
   */
  public async begin(mode: AccountConnectMode, ownerWindow?: Window): Promise<boolean> {
    const state = base64UrlEncode(this.randomBytes());
    const verifier = base64UrlEncode(this.randomBytes());
    const challenge = base64UrlEncode(await this.sha256(verifier));
    this.pending = { state, verifier, createdAt: Date.now() };

    const origin = new URL(API_BASE_URL).origin;
    const path = mode === "sign-up" ? "/sign-up" : "/sign-in";
    const redirect = `/plugin/connect?state=${state}&challenge=${challenge}`;
    const opened = await this.openUrl(
      `${origin}${path}?redirect_url=${encodeURIComponent(redirect)}`,
      ownerWindow,
    );
    this.refreshSettingsTab();
    return opened;
  }

  /** Handles the obsidian://systemsculpt-connect deep link from the website. */
  public async handleProtocolCallback(params: Record<string, string>): Promise<ConnectOutcome> {
    const pending = this.activePending();
    if (!pending) {
      return { kind: "error", reason: "expired" };
    }
    if ((params.state || "") !== pending.state) {
      return { kind: "error", reason: "state-mismatch" };
    }
    return this.exchange((params.code || "").trim(), pending);
  }

  /**
   * Exchanges a code the user pasted from the website. The state equality
   * check is skipped for manual entry; the in-memory verifier still binds the
   * exchange to this plugin instance.
   */
  public async submitManualCode(code: string): Promise<ConnectOutcome> {
    const pending = this.activePending();
    if (!pending) {
      return { kind: "error", reason: "expired" };
    }
    return this.exchange(code.trim(), pending);
  }

  private async exchange(code: string, pending: PendingConnectRequest): Promise<ConnectOutcome> {
    if (!code) {
      return { kind: "error", reason: "missing-code" };
    }

    let response: Response;
    try {
      response = await this.requestClient.request({
        url: `${API_BASE_URL}/auth/exchange`,
        method: "POST",
        headers: { ...SYSTEMSCULPT_API_HEADERS.DEFAULT },
        body: { code, verifier: pending.verifier },
      });
    } catch {
      // Keep the pending request so the manual code can be retried offline.
      return { kind: "error", reason: "network" };
    }

    const payload = await this.readJson(response);
    if (response.status === 200) {
      const success = this.readExchangeSuccess(payload);
      if (success?.status === "ok") {
        return this.completeSignIn(success.licenseKey, success.account);
      }
      if (success?.status === "no_license") {
        return this.completeWithoutLicense(success.account);
      }
    }
    if (response.status === 401) {
      this.pending = null;
      return { kind: "error", reason: "invalid-code" };
    }
    if (response.status === 429) {
      return { kind: "error", reason: "rate-limited" };
    }
    return { kind: "error", reason: "unavailable" };
  }

  private async completeSignIn(licenseKey: string, account: ExchangeAccount): Promise<ConnectOutcome> {
    this.pending = null;
    await this.plugin.getSettingsManager().updateSettings({
      licenseKey,
      userEmail: account.email ?? "",
      userName: account.name ?? account.email ?? "",
      displayName: account.name ?? account.email ?? "",
    });
    await this.plugin.getLicenseManager().validateLicenseKeyDetailed();
    this.refreshSettingsTab();
    return {
      kind: "signed-in",
      name: account.name,
      email: account.email,
      licenseValid: this.plugin.settings.licenseValid === true,
    };
  }

  private async completeWithoutLicense(account: ExchangeAccount): Promise<ConnectOutcome> {
    this.pending = null;
    await this.plugin.getSettingsManager().updateSettings({
      licenseKey: "",
      licenseValid: false,
      userEmail: account.email ?? "",
      userName: account.name ?? account.email ?? "",
      displayName: account.name ?? account.email ?? "",
      subscriptionStatus: "",
    });
    this.refreshSettingsTab();
    return { kind: "no-license", name: account.name, email: account.email };
  }

  private activePending(): PendingConnectRequest | null {
    if (!this.pending) return null;
    if (Date.now() - this.pending.createdAt > PENDING_CONNECT_TTL_MS) {
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  private randomBytes(): Uint8Array {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  private async sha256(value: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return new Uint8Array(digest);
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private readExchangeSuccess(value: unknown): ExchangeSuccess | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    const account = this.readAccount(envelope.account);
    if (envelope.status === "ok") {
      const licenseKey = typeof envelope.license_key === "string" ? envelope.license_key.trim() : "";
      if (!licenseKey) return null;
      return { status: "ok", licenseKey, account };
    }
    if (envelope.status === "no_license") {
      return { status: "no_license", account };
    }
    return null;
  }

  private readAccount(value: unknown): ExchangeAccount {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { email: null, name: null };
    }
    const record = value as Record<string, unknown>;
    const email = typeof record.email === "string" && record.email.trim() ? record.email.trim() : null;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null;
    return { email, name };
  }

  private refreshSettingsTab(): void {
    const tab = this.plugin.settingsTab;
    if (!tab?.containerEl?.isConnected) return;
    void Promise.resolve(tab.display()).catch(() => undefined);
  }
}
