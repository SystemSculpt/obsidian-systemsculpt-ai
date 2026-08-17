import { Notice, Setting, TextComponent } from "obsidian";
import { SystemSculptService } from "../../services/SystemSculptService";
import { SYSTEMSCULPT_LEGAL_URLS, SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { checkPremiumUserStatus } from "../../utils/licenseUtils";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";
import { getSurfaceOwnerWindow } from "../../core/ui/surface/SurfaceDomContext";
import { openExternalUrl } from "../../utils/externalUrl";
import type { LicenseValidationResult } from "../../services/LicenseService";

export function renderAccountSection(
  root: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  isProActive: boolean
): void {
  const ownerWindow = getSurfaceOwnerWindow(root);
  root.createEl("h3", { text: "Account & license" });

  const { plugin } = tabInstance;
  const userStatus = checkPremiumUserStatus(plugin.settings);
  const hasSavedLicense = (plugin.settings.licenseKey || "").trim().length > 0;
  const connectService = plugin.getAccountConnectService();
  const pendingSignIn = !isProActive && connectService.hasPendingRequest();
  const signedInEmail = (plugin.settings.userEmail || "").trim();
  const signedInWithoutPlan = !isProActive && !hasSavedLicense && signedInEmail.length > 0;

  const beginConnect = async (
    button: { setDisabled(disabled: boolean): unknown },
    mode: "sign-in" | "sign-up"
  ): Promise<void> => {
    try {
      button.setDisabled(true);
      await connectService.begin(mode, ownerWindow);
    } finally {
      button.setDisabled(false);
    }
  };

  let validateCurrentLicense: () => Promise<LicenseValidationResult>;
  validateCurrentLicense = async (): Promise<LicenseValidationResult> => {
    const validatingNotice = new Notice("Validating license key...", 0);
    try {
      const result = await plugin.getLicenseManager().validateLicenseKeyDetailed();
      validatingNotice.hide?.();
      if (result.outcome === "rejected") {
        new Notice("Invalid license key. Please check and try again.");
        return result;
      }
      if (result.outcome === "unavailable") {
        new Notice("License validation is temporarily unavailable. Try again.");
        return result;
      }
      new Notice("License activated successfully.");
      tabInstance.display();
      return result;
    } catch {
      validatingNotice.hide?.();
      new Notice("Unable to validate license. Try again.");
      return { outcome: "unavailable", isValid: !!plugin.settings.licenseValid };
    }
  };

  const accountDesc = isProActive
    ? userStatus.greeting || "Pro features enabled."
    : signedInWithoutPlan
      ? `Signed in as ${signedInEmail}. No active plan yet — choose a plan to enable AI features.`
      : "Activate your license to turn on SystemSculpt chat, search, transcription, and workspace services.";
  const statusSetting = new Setting(root)
    .setName("Account")
    .setDesc(pendingSignIn ? `${accountDesc} Waiting for browser sign-in…` : accountDesc);

  if (isProActive) {
    statusSetting.addButton((button) => {
      button
        .setButtonText("Deactivate")
        .onClick(async () => {
          try {
            button.setDisabled(true).setButtonText("Working...");
            await plugin.getSettingsManager().updateSettings({
              licenseKey: "",
              licenseValid: false,
              userEmail: "",
              userName: "",
              displayName: "",
              subscriptionStatus: "",
              lastValidated: 0,
            });
            new Notice("License deactivated.");
            tabInstance.display();
          } finally {
            button.setDisabled(false).setButtonText("Deactivate");
          }
        });
    });
    statusSetting.addExtraButton((button) => {
      button
        .setIcon("external-link")
        .setTooltip("Manage account")
        .onClick(() => void openExternalUrl(SYSTEMSCULPT_WEBSITE.LICENSE, ownerWindow));
    });
  } else if (signedInWithoutPlan) {
    statusSetting.addButton((button) => {
      button
        .setButtonText("View plans")
        .setCta()
        .onClick(() => void openExternalUrl(SYSTEMSCULPT_WEBSITE.LICENSE, ownerWindow));
    });
    statusSetting.addButton((button) => {
      // Re-runs the browser connect; after a purchase the exchange returns
      // the account's license key.
      button
        .setButtonText("Sync license")
        .onClick(() => void beginConnect(button, "sign-in"));
    });
    statusSetting.addButton((button) => {
      button.setButtonText("Sign out").onClick(async () => {
        try {
          button.setDisabled(true).setButtonText("Working...");
          connectService.cancelPending();
          await plugin.getSettingsManager().updateSettings({
            userEmail: "",
            userName: "",
            displayName: "",
            subscriptionStatus: "",
          });
          tabInstance.display();
        } finally {
          button.setDisabled(false).setButtonText("Sign out");
        }
      });
    });
  } else {
    statusSetting.addButton((button) => {
      button
        .setButtonText("Sign in")
        .setCta()
        .onClick(() => void beginConnect(button, "sign-in"));
    });
    statusSetting.addButton((button) => {
      button
        .setButtonText("Sign up")
        .onClick(() => void beginConnect(button, "sign-up"));
    });
    if (hasSavedLicense) {
      statusSetting.addButton((button) => {
        button.setButtonText("Retry").onClick(async () => {
          try {
            button.setDisabled(true).setButtonText("Working...");
            await validateCurrentLicense();
          } finally {
            button.setDisabled(false).setButtonText("Retry");
          }
        });
      });
    }
    statusSetting.addButton((button) => {
      button
        .setButtonText("View plans")
        .onClick(() => void openExternalUrl(SYSTEMSCULPT_WEBSITE.LIFETIME, ownerWindow));
    });
  }

  if (pendingSignIn) {
    const codeSetting = new Setting(root)
      .setName("Connection code")
      .setDesc("If Obsidian did not open automatically, paste the code shown in your browser.");
    let codeInput: TextComponent | null = null;
    let submitCode: (() => Promise<void>) | null = null;
    codeSetting.addText((text) => {
      codeInput = text;
      text.setPlaceholder("Paste code");
      tabInstance.registerListener(text.inputEl, "keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" || !submitCode) return;
        event.preventDefault();
        void submitCode();
      });
    });
    codeSetting.addButton((button) => {
      button.setButtonText("Complete sign-in").setCta();
      submitCode = async () => {
        const value = (codeInput?.getValue() || "").trim();
        if (!value) {
          new Notice("Paste the connection code from your browser first.");
          return;
        }
        try {
          button.setDisabled(true).setButtonText("Working...");
          await connectService.submitManualCode(value);
        } finally {
          button.setDisabled(false).setButtonText("Complete sign-in");
        }
      };
      button.onClick(() => void submitCode?.());
    });
    codeSetting.addButton((button) => {
      button.setButtonText("Cancel").onClick(() => {
        connectService.cancelPending();
        tabInstance.display();
      });
    });
  }

  const licenseSetting = new Setting(root)
    .setName("License key")
    .setDesc(
      hasSavedLicense
        ? "Saved key is hidden. Enter a new key only to replace it."
        : "Enter a license key to activate SystemSculpt."
    );

  let licenseInput: TextComponent | null = null;
  let submitLicense: (() => Promise<void>) | null = null;
  let licenseActionInFlight = false;
  licenseSetting.addText((text) => {
    licenseInput = text;
    text
      .setPlaceholder(hasSavedLicense ? "Saved key ••••••••" : "skss-...")
      .setValue("");
    text.inputEl.type = "password";
    tabInstance.registerListener(text.inputEl, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !submitLicense) return;
      event.preventDefault();
      void submitLicense();
    });
  });

  licenseSetting.addButton((button) => {
    const idleLabel = hasSavedLicense ? "Replace" : "Activate";
    button.setButtonText(idleLabel).setCta();
    submitLicense = async () => {
      if (!licenseInput || licenseActionInFlight) return;
      licenseActionInFlight = true;
      const currentValue = (licenseInput.getValue() || "").trim();
      const priorLicenseState = {
        licenseKey: plugin.settings.licenseKey,
        licenseValid: plugin.settings.licenseValid === true,
      };

      try {
        button.setDisabled(true);
        button.setButtonText("Working...");
        if (!currentValue) {
          new Notice("Please enter a license key first.");
          return;
        }

        await plugin.getSettingsManager().updateSettings({ licenseKey: currentValue });
        const result = await validateCurrentLicense();
        if (result.outcome !== "valid" && (priorLicenseState.licenseKey || result.outcome === "rejected")) {
          await plugin.getSettingsManager().updateSettings(priorLicenseState);
        } else if (result.outcome === "unavailable") {
          // Keep a first activation's key so the Retry action remains available
          // after a temporary outage. Existing active keys are restored above.
          await plugin.getSettingsManager().updateSettings({ licenseValid: false });
          tabInstance.display();
        }
      } catch {
        await plugin.getSettingsManager().updateSettings(priorLicenseState).catch(() => {});
        new Notice("Unable to update license. Try again.");
      } finally {
        licenseInput.setValue("");
        licenseActionInFlight = false;
        button.setDisabled(false);
        button.setButtonText(idleLabel);
      }
    };
    button.onClick(() => submitLicense?.());
  });

  if (isProActive && (plugin.settings.licenseKey || "").trim().length > 0) {
    const creditsSetting = new Setting(root).setName("Credits").setDesc("Fetching credits balance…");
    const aiService = SystemSculptService.getInstance(plugin);

    const formatCredits = (value: number): string => {
      try {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
      } catch {
        return String(value);
      }
    };

    const formatDate = (iso: string): string => {
      if (!iso) return "unknown";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "unknown";
      try {
        return new Intl.DateTimeFormat(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }).format(date);
      } catch {
        return date.toISOString().slice(0, 10);
      }
    };

    const formatUsd = (cents: number): string => {
      const normalizedCents = Number.isFinite(cents) ? Math.max(0, Math.floor(cents)) : 0;
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
          normalizedCents / 100
        );
      } catch {
        return `$${(normalizedCents / 100).toFixed(2)}`;
      }
    };

    let purchaseUrl: string | null = null;
    let annualUpgradeOffer: {
      amountSavedCents: number;
      percentSaved: number;
      checkoutUrl: string;
    } | null = null;
    let internalQa = false;
    let refreshAnnualUpgradeButton: (() => void) | null = null;
    let refreshBuyCreditsButton: (() => void) | null = null;

    const syncCredits = async () => {
      try {
        creditsSetting.setDesc("Fetching credits balance…");
        const balance = await aiService.getCreditsBalance();
        if (
          (
            balance.usageClass === "master_auth"
            || (balance.availableUnreserved ?? balance.totalRemaining) > 0
          )
          && plugin.embeddingsManager?.isSuspended()
        ) {
          void Promise.resolve(plugin.embeddingsManager.resumeProcessing("funding")).catch(() => undefined);
        }
        internalQa = balance.usageClass === "master_auth";
        if (internalQa) {
          purchaseUrl = null;
          annualUpgradeOffer = null;
          creditsSetting
            .setName("Usage mode")
            .setDesc(
              "Internal testing. Provider usage is tracked internally; customer credits are not used.",
            );
          refreshAnnualUpgradeButton?.();
          refreshBuyCreditsButton?.();
          return;
        }
        creditsSetting.setName("Credits");
        purchaseUrl = balance.purchaseUrl;
        annualUpgradeOffer =
          balance.billingCycle === "monthly" &&
          balance.annualUpgradeOffer &&
          Number.isFinite(balance.annualUpgradeOffer.amountSavedCents) &&
          balance.annualUpgradeOffer.amountSavedCents > 0 &&
          typeof balance.annualUpgradeOffer.checkoutUrl === "string" &&
          balance.annualUpgradeOffer.checkoutUrl.trim().length > 0
            ? {
                amountSavedCents: Math.floor(balance.annualUpgradeOffer.amountSavedCents),
                percentSaved: Math.max(0, Math.floor(balance.annualUpgradeOffer.percentSaved)),
                checkoutUrl: balance.annualUpgradeOffer.checkoutUrl.trim(),
              }
            : null;
        const annualSavingsSuffix = annualUpgradeOffer
          ? ` Switch to annual to save ${formatUsd(annualUpgradeOffer.amountSavedCents)} per year${
              annualUpgradeOffer.percentSaved > 0 ? ` (${annualUpgradeOffer.percentSaved}%)` : ""
            }.`
          : "";
        const heldInFlight = balance.heldInFlight ?? 0;
        const availableUnreserved = balance.availableUnreserved ?? balance.totalRemaining;
        creditsSetting.setDesc(
          `Available: ${formatCredits(availableUnreserved)} credits. Held in current requests: ${formatCredits(
            heldInFlight
          )} credits. Total balance: ${formatCredits(balance.totalRemaining)} credits (Included ${formatCredits(
            balance.includedRemaining
          )}/${formatCredits(balance.includedPerMonth)}, Add-on ${formatCredits(
            balance.addOnRemaining
          )}). Resets ${formatDate(balance.cycleEndsAt)}.${annualSavingsSuffix}`
        );
        refreshAnnualUpgradeButton?.();
        refreshBuyCreditsButton?.();
      } catch {
        annualUpgradeOffer = null;
        refreshAnnualUpgradeButton?.();
        refreshBuyCreditsButton?.();
        creditsSetting.setDesc("Unable to fetch credits balance. Try again.");
      }
    };

    creditsSetting.addButton((button) => {
      button.setButtonText("Details").onClick(async () => {
        await plugin.openCreditsBalanceModal({
          settingsTab: "account",
        });
      });
    });

    creditsSetting.addButton((button) => {
      button.setButtonText("Refresh").onClick(async () => {
        await syncCredits();
      });
    });

    creditsSetting.addButton((button) => {
      const applyState = () => {
        const enabled = !!annualUpgradeOffer?.checkoutUrl;
        button.buttonEl.style.display = enabled ? "" : "none";
        button.setDisabled(!enabled);
        if (enabled && annualUpgradeOffer) {
          button.setTooltip(`Save ${formatUsd(annualUpgradeOffer.amountSavedCents)} per year`);
        } else {
          button.setTooltip("Available for monthly subscriptions");
        }
      };
      refreshAnnualUpgradeButton = applyState;
      button.setButtonText("Switch to annual").onClick(() => {
        if (!annualUpgradeOffer?.checkoutUrl) {
          new Notice("Annual upgrade offer is currently unavailable for this account.");
          return;
        }
        void openExternalUrl(annualUpgradeOffer.checkoutUrl, ownerWindow);
      });
      applyState();
    });

    creditsSetting.addButton((button) => {
      const applyState = () => {
        button.buttonEl.style.display = internalQa ? "none" : "";
        button.setDisabled(internalQa);
      };
      refreshBuyCreditsButton = applyState;
      button
        .setButtonText("Buy credits")
        .onClick(() => {
          if (internalQa) return;
          void openExternalUrl(purchaseUrl || SYSTEMSCULPT_WEBSITE.LICENSE, ownerWindow);
        });
      applyState();
    });

    void syncCredits();
  }

  const managedDataSetting = new Setting(root).setName("AI data");
  managedDataSetting.descEl.append("AI features send request content to SystemSculpt. See ");
  const termsLink = managedDataSetting.descEl.createEl("a");
  termsLink.href = SYSTEMSCULPT_LEGAL_URLS.TERMS;
  termsLink.target = "_blank";
  termsLink.rel = "noopener noreferrer";
  termsLink.textContent = "Terms";
  const privacyLink = managedDataSetting.descEl.createEl("a");
  privacyLink.href = SYSTEMSCULPT_LEGAL_URLS.PRIVACY;
  privacyLink.target = "_blank";
  privacyLink.rel = "noopener noreferrer";
  privacyLink.textContent = "Privacy";
  managedDataSetting.descEl.append(termsLink, " and ", privacyLink, ".");
}
