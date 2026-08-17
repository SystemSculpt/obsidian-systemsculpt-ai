import { Notice } from "obsidian";
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

/** Pending browser sign-in requests expire after ten minutes. */
const PENDING_CONNECT_TTL_MS = 10 * 60_000;

const EXPIRED_NOTICE =
  "Sign-in session expired. Start sign-in again from SystemSculpt settings.";

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

  /** Starts a browser sign-in or sign-up and records the pending request. */
  public async begin(mode: AccountConnectMode, ownerWindow?: Window): Promise<void> {
    const state = base64UrlEncode(this.randomBytes());
    const verifier = base64UrlEncode(this.randomBytes());
    const challenge = base64UrlEncode(await this.sha256(verifier));
    this.pending = { state, verifier, createdAt: Date.now() };

    const origin = new URL(API_BASE_URL).origin;
    const path = mode === "sign-up" ? "/sign-up" : "/sign-in";
    const redirect = `/plugin/connect?state=${state}&challenge=${challenge}`;
    await this.openUrl(`${origin}${path}?redirect_url=${encodeURIComponent(redirect)}`, ownerWindow);
    this.refreshSettingsTab();
  }

  /** Handles the obsidian://systemsculpt-connect deep link from the website. */
  public async handleProtocolCallback(params: Record<string, string>): Promise<void> {
    const pending = this.activePending();
    if (!pending) {
      new Notice(EXPIRED_NOTICE);
      return;
    }
    if ((params.state || "") !== pending.state) {
      new Notice("Sign-in could not be verified. Start again from SystemSculpt settings.");
      return;
    }
    await this.exchange((params.code || "").trim(), pending);
  }

  /**
   * Exchanges a code the user pasted from the website. The state equality
   * check is skipped for manual entry; the in-memory verifier still binds the
   * exchange to this plugin instance.
   */
  public async submitManualCode(code: string): Promise<void> {
    const pending = this.activePending();
    if (!pending) {
      new Notice(EXPIRED_NOTICE);
      return;
    }
    await this.exchange(code.trim(), pending);
  }

  private async exchange(code: string, pending: PendingConnectRequest): Promise<void> {
    if (!code) {
      new Notice("Sign-in code was missing. Paste the code shown in your browser.");
      return;
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
      new Notice("Could not reach SystemSculpt. Check your connection and try the code again.");
      return;
    }

    const payload = await this.readJson(response);
    if (response.status === 200) {
      const success = this.readExchangeSuccess(payload);
      if (success?.status === "ok") {
        await this.completeSignIn(success.licenseKey, success.account);
        return;
      }
      if (success?.status === "no_license") {
        await this.completeWithoutLicense(success.account);
        return;
      }
    }
    if (response.status === 401) {
      this.pending = null;
      new Notice("Sign-in code was invalid or expired. Start again from SystemSculpt settings.");
      return;
    }
    if (response.status === 429) {
      new Notice("Too many sign-in attempts. Wait a moment and try again.");
      return;
    }
    new Notice("Sign-in is temporarily unavailable. Try again.");
  }

  private async completeSignIn(licenseKey: string, account: ExchangeAccount): Promise<void> {
    this.pending = null;
    await this.plugin.getSettingsManager().updateSettings({
      licenseKey,
      userEmail: account.email ?? "",
      userName: account.name ?? account.email ?? "",
      displayName: account.name ?? account.email ?? "",
    });
    await this.plugin.getLicenseManager().validateLicenseKeyDetailed();
    new Notice("Signed in to SystemSculpt.");
    this.refreshSettingsTab();
  }

  private async completeWithoutLicense(account: ExchangeAccount): Promise<void> {
    this.pending = null;
    await this.plugin.getSettingsManager().updateSettings({
      licenseKey: "",
      licenseValid: false,
      userEmail: account.email ?? "",
      userName: account.name ?? account.email ?? "",
      displayName: account.name ?? account.email ?? "",
      subscriptionStatus: "",
    });
    new Notice("Signed in. Choose a plan to enable SystemSculpt AI features.");
    this.refreshSettingsTab();
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
