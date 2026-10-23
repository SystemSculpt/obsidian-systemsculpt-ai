import { setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { getSurfaceOwnerWindow } from "../core/ui/surface";
import { SYSTEMSCULPT_WEBSITE, withPluginAttribution } from "../constants/externalServices";
import { PLAN_REQUIRED_MESSAGE } from "../utils/errors";
import { openExternalUrl } from "../utils/externalUrl";
import { hasHostCapability } from "../platform/hostCapabilities";
import { preferredLocalAgent } from "../services/codex/LocalAgentDetection";
import { localAgentDetectionDirectory } from "../services/codex/CodexExecutionSettings";
import { AccountConnectModal, type AccountConnectActions } from "./AccountConnectModal";
import type SystemSculptPlugin from "../main";
import type { AccountConnectMode } from "../services/AccountConnectService";

export type UpgradePlanContext = "gate" | "onboarding";

export type UpgradePlanOptions = Readonly<{
  /** Feature name shown in the description, e.g. "Chat" or "Transcription". */
  feature?: string;
  context?: UpgradePlanContext;
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

/** Standard post-sign-in actions for AccountConnectModal call sites. */
export function defaultAccountConnectActions(plugin: SystemSculptPlugin): AccountConnectActions {
  return {
    onGetStarted: () => {
      void plugin.openNewChat();
    },
    onChoosePlan: () => {
      UpgradePlanModal.openOnce(plugin);
    },
    onRetrySignIn: () => {
      void plugin.getAccountConnectService().begin("sign-in");
    },
  };
}

/**
 * The one place a user lands when SystemSculpt AI needs a plan: signed-out
 * users get the sign-in/create-account path, signed-in free accounts get the
 * lifetime/monthly purchase path, and both get a manual-code fallback so the
 * flow completes even when the browser cannot deep-link back into Obsidian
 * (common on iOS). Also renders the one-time first-run welcome.
 */
export class UpgradePlanModal extends StandardModal {
  private static current: UpgradePlanModal | null = null;
  /** The browser handoff is on screen and its sign-in has not finished. */
  private awaitingSignIn = false;
  /** Closing because the sign-in finished or moved to a code exchange. */
  private closingForCompletion = false;

  /** Opens the modal unless one is already on screen (gate calls can race). */
  static openOnce(plugin: SystemSculptPlugin, options: UpgradePlanOptions = {}): UpgradePlanModal {
    if (UpgradePlanModal.current) return UpgradePlanModal.current;
    const modal = new UpgradePlanModal(plugin, options);
    modal.open();
    return modal;
  }

  /** Closes any open instance — used when the sign-in callback arrives. */
  static closeCurrent(): void {
    const current = UpgradePlanModal.current;
    if (!current) return;
    current.closingForCompletion = true;
    current.close();
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
    if (!this.closingForCompletion) this.abandonSignIn();
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
    if (this.options.context === "onboarding") {
      this.renderOnboarding();
      return;
    }
    if (this.signedInEmail()) {
      this.renderChoosePlan();
    } else {
      this.renderSignedOut();
    }
  }

  private renderOnboarding(): void {
    // On-machine agents run on desktop only; mobile keeps the account path.
    const localAgents = hasHostCapability("local-cli", this.modalEl);
    this.addTitle(
      "Welcome to SystemSculpt AI",
      "AI chat, transcription, and document intelligence — right inside your vault.",
    );
    this.renderIcon("sparkles");
    this.addDetail("Create a free account to get 500 starter credits for hosted AI. No card needed. Paid plans start at $9/month.");
    if (localAgents) {
      this.addDetail("Already use Claude Code or Codex? Chat with your vault through your own install. No account needed.");
    }
    this.addLink("upgrade-plan.pricing", "View plans", SYSTEMSCULPT_WEBSITE.LICENSE);
    this.addActionButton("upgrade-plan.create-account", "Start free", () => this.beginConnect("sign-up"), true);
    this.addActionButton("upgrade-plan.sign-in", "Sign in", () => this.beginConnect("sign-in"), false, "log-in");
    if (localAgents) {
      this.addActionButton("upgrade-plan.use-local-agent", "Use my Claude Code or Codex", () => this.useLocalAgent(), false, "terminal");
    }
    this.addActionButton("upgrade-plan.explore", "Explore on my own", () => this.close());
  }

  /**
   * Opens a new chat on the detected local agent, exactly as choosing it in
   * the chat's Provider menu would.
   */
  private useLocalAgent(): void {
    const plugin = this.plugin;
    this.close();
    // A fresh install shows this welcome over Settings, which Obsidian can host
    // in its own window. Close it so the new chat is in front with focus.
    (plugin.app as typeof plugin.app & { setting?: { close?: () => void } }).setting?.close?.();
    void preferredLocalAgent({ workingDirectory: localAgentDetectionDirectory(plugin.app) })
      .then((agent) => plugin.getSettingsManager().updateSettings({ textExecutionBackend: agent }))
      // The chat still opens if the setting could not be saved; its Provider menu offers the same choice.
      .then(() => plugin.openNewChat(), () => plugin.openNewChat());
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
      "upgrade-plan.lifetime",
      "Get lifetime license",
      () => this.openPurchase(SYSTEMSCULPT_WEBSITE.LIFETIME),
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
      () => this.completeManualCode(codeInput.value),
      true,
    );
    this.addActionButton("upgrade-plan.back", "Back", () => this.renderMain());

    const ownerWindow = getSurfaceOwnerWindow(this.modalEl);
    void this.plugin
      .getAccountConnectService()
      .begin(mode, ownerWindow)
      .then((opened) => {
        if (opened !== false) return;
        status.empty();
        status.createDiv({
          cls: "ss-upgrade-plan__status-text",
          text: "Couldn't open your browser. Reopen the sign-in page, then paste the connection code shown there.",
        });
      });
  }

  private completeManualCode(rawCode: string): void {
    const code = rawCode.trim();
    if (!code) return;
    const plugin = this.plugin;
    this.closingForCompletion = true;
    this.close();
    new AccountConnectModal(
      plugin.app,
      () => plugin.getAccountConnectService().submitManualCode(code),
      defaultAccountConnectActions(plugin),
    ).open();
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

  private renderIcon(icon: string): void {
    const iconEl = this.contentEl.createDiv({
      cls: "ss-upgrade-plan__icon",
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
