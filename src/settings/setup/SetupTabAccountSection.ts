import { Notice, Setting, TextComponent } from "obsidian";
import { SystemSculptService } from "../../services/SystemSculptService";
import { SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { checkPremiumUserStatus } from "../../utils/licenseUtils";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";

export function renderAccountSection(
  root: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  isProActive: boolean
): void {
  root.createEl("h3", { text: "Account & License" });

  const { plugin } = tabInstance;
  const userStatus = checkPremiumUserStatus(plugin.settings);

  const statusSetting = new Setting(root)
    .setName("SystemSculpt account")
    .setDesc(
      isProActive
        ? userStatus.greeting || "Pro features enabled."
        : "Activate your license to turn on SystemSculpt chat, search, transcription, and workspace services."
    );

  if (!isProActive) {
    statusSetting.addButton((button) => {
      button
        .setButtonText("View plans")
        .setCta()
        .onClick(() => window.open(SYSTEMSCULPT_WEBSITE.LIFETIME, "_blank"));
    });
  } else {
    statusSetting.addExtraButton((button) => {
      button
        .setIcon("external-link")
        .setTooltip("Manage account")
        .onClick(() => window.open(SYSTEMSCULPT_WEBSITE.LICENSE, "_blank"));
    });
  }

  const licenseSetting = new Setting(root)
    .setName("License key")
    .setDesc(isProActive ? "License validated." : "Paste your license key to activate SystemSculpt.");

  let licenseInput: TextComponent | null = null;
  licenseSetting.addText((text) => {
    licenseInput = text;
    text
      .setPlaceholder("skss-...")
      .setValue(plugin.settings.licenseKey || "")
      .onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({ licenseKey: value });
      });
    text.inputEl.type = "password";
    tabInstance.registerListener(text.inputEl, "focus", () => {
      text.inputEl.type = "text";
    });
    tabInstance.registerListener(text.inputEl, "blur", () => {
      text.inputEl.type = "password";
    });
  });

  licenseSetting.addButton((button) => {
    button.setButtonText(isProActive ? "Deactivate" : "Activate");
    if (!isProActive) {
      button.setCta();
    }

    button.onClick(async () => {
      if (!licenseInput) return;
      const currentValue = (licenseInput.getValue() || "").trim();

      try {
        button.setDisabled(true);
        button.setButtonText("Working...");

        if (isProActive) {
          await plugin.getSettingsManager().updateSettings({
            licenseValid: false,
            enableSystemSculptProvider: false,
            useSystemSculptAsFallback: false,
          });
          new Notice("License deactivated.");
          tabInstance.display();
          return;
        }

        if (!currentValue) {
          new Notice("Please enter a license key first.");
          return;
        }

        await plugin.getSettingsManager().updateSettings({ licenseKey: currentValue });
        const validatingNotice = new Notice("Validating license key...", 0);
        try {
          const success = await plugin.getLicenseManager().validateLicenseKey(true, false);
          validatingNotice.hide();
          if (success) {
            try {
              await plugin.modelService.refreshModels();
            } catch {}
            new Notice("License activated successfully.");
            tabInstance.display();
          } else {
            new Notice("Invalid license key. Please check and try again.");
          }
        } catch (error: any) {
          validatingNotice.hide();
          new Notice(`License validation failed: ${error?.message || error}`);
        }
      } finally {
        button.setDisabled(false);
        button.setButtonText(isProActive ? "Deactivate" : "Activate");
      }
    });
  });

  if (isProActive && (plugin.settings.licenseKey || "").length > 0) {
    licenseSetting.addExtraButton((button) => {
      button
        .setIcon("copy")
        .setTooltip("Copy license key")
        .onClick(async () => {
          if (!plugin.settings.licenseKey) return;
          await navigator.clipboard.writeText(plugin.settings.licenseKey);
          new Notice("License key copied to clipboard.");
        });
    });
  }

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
      } catch (error: any) {
        annualUpgradeOffer = null;
        refreshAnnualUpgradeButton?.();
        const message = error?.message || String(error);
        creditsSetting.setDesc(`Unable to fetch credits balance. (${message})`);
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

    creditsSetting.addExtraButton((button) => {
      button
        .setIcon("external-link")
        .setTooltip("Buy more credits")
        .onClick(() => {
          window.open(purchaseUrl || SYSTEMSCULPT_WEBSITE.LICENSE, "_blank");
        });
    });

    void syncCredits();
  }
}
