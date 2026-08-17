import { App, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { getSurfaceOwnerWindow } from "../core/ui/surface";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import type { ConnectErrorReason, ConnectOutcome } from "../services/AccountConnectService";
import { openExternalUrl } from "../utils/externalUrl";

const ERROR_COPY: Record<ConnectErrorReason, string> = {
  expired: "The sign-in session expired. Start sign-in again from SystemSculpt settings.",
  "state-mismatch": "The sign-in could not be verified. Start again from SystemSculpt settings.",
  "missing-code": "No connection code was received. Paste the code shown in your browser into SystemSculpt settings.",
  network: "Could not reach SystemSculpt. Check your connection, then try the code again from settings.",
  "invalid-code": "The connection code was invalid or expired. Start sign-in again from SystemSculpt settings.",
  "rate-limited": "Too many sign-in attempts. Wait a moment, then try again.",
  unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
};

/** Error reasons a fresh browser sign-in can recover from in one tap. */
const RETRYABLE_REASONS: ReadonlySet<ConnectErrorReason> = new Set([
  "expired",
  "state-mismatch",
  "invalid-code",
]);

/**
 * Post-outcome follow-ups owned by the caller so this modal stays free of
 * plugin wiring: continue into a chat, choose a plan, or restart sign-in.
 */
export type AccountConnectActions = Readonly<{
  onGetStarted?: () => void;
  onChoosePlan?: () => void;
  onRetrySignIn?: () => void;
}>;

/**
 * Shows the browser sign-in handoff inside Obsidian: an "Authenticating…"
 * state while the one-time code is exchanged, then a welcome, plan-needed, or
 * error state from the resulting ConnectOutcome.
 */
export class AccountConnectModal extends StandardModal {
  private static current: AccountConnectModal | null = null;

  constructor(
    app: App,
    private readonly runExchange: () => Promise<ConnectOutcome>,
    private readonly actions: AccountConnectActions = {},
  ) {
    super(app);
    this.setSize("small");
    this.modalEl.addClass("ss-account-connect-modal");
  }

  onOpen(): void {
    // Sign-in outcomes can arrive twice on app-resume (deep link + poll);
    // the newest modal replaces any earlier one instead of stacking on it.
    if (AccountConnectModal.current && AccountConnectModal.current !== this) {
      AccountConnectModal.current.close();
    }
    AccountConnectModal.current = this;
    super.onOpen();
    this.renderAuthenticating();

    const task = this.beginAsyncTask("account-connect-exchange");
    void this.runExchange()
      .catch((): ConnectOutcome => ({ kind: "error", reason: "unavailable" }))
      .then((outcome) => {
        if (!task.isCurrent()) return;
        this.renderOutcome(outcome);
      });
  }

  onClose(): void {
    if (AccountConnectModal.current === this) AccountConnectModal.current = null;
    super.onClose();
  }

  private renderOutcome(outcome: ConnectOutcome): void {
    if (outcome.kind === "signed-in") {
      this.renderSignedIn(outcome);
      return;
    }
    if (outcome.kind === "no-license") {
      this.renderNoLicense(outcome);
      return;
    }
    this.renderError(outcome.reason);
  }

  private renderAuthenticating(): void {
    this.resetSections();
    this.addTitle("Signing you in", "Completing the secure connection with SystemSculpt.");
    const status = this.contentEl.createDiv({ cls: "ss-account-connect__status" });
    status.createDiv({ cls: "ss-account-connect__spinner", attr: { "aria-hidden": "true" } });
    status.createDiv({ cls: "ss-account-connect__status-text", text: "Authenticating…" });
  }

  private renderSignedIn(outcome: Extract<ConnectOutcome, { kind: "signed-in" }>): void {
    this.resetSections();
    this.addTitle(this.welcomeTitle(outcome.name, outcome.email), "You're now signed in to SystemSculpt.");
    this.renderResultIcon("check-circle-2", "is-success");
    if (outcome.email) {
      this.contentEl.createDiv({ cls: "ss-account-connect__detail", text: `Signed in as ${outcome.email}.` });
    }
    this.contentEl.createDiv({
      cls: "ss-account-connect__detail",
      text: outcome.licenseValid
        ? "Your license is active — AI features are ready to use."
        : "Your license is being confirmed. If AI features stay locked, open SystemSculpt settings and retry validation.",
    });
    this.addActionButton(
      "account-connect.done",
      "Get started",
      () => {
        this.close();
        this.actions.onGetStarted?.();
      },
      true,
    );
  }

  private renderNoLicense(outcome: Extract<ConnectOutcome, { kind: "no-license" }>): void {
    this.resetSections();
    this.addTitle(this.welcomeTitle(outcome.name, outcome.email), "You're signed in — one step left.");
    this.renderResultIcon("check-circle-2", "is-success");
    if (outcome.email) {
      this.contentEl.createDiv({ cls: "ss-account-connect__detail", text: `Signed in as ${outcome.email}.` });
    }
    this.contentEl.createDiv({
      cls: "ss-account-connect__detail",
      text: "Your account has no active plan yet. Choose a plan to enable SystemSculpt AI features.",
    });
    const choosePlan = this.actions.onChoosePlan;
    this.addActionButton(
      "account-connect.choose-plan",
      "Choose a plan",
      () => {
        this.close();
        if (choosePlan) {
          choosePlan();
        } else {
          void openExternalUrl(SYSTEMSCULPT_WEBSITE.LICENSE, getSurfaceOwnerWindow(this.modalEl));
        }
      },
      true,
      "external-link",
    );
    this.addActionButton("account-connect.close", "Close", () => this.close());
  }

  private renderError(reason: ConnectErrorReason): void {
    this.resetSections();
    this.addTitle("Sign-in didn't finish", ERROR_COPY[reason]);
    this.renderResultIcon("alert-triangle", "is-error");
    const retry = this.actions.onRetrySignIn;
    if (retry && RETRYABLE_REASONS.has(reason)) {
      this.addActionButton(
        "account-connect.retry",
        "Start sign-in again",
        () => {
          this.close();
          retry();
        },
        true,
        "log-in",
      );
      this.addActionButton("account-connect.close", "Close", () => this.close());
      return;
    }
    this.addActionButton("account-connect.close", "Close", () => this.close(), true);
  }

  private renderResultIcon(icon: string, toneClass: string): void {
    const iconEl = this.contentEl.createDiv({
      cls: `ss-account-connect__icon ${toneClass}`,
      attr: { "aria-hidden": "true" },
    });
    setIcon(iconEl, icon);
  }

  private welcomeTitle(name: string | null, email: string | null): string {
    const firstName = (name || "").trim().split(/\s+/)[0] || (email || "").trim();
    return firstName ? `Welcome, ${firstName}!` : "Welcome!";
  }

  private resetSections(): void {
    this.headerEl.empty();
    this.contentEl.empty();
    this.footerEl.empty();
  }
}
