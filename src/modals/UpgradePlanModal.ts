import { Notice, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { getSurfaceOwnerWindow } from "../core/ui/surface";
import { SYSTEMSCULPT_WEBSITE, withPluginAttribution } from "../constants/externalServices";
import { PLAN_REQUIRED_MESSAGE } from "../utils/errors";
import { openExternalUrl } from "../utils/externalUrl";
import {
  CONNECT_ERROR_COPY,
  LICENSE_CONFIRMING_COPY,
  RETRYABLE_CONNECT_REASONS,
  connectOutcomeMessage,
  signedInLine,
} from "./AccountConnectOutcome";
import type SystemSculptPlugin from "../main";
import type { AccountConnectMode, ConnectOutcome } from "../services/AccountConnectService";

export type UpgradePlanOptions = Readonly<{
  /** Feature name shown in the description, e.g. "Chat" or "Transcription". */
  feature?: string;
}>;

/** True when the vault has a license key to send with managed requests. */
export function hasActivePlan(plugin: SystemSculptPlugin): boolean {
  return Boolean(plugin.settings?.licenseKey?.trim());
}

/**
 * Pre-flight plan gate for user-initiated AI actions. Returns true when the
 * action may proceed; otherwise opens the upgrade modal (once) and returns
 * false so the caller can abort silently — the modal is the feedback.
 */
export function requireActivePlan(plugin: SystemSculptPlugin, feature: string): boolean {
  if (hasActivePlan(plugin)) return true;
  UpgradePlanModal.openOnce(plugin, { feature });
  return false;
}

/**
 * Shows a sign-in outcome once, in the account surface on screen: this modal,
 * else Account settings, else one notice when neither is open.
 */
export function presentAccountConnectOutcome(plugin: SystemSculptPlugin, outcome: ConnectOutcome): void {
  if (UpgradePlanModal.showConnectOutcome(outcome)) return;
  if (plugin.settingsTab?.showAccountConnectOutcome(outcome)) return;
  new Notice(connectOutcomeMessage(outcome), outcome.kind === "error" ? 10_000 : 6_000);
}

/**
 * The one place a user lands when SystemSculpt AI needs a plan: signed-out
 * users get the sign-in/create-account path, signed-in free accounts get the
 * yearly/monthly purchase path, and both get a manual-code fallback so the
 * flow completes even when the browser cannot deep-link back into Obsidian
 * (common on iOS). A sign-in started here finishes here.
 */
export class UpgradePlanModal extends StandardModal {
  private static current: UpgradePlanModal | null = null;
  /** The browser handoff is on screen and its sign-in has not finished. */
  private awaitingSignIn = false;
  private connectMode: AccountConnectMode = "sign-in";

  /** Opens the modal unless one is already on screen (gate calls can race). */
  static openOnce(plugin: SystemSculptPlugin, options: UpgradePlanOptions = {}): UpgradePlanModal {
    if (UpgradePlanModal.current) return UpgradePlanModal.current;
    const modal = new UpgradePlanModal(plugin, options);
    modal.open();
    return modal;
  }

  /** Opens straight into the browser sign-up or sign-in handoff, as the welcome's buttons do. */
  static openConnect(
    plugin: SystemSculptPlugin,
    mode: AccountConnectMode,
    options: UpgradePlanOptions = {},
  ): UpgradePlanModal {
    const modal = UpgradePlanModal.openOnce(plugin, options);
    modal.beginConnect(mode);
    return modal;
  }

  /** Shows a sign-in outcome in the open instance; false when none is open. */
  static showConnectOutcome(outcome: ConnectOutcome): boolean {
    const current = UpgradePlanModal.current;
    if (!current) return false;
    current.renderConnectOutcome(outcome);
    return true;
  }

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly options: UpgradePlanOptions = {},
  ) {
    super(plugin.app);
    this.setSize("small");
    this.modalEl.addClass("ss-upgrade-plan-modal", "ss-modal--scrollable");
  }

  onOpen(): void {
    super.onOpen();
    UpgradePlanModal.current = this;
    this.renderMain();
  }

  onClose(): void {
    if (UpgradePlanModal.current === this) UpgradePlanModal.current = null;
    this.abandonSignIn();
    super.onClose();
  }

  /**
   * Leaving the browser handoff without finishing slows sign-in polling to a
   * background cadence (#359). The sign-in itself stays open: background
   * polls, its deep link, a pasted code, or returning to Obsidian complete it.
   */
  private abandonSignIn(): void {
    if (!this.awaitingSignIn) return;
    this.awaitingSignIn = false;
    this.plugin.getAccountConnectService().pollInBackground();
  }

  private renderMain(): void {
    this.abandonSignIn();
    this.resetSections();
    if (this.signedInEmail()) {
      this.renderChoosePlan();
    } else {
      this.renderSignedOut();
    }
  }

  /**
   * The result of the sign-in, in place of the handoff. A plan-less account
   * continues to the plan choice; failures offer the one useful next step.
   */
  private renderConnectOutcome(outcome: ConnectOutcome): void {
    const service = this.plugin.getAccountConnectService();
    // A failed code can leave the same sign-in open; leaving then still backgrounds it.
    this.awaitingSignIn = outcome.kind === "error" && service.hasPendingRequest();
    if (outcome.kind === "no-license") {
      this.renderMain();
      return;
    }
    this.resetSections();
    if (outcome.kind === "signed-in") {
      this.addTitle("You're signed in", signedInLine(outcome.email));
      this.renderIcon("check-circle-2", "is-success");
      if (!outcome.licenseValid) this.addDetail(LICENSE_CONFIRMING_COPY);
      this.addActionButton("upgrade-plan.done", "Done", () => this.close(), true);
      return;
    }
    this.addTitle("Sign-in didn't finish", CONNECT_ERROR_COPY[outcome.reason]);
    this.renderIcon("alert-triangle", "is-error");
    if (RETRYABLE_CONNECT_REASONS.has(outcome.reason)) {
      this.addActionButton(
        "upgrade-plan.retry",
        "Start sign-in again",
        () => this.beginConnect(this.connectMode),
        true,
        "log-in",
      );
    } else if (this.awaitingSignIn) {
      this.addActionButton(
        "upgrade-plan.enter-code",
        "Enter the code again",
        () => this.renderHandoff(this.connectMode),
        true,
      );
    }
    this.addActionButton("upgrade-plan.back", "Back", () => this.renderMain());
  }

  private renderSignedOut(): void {
    this.addTitle("Unlock SystemSculpt AI", this.featureLine());
    this.renderIcon("sparkles");
    this.addDetail("Create a free SystemSculpt account to get 500 starter credits. No card needed.");
    this.addLink("upgrade-plan.pricing", "Compare plans on systemsculpt.com", SYSTEMSCULPT_WEBSITE.LICENSE);
    this.addLink("upgrade-plan.license-key", "I have a license key", () => {
      this.close();
      this.plugin.openSettingsTab("account");
    });
    this.addActionButton("upgrade-plan.create-account", "Start free", () => this.beginConnect("sign-up"), true);
    this.addActionButton("upgrade-plan.sign-in", "Sign in", () => this.beginConnect("sign-in"), false, "log-in");
  }

  private renderChoosePlan(): void {
    this.addTitle("Unlock SystemSculpt AI", this.featureLine());
    this.renderIcon("sparkles");
    const email = this.signedInEmail();
    if (email) {
      this.addDetail(`Signed in as ${email}.`);
    }
    this.addDetail(PLAN_REQUIRED_MESSAGE);
    if (hasActivePlan(this.plugin)) {
      this.addDetail("Your current license isn't active. After renewing or purchasing, sync your license below.");
    }
    this.addLink("upgrade-plan.sync", "Already purchased? Sync your license", () => this.beginConnect("sign-in"));
    this.addActionButton(
      "upgrade-plan.yearly",
      "Subscribe yearly",
      () => this.openPurchase(SYSTEMSCULPT_WEBSITE.YEARLY),
      true,
      "external-link",
    );
    this.addActionButton(
      "upgrade-plan.subscribe",
      "Subscribe monthly",
      () => this.openPurchase(SYSTEMSCULPT_WEBSITE.SUBSCRIBE),
      false,
      "external-link",
    );
    this.addActionButton("upgrade-plan.pricing", "Compare plans", () => {
      void openExternalUrl(withPluginAttribution(SYSTEMSCULPT_WEBSITE.LICENSE, "modal"), getSurfaceOwnerWindow(this.modalEl));
    });
  }

  /** Opens checkout, then keeps guiding: purchase completes in the browser,
   * so the modal switches to the "come back and activate" state. */
  private openPurchase(url: string): void {
    void openExternalUrl(withPluginAttribution(url, "modal"), getSurfaceOwnerWindow(this.modalEl));
    this.renderAfterPurchase();
  }

  private renderAfterPurchase(): void {
    this.resetSections();
    this.addTitle("Finish your purchase in the browser", "Complete checkout, then come back here.");
    this.renderIcon("shopping-cart");
    if (this.signedInEmail()) {
      this.addDetail("Once you've purchased, sync your license to unlock AI features.");
      this.addActionButton(
        "upgrade-plan.sync",
        "I've purchased — Sync license",
        () => this.beginConnect("sign-in"),
        true,
        "refresh-cw",
      );
    } else {
      this.addDetail("Once you've purchased, sign in here to activate your license.");
      this.addActionButton("upgrade-plan.sign-in", "Sign in", () => this.beginConnect("sign-in"), true, "log-in");
    }
    this.addActionButton("upgrade-plan.back", "Back", () => this.renderMain());
  }

  /**
   * Starts the browser sign-in and switches to the handoff state. The manual
   * connection-code input stays visible the whole time so the flow still
   * completes when the obsidian:// deep link never fires.
   */
  private beginConnect(mode: AccountConnectMode): void {
    this.connectMode = mode;
    const status = this.renderHandoff(mode);
    const ownerWindow = getSurfaceOwnerWindow(this.modalEl);
    void this.plugin
      .getAccountConnectService()
      .begin(mode, ownerWindow)
      .then((opened) => {
        if (opened !== false || !this.contentEl.contains(status)) return;
        status.empty();
        status.createDiv({
          cls: "ss-upgrade-plan__status-text",
          text: "Couldn't open your browser. Reopen the sign-in page, then paste the connection code shown there.",
        });
      });
  }

  /** The browser handoff for the pending sign-in; returns its status line. */
  private renderHandoff(mode: AccountConnectMode): HTMLElement {
    this.resetSections();
    this.awaitingSignIn = true;
    this.addTitle(
      "Continue in your browser",
      mode === "sign-up" ? "Create your free SystemSculpt account." : "Sign in to SystemSculpt.",
    );
    const status = this.contentEl.createDiv({ cls: "ss-upgrade-plan__status" });
    status.createDiv({ cls: "ss-upgrade-plan__spinner", attr: { "aria-hidden": "true" } });
    status.createDiv({ cls: "ss-upgrade-plan__status-text", text: "Waiting for you to finish in the browser…" });
    this.addDetail("This screen finishes automatically once you're signed in. If nothing happens, paste the connection code shown in your browser:");
    const codeInput = this.contentEl.createEl("input", {
      cls: "ss-upgrade-plan__code-input",
      attr: {
        type: "text",
        placeholder: "Connection code",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        "data-testid": "upgrade-plan.code",
      },
    });
    this.addLink("upgrade-plan.reopen", "Open the sign-in page again", () => {
      const ownerWindow = getSurfaceOwnerWindow(this.modalEl);
      const service = this.plugin.getAccountConnectService();
      if (service.hasPendingRequest()) {
        void service.reopen(ownerWindow);
      } else {
        void service.begin(mode, ownerWindow);
      }
    });
    this.addActionButton(
      "upgrade-plan.complete-code",
      "Complete sign-in",
      () => this.completeManualCode(codeInput.value, status),
      true,
    );
    this.addActionButton("upgrade-plan.back", "Back", () => this.renderMain());
    return status;
  }

  /** Exchanges a pasted code; its outcome replaces this handoff when it arrives. */
  private completeManualCode(rawCode: string, status: HTMLElement): void {
    const code = rawCode.trim();
    if (!code) return;
    status.empty();
    status.createDiv({ cls: "ss-upgrade-plan__spinner", attr: { "aria-hidden": "true" } });
    status.createDiv({ cls: "ss-upgrade-plan__status-text", text: "Signing you in…" });
    void this.plugin.getAccountConnectService().submitManualCode(code);
  }

  private featureLine(): string {
    return this.options.feature
      ? `${this.options.feature} needs an active SystemSculpt plan.`
      : "SystemSculpt AI needs an active plan.";
  }

  private signedInEmail(): string | null {
    return this.plugin.settings.userEmail?.trim() || null;
  }

  private addDetail(text: string): HTMLElement {
    return this.contentEl.createDiv({ cls: "ss-upgrade-plan__detail", text });
  }

  private addLink(testId: string, label: string, target: string | (() => void)): void {
    const link = this.contentEl.createEl("button", {
      cls: "ss-upgrade-plan__link",
      text: label,
      attr: { type: "button", "data-testid": testId },
    });
    this.registerDomEvent(link, "click", () => {
      if (typeof target === "function") {
        target();
      } else {
        void openExternalUrl(withPluginAttribution(target, "modal"), getSurfaceOwnerWindow(this.modalEl));
      }
    });
  }

  private renderIcon(icon: string, toneClass = ""): void {
    const iconEl = this.contentEl.createDiv({
      cls: `ss-upgrade-plan__icon ${toneClass}`.trim(),
      attr: { "aria-hidden": "true" },
    });
    setIcon(iconEl, icon);
  }

  private resetSections(): void {
    this.headerEl.empty();
    this.contentEl.empty();
    this.footerEl.empty();
  }
}
