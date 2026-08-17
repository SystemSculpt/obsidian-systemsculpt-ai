import { setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { getSurfaceOwnerWindow } from "../core/ui/surface";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { PLAN_REQUIRED_MESSAGE } from "../utils/errors";
import { openExternalUrl } from "../utils/externalUrl";
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

const UTM_SUFFIX = "utm_source=obsidian-plugin&utm_medium=modal&utm_campaign=upgrade";

function withUtm(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${UTM_SUFFIX}`;
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

  /** Opens the modal unless one is already on screen (gate calls can race). */
  static openOnce(plugin: SystemSculptPlugin, options: UpgradePlanOptions = {}): UpgradePlanModal {
    if (UpgradePlanModal.current) return UpgradePlanModal.current;
    const modal = new UpgradePlanModal(plugin, options);
    modal.open();
    return modal;
  }

  /** Closes any open instance — used when the sign-in callback arrives. */
  static closeCurrent(): void {
    UpgradePlanModal.current?.close();
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
    super.onClose();
  }

  private renderMain(): void {
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
    this.addTitle(
      "Welcome to SystemSculpt AI",
      "AI chat, transcription, and document intelligence — right inside your vault.",
    );
    this.renderIcon("sparkles");
    this.addDetail("Sign in to connect your account, or create one free in seconds.");
    this.addActionButton("upgrade-plan.sign-in", "Sign in", () => this.beginConnect("sign-in"), true, "log-in");
    this.addActionButton("upgrade-plan.create-account", "Create free account", () => this.beginConnect("sign-up"));
    this.addActionButton("upgrade-plan.explore", "Explore on my own", () => this.close());
  }

  private renderSignedOut(): void {
    this.addTitle("Unlock SystemSculpt AI", this.featureLine());
    this.renderIcon("sparkles");
    this.addDetail(PLAN_REQUIRED_MESSAGE);
    this.addDetail("Sign in with your SystemSculpt account to get started — creating one is free.");
    this.addLink("upgrade-plan.pricing", "Compare plans on systemsculpt.com", SYSTEMSCULPT_WEBSITE.LICENSE);
    this.addActionButton("upgrade-plan.sign-in", "Sign in", () => this.beginConnect("sign-in"), true, "log-in");
    this.addActionButton("upgrade-plan.create-account", "Create free account", () => this.beginConnect("sign-up"));
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
      void openExternalUrl(withUtm(SYSTEMSCULPT_WEBSITE.LICENSE), getSurfaceOwnerWindow(this.modalEl));
    });
  }

  /** Opens checkout, then keeps guiding: purchase completes in the browser,
   * so the modal switches to the "come back and activate" state. */
  private openPurchase(url: string): void {
    void openExternalUrl(withUtm(url), getSurfaceOwnerWindow(this.modalEl));
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
      void service.reopen(ownerWindow).then((reopened) => {
        if (!reopened) void service.begin(mode, ownerWindow);
      });
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
          text: "Couldn't open your browser. Visit systemsculpt.com/sign-in on this device, then paste the connection code here.",
        });
      });
  }

  private completeManualCode(rawCode: string): void {
    const code = rawCode.trim();
    if (!code) return;
    const plugin = this.plugin;
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
        void openExternalUrl(withUtm(target), getSurfaceOwnerWindow(this.modalEl));
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
