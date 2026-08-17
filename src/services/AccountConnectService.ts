import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import SystemSculptPlugin from "../main";
import { PlatformRequestClient } from "./PlatformRequestClient";
import { openExternalUrl } from "../utils/externalUrl";

export type AccountConnectMode = "sign-in" | "sign-up";

type PendingConnectRequest = Readonly<{
  state: string;
  verifier: string;
  mode: AccountConnectMode;
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

/**
 * While a sign-in is pending the plugin polls the server for completion.
 * The obsidian:// deep link is only an accelerator — the host may gate it
 * behind a trust prompt or drop it entirely (observed on iOS and desktop),
 * so polling is what guarantees the sign-in finishes.
 */
const CONNECT_POLL_INTERVAL_MS = 3_500;

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
  private pollTimer: number | null = null;
  private pollInFlight = false;
  private pollSettled: Promise<void> | null = null;
  private lastOutcome: ConnectOutcome | null = null;
  private exchangeInProgress = false;
  private backgroundOutcomeHandler: ((outcome: ConnectOutcome) => void) | null = null;

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
    this.lastOutcome = null;
    this.stopPolling();
  }

  /**
   * Receives sign-in outcomes that complete in the background (via polling)
   * with no modal awaiting them, so the UI can greet the user immediately.
   */
  public setBackgroundOutcomeHandler(handler: ((outcome: ConnectOutcome) => void) | null): void {
    this.backgroundOutcomeHandler = handler;
  }

  /**
   * Starts a browser sign-in or sign-up and records the pending request.
   * Resolves false when the browser could not be opened so callers can show
   * the manual path instead of failing silently.
   */
  public async begin(mode: AccountConnectMode, ownerWindow?: Window): Promise<boolean> {
    const state = base64UrlEncode(this.randomBytes());
    const verifier = base64UrlEncode(this.randomBytes());
    this.pending = { state, verifier, mode, createdAt: Date.now() };
    this.lastOutcome = null;
    this.startPolling();

    const opened = await this.openUrl(await this.connectUrl(this.pending), ownerWindow);
    this.refreshSettingsTab();
    return opened;
  }

  /**
   * Re-opens the browser page for the active pending request (same state and
   * challenge, so any code the site mints still completes this sign-in).
   * Returns false when nothing is pending — callers should begin() instead.
   */
  public async reopen(ownerWindow?: Window): Promise<boolean> {
    const pending = this.activePending();
    if (!pending) return false;
    return this.openUrl(await this.connectUrl(pending), ownerWindow);
  }

  private async connectUrl(pending: PendingConnectRequest): Promise<string> {
    const challenge = base64UrlEncode(await this.sha256(pending.verifier));
    const origin = new URL(API_BASE_URL).origin;
    const path = pending.mode === "sign-up" ? "/sign-up" : "/sign-in";
    const redirect = `/plugin/connect?state=${pending.state}&challenge=${challenge}`;
    return `${origin}${path}?redirect_url=${encodeURIComponent(redirect)}`;
  }

  private startPolling(): void {
    this.stopPolling();
    if (typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      void this.pollOnce();
    }, CONNECT_POLL_INTERVAL_MS);
    this.pollTimer = timer;
    // Registered so a plugin unload can never leak the interval.
    this.plugin.registerInterval(timer);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const pending = this.activePending();
    if (!pending) {
      this.stopPolling();
      return;
    }
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    let settle!: () => void;
    this.pollSettled = new Promise((resolve) => { settle = resolve; });
    try {
      let response: Response;
      try {
        response = await this.requestClient.request({
          url: `${API_BASE_URL}/auth/poll`,
          method: "POST",
          headers: { ...SYSTEMSCULPT_API_HEADERS.DEFAULT },
          body: { verifier: pending.verifier },
        });
      } catch {
        return; // Transient network failure — keep polling until the TTL.
      }
      if (response.status !== 200) return;
      const payload = await this.readJson(response);
      const envelope =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null;
      if (!envelope || envelope.status === "pending") return;
      const success = this.readExchangeSuccess(payload);
      if (!success) return;
      // A deep-link or manual-code exchange may have won the race meanwhile.
      if (this.pending !== pending) return;
      this.stopPolling();
      const outcome =
        success.status === "ok"
          ? await this.completeSignIn(success.licenseKey, success.account)
          : await this.completeWithoutLicense(success.account);
      // When an exchange is awaiting this poll it delivers the outcome to
      // its own modal — announcing here too would stack a second one.
      if (!this.exchangeInProgress) this.backgroundOutcomeHandler?.(outcome);
    } finally {
      this.pollInFlight = false;
      this.pollSettled = null;
      settle();
    }
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

    this.exchangeInProgress = true;
    try {
      // A code in hand supersedes polling — but a poll fired on app-resume
      // may already be consuming this sign-in server-side. Racing it for the
      // single-use code would 401 here while the poll succeeds, so wait for
      // it and adopt its outcome instead.
      this.stopPolling();
      if (this.pollSettled) await this.pollSettled;
      if (this.pending !== pending) {
        return this.lastOutcome ?? { kind: "error", reason: "expired" };
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
        // Keep the pending request (and its polling guarantee) so the
        // manual code can be retried offline.
        this.startPolling();
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
        this.startPolling();
        return { kind: "error", reason: "rate-limited" };
      }
      this.startPolling();
      return { kind: "error", reason: "unavailable" };
    } finally {
      this.exchangeInProgress = false;
    }
  }

  private async completeSignIn(licenseKey: string, account: ExchangeAccount): Promise<ConnectOutcome> {
    this.pending = null;
    this.stopPolling();
    await this.plugin.getSettingsManager().updateSettings({
      licenseKey,
      userEmail: account.email ?? "",
      userName: account.name ?? account.email ?? "",
      displayName: account.name ?? account.email ?? "",
    });
    await this.plugin.getLicenseManager().validateLicenseKeyDetailed();
    this.refreshSettingsTab();
    const outcome: ConnectOutcome = {
      kind: "signed-in",
      name: account.name,
      email: account.email,
      licenseValid: this.plugin.settings.licenseValid === true,
    };
    this.lastOutcome = outcome;
    return outcome;
  }

  private async completeWithoutLicense(account: ExchangeAccount): Promise<ConnectOutcome> {
    this.pending = null;
    this.stopPolling();
    await this.plugin.getSettingsManager().updateSettings({
      licenseKey: "",
      licenseValid: false,
      userEmail: account.email ?? "",
      userName: account.name ?? account.email ?? "",
      displayName: account.name ?? account.email ?? "",
      subscriptionStatus: "",
    });
    this.refreshSettingsTab();
    const outcome: ConnectOutcome = { kind: "no-license", name: account.name, email: account.email };
    this.lastOutcome = outcome;
    return outcome;
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
