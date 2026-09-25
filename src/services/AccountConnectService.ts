import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import SystemSculptPlugin from "../main";
import { PLATFORM_REQUEST_TIMEOUT_MS, PlatformRequestClient } from "./PlatformRequestClient";
import { openExternalUrl } from "../utils/externalUrl";
import { bytesToBase64 } from "../utils/base64";

export type AccountConnectMode = "sign-in" | "sign-up";

/** A server answer to one sign-in request, whatever its status. */
type SignInAnswer = Readonly<{ status: number; payload: unknown }>;

type PendingConnectRequest = {
  readonly state: string;
  readonly verifier: string;
  readonly mode: AccountConnectMode;
  readonly createdAt: number;
  /** Aborts this sign-in's requests still in flight once it ends. */
  readonly controller: AbortController;
  /** This sign-in's requests whose answer has not been handled yet. */
  readonly unsettled: Set<Promise<SignInAnswer | null>>;
  /**
   * A request of this sign-in ended without a definitive answer. The server
   * may still have burned the single-use code for it, so a later "invalid
   * code" does not prove the sign-in failed.
   */
  unanswered: boolean;
};

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
  | "unavailable"
  | "unconfirmed";

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

/**
 * Each poll owns the in-flight slot until it is answered, and a code exchange
 * waits on it. A poll the network does not answer gives that slot back after
 * a few intervals so later polls and the exchange can proceed; its request
 * stays observed (see send()).
 */
const CONNECT_POLL_TIMEOUT_MS = 15_000;

/** How long a code exchange waits for its own answer before reporting a network failure. */
const CONNECT_EXCHANGE_TIMEOUT_MS = PLATFORM_REQUEST_TIMEOUT_MS;

/**
 * How long an exchange told the code is already used waits for this sign-in's
 * requests still in flight, since one of them may have used it.
 */
const CONNECT_LATE_ANSWER_GRACE_MS = 15_000;

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Browser-based "Sign in with SystemSculpt" for the plugin.
 *
 * Owns the in-memory PKCE-style pending request (state + verifier), opens the
 * website sign-in flow, receives the obsidian://systemsculpt-connect deep link
 * (or a manually pasted code), and exchanges the one-time code for the
 * account's license key. The verifier and state live only in this service and
 * are never persisted to settings or data.json.
 *
 * Polls and exchanges race for the same single-use code, and the one answer
 * that carries the license key cannot be fetched again. So each sign-in has
 * exactly one completer: whichever of its requests first delivers a success,
 * whenever that answer lands. An exchange never races a poll it can wait for,
 * and it presents the completion's outcome itself; otherwise the completion
 * is announced in the background.
 */
export class AccountConnectService {
  private readonly requestClient: Pick<PlatformRequestClient, "request">;
  private readonly openUrl: (url: string, ownerWindow?: Window) => Promise<boolean>;
  private pending: PendingConnectRequest | null = null;
  private pollTimer: number | null = null;
  /** Settles when the poll holding the in-flight slot is answered or gives the slot back. */
  private pollSlot: Promise<void> | null = null;
  /** The completion of the latest sign-in, adopted by an exchange that was waiting on it. */
  private completion: Promise<ConnectOutcome> | null = null;
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
    this.endPending();
    this.completion = null;
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
    // A superseded sign-in's requests must neither hold the slot nor complete this one.
    this.endPending();
    this.completion = null;
    this.pending = {
      state,
      verifier,
      mode,
      createdAt: Date.now(),
      controller: new AbortController(),
      unsettled: new Set(),
      unanswered: false,
    };
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

  /**
   * Ends the pending sign-in, whether it completed, failed, was cancelled,
   * superseded, or expired: stops polling and aborts its requests in flight.
   */
  private endPending(): void {
    const pending = this.pending;
    this.pending = null;
    this.pollSlot = null;
    this.stopPolling();
    pending?.controller.abort();
  }

  private async pollOnce(): Promise<void> {
    const pending = this.activePending();
    if (!pending) {
      this.stopPolling();
      return;
    }
    if (this.pollSlot) return;
    const answer = this.send(pending, "/auth/poll", { verifier: pending.verifier });
    const slot = this.waitFor(answer, CONNECT_POLL_TIMEOUT_MS).then(() => undefined);
    this.pollSlot = slot;
    await slot;
    if (this.pollSlot === slot) this.pollSlot = null;
  }

  /**
   * Sends one sign-in request. Poll and exchange both burn the single-use
   * code, and the answer that carries the license key cannot be fetched
   * again, so the request has no client deadline: it stays observed until it
   * settles or this sign-in ends, and callers bound only how long they wait
   * for it. Resolves once its answer has been handled, or null when none came.
   */
  private send(
    pending: PendingConnectRequest,
    path: "/auth/poll" | "/auth/exchange",
    body: Record<string, string>,
  ): Promise<SignInAnswer | null> {
    const answer = (async (): Promise<SignInAnswer | null> => {
      let received: SignInAnswer;
      try {
        const response = await this.requestClient.request({
          url: `${API_BASE_URL}${path}`,
          method: "POST",
          headers: { ...SYSTEMSCULPT_API_HEADERS.DEFAULT },
          body,
          signal: pending.controller.signal,
          timeoutMs: null,
        });
        received = { status: response.status, payload: await this.readJson(response) };
      } catch {
        pending.unanswered = true;
        return null;
      }
      // A server failure can come after the code was already burned.
      if (received.status >= 500) pending.unanswered = true;
      // A completion that fails reaches the exchange adopting it, if any.
      await this.acceptSuccess(pending, received).catch(() => undefined);
      return received;
    })();
    pending.unsettled.add(answer);
    void answer.then(() => pending.unsettled.delete(answer));
    return answer;
  }

  /**
   * Completes the sign-in from the first of its requests to deliver a
   * success. An exchange waiting on this sign-in presents the outcome in its
   * own modal; otherwise it is announced in the background.
   */
  private async acceptSuccess(pending: PendingConnectRequest, answer: SignInAnswer): Promise<void> {
    if (answer.status !== 200) return;
    const success = this.readExchangeSuccess(answer.payload);
    // Another request completed this sign-in first, or it already ended.
    if (!success || this.pending !== pending) return;
    const outcome = await this.complete(success);
    if (!this.exchangeInProgress) this.backgroundOutcomeHandler?.(outcome);
  }

  /** Waits up to `ms` for `promise`; null when it has not settled by then. */
  private waitFor<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(null), ms);
      void promise.then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      });
    });
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
      if (this.pollSlot) await this.pollSlot;
      if (this.pending !== pending) return await this.adoptCompletion();

      const request = this.send(pending, "/auth/exchange", { code, verifier: pending.verifier });
      const answer = await this.waitFor(request, CONNECT_EXCHANGE_TIMEOUT_MS);
      // This exchange's own success, or a late poll's, completed the sign-in.
      if (this.pending !== pending) return await this.adoptCompletion();
      if (!answer) {
        // Keep the pending request (and its polling guarantee) so the
        // manual code can be retried offline. If this exchange is still in
        // flight, a late success completes the sign-in in the background.
        this.startPolling();
        return { kind: "error", reason: "network" };
      }
      if (answer.status === 401) {
        return await this.codeRejected(pending, request);
      }
      this.startPolling();
      return { kind: "error", reason: answer.status === 429 ? "rate-limited" : "unavailable" };
    } finally {
      this.exchangeInProgress = false;
    }
  }

  /**
   * The server says the code is invalid or already used. If another request
   * of this sign-in may have used it without its answer reaching us, that
   * proves nothing: wait briefly for such requests still in flight, and
   * otherwise keep the sign-in open so a fresh code from the browser can
   * finish it.
   */
  private async codeRejected(
    pending: PendingConnectRequest,
    exchange: Promise<SignInAnswer | null>,
  ): Promise<ConnectOutcome> {
    const inFlight = [...pending.unsettled].filter((request) => request !== exchange);
    if (!pending.unanswered && inFlight.length === 0) {
      this.endPending();
      return { kind: "error", reason: "invalid-code" };
    }
    if (inFlight.length > 0) {
      await this.waitFor(Promise.all(inFlight), CONNECT_LATE_ANSWER_GRACE_MS);
    }
    if (this.pending !== pending) return this.adoptCompletion();
    this.startPolling();
    return { kind: "error", reason: "unconfirmed" };
  }

  /** The outcome of whatever ended this sign-in while an exchange waited on it. */
  private adoptCompletion(): Promise<ConnectOutcome> {
    return this.completion ?? Promise.resolve({ kind: "error", reason: "expired" });
  }

  /** Stores the account from the one request that completed this sign-in. */
  private complete(success: ExchangeSuccess): Promise<ConnectOutcome> {
    this.endPending();
    this.completion = success.status === "ok"
      ? this.completeSignIn(success.licenseKey, success.account)
      : this.completeWithoutLicense(success.account);
    return this.completion;
  }

  private async completeSignIn(licenseKey: string, account: ExchangeAccount): Promise<ConnectOutcome> {
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
      this.endPending();
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
