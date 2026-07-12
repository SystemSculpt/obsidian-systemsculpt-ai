import { Notice, Setting, TextComponent } from "obsidian";
import { SystemSculptService } from "../../services/SystemSculptService";
import { SYSTEMSCULPT_LEGAL_URLS, SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { checkPremiumUserStatus } from "../../utils/licenseUtils";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";

export function renderAccountSection(
  root: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  isProActive: boolean
): void {
  root.createEl("h3", { text: "Account & license" });

  const { plugin } = tabInstance;
  const userStatus = checkPremiumUserStatus(plugin.settings);
  const hasSavedLicense = (plugin.settings.licenseKey || "").trim().length > 0;

  let validateCurrentLicense: () => Promise<boolean>;
  validateCurrentLicense = async (): Promise<boolean> => {
    const validatingNotice = new Notice("Validating license key...", 0);
    try {
      const success = await plugin.getLicenseManager().validateLicenseKey(true, false);
      validatingNotice.hide?.();
      if (!success) {
        new Notice("Invalid license key. Please check and try again.");
        return false;
      }
      new Notice("License activated successfully.");
      tabInstance.display();
      return true;
    } catch {
      validatingNotice.hide?.();
      new Notice("Unable to validate license. Try again.");
      return false;
    }
  };

  const statusSetting = new Setting(root)
    .setName("SystemSculpt account")
    .setDesc(
      isProActive
        ? userStatus.greeting || "Pro features enabled."
        : "Activate your license to turn on SystemSculpt chat, search, transcription, and workspace services."
    );

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
        .onClick(() => window.open(SYSTEMSCULPT_WEBSITE.LICENSE, "_blank"));
    });
  } else {
    if (hasSavedLicense) {
      statusSetting.addButton((button) => {
        button.setButtonText("Retry").setCta().onClick(async () => {
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
        .onClick(() => window.open(SYSTEMSCULPT_WEBSITE.LIFETIME, "_blank"));
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
        if (!(await validateCurrentLicense())) {
          await plugin.getSettingsManager().updateSettings(priorLicenseState);
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
    let refreshAnnualUpgradeButton: (() => void) | null = null;

    const syncCredits = async () => {
      try {
        creditsSetting.setDesc("Fetching credits balance…");
        const balance = await aiService.getCreditsBalance();
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
        creditsSetting.setDesc(
          `Remaining: ${formatCredits(balance.totalRemaining)} credits (Included ${formatCredits(
            balance.includedRemaining
          )}/${formatCredits(balance.includedPerMonth)}, Add-on ${formatCredits(
            balance.addOnRemaining
          )}). Resets ${formatDate(balance.cycleEndsAt)}.${annualSavingsSuffix}`
        );
        refreshAnnualUpgradeButton?.();
      } catch {
        annualUpgradeOffer = null;
        refreshAnnualUpgradeButton?.();
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
        window.open(annualUpgradeOffer.checkoutUrl, "_blank");
      });
      applyState();
    });

    creditsSetting.addButton((button) => {
      button
        .setButtonText("Buy credits")
        .onClick(() => {
          window.open(purchaseUrl || SYSTEMSCULPT_WEBSITE.LICENSE, "_blank");
        });
    });

    void syncCredits();
  }

  const managedDataSetting = new Setting(root).setName("Managed data");
  managedDataSetting.descEl.append("Managed features send request content to SystemSculpt. See ");
  const termsLink = createEl("a");
  termsLink.href = SYSTEMSCULPT_LEGAL_URLS.TERMS;
  termsLink.target = "_blank";
  termsLink.rel = "noopener noreferrer";
  termsLink.textContent = "Terms";
  const privacyLink = createEl("a");
  privacyLink.href = SYSTEMSCULPT_LEGAL_URLS.PRIVACY;
  privacyLink.target = "_blank";
  privacyLink.rel = "noopener noreferrer";
  privacyLink.textContent = "Privacy";
  managedDataSetting.descEl.append(termsLink, " and ", privacyLink, ".");
}
