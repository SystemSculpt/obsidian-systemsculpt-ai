
import { Setting, Notice, TextComponent, ButtonComponent } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showCustomProviderModal } from "../modals/CustomProviderModal";
import { checkPremiumUserStatus } from "../utils/licenseUtils";
import { AI_PROVIDERS, LOCAL_SERVICES, SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { scanLocalLLMProviders } from "../services/providers/LocalLLMScanner";
import { ListSelectionModal, ListItem } from "../core/ui/modals/standard/ListSelectionModal";
import { showConfirm } from "../core/ui/notifications";
import { createExternalHelpLink } from "./uiHelpers";
import type { CustomProvider } from "../types/llm";
import { SystemSculptService } from "../services/SystemSculptService";
import {
  clearStudioPiProviderAuth,
  listStudioPiProviderAuthRecords,
  migrateStudioPiProviderApiKeys,
  setStudioPiProviderApiKey,
  type StudioPiApiKeyMigrationCandidate,
  type StudioPiApiKeyMigrationEntry,
  type StudioPiProviderAuthRecord,
} from "../studio/StudioLocalTextModelCatalog";
import {
  hasAuthenticatedStudioPiProvider,
  normalizeStudioPiProviderId,
} from "../studio/piAuth/StudioPiProviderAuthUtils";
import { runSetupPiOAuthLogin } from "./piAuth/SetupPiOAuthFlow";

const PROVIDER_PRESETS: Array<{ id: string; name: string; endpoint: string; description: string }> = [
  {
    id: "openai",
    name: "OpenAI",
    endpoint: AI_PROVIDERS.OPENAI.BASE_URL,
    description: "ChatGPT, GPT-4o, GPT-4.1, and latest OpenAI APIs"
  },
  {
    id: "anthropic",
    name: "Anthropic",
    endpoint: AI_PROVIDERS.ANTHROPIC.BASE_URL,
    description: "Claude 3 family with fast and reliable reasoning"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: AI_PROVIDERS.OPENROUTER.BASE_URL,
    description: "One API for many frontier models (Meta, Mistral, Perplexity)"
  },
  {
    id: "minimax",
    name: "MiniMax",
    endpoint: AI_PROVIDERS.MINIMAX.BASE_URL,
    description: "MiniMax M-series models with OpenAI-compatible endpoints"
  },
  {
    id: "moonshot",
    name: "Kimi K2 (Moonshot)",
    endpoint: AI_PROVIDERS.MOONSHOT.BASE_URL,
    description: "Moonshot (Kimi) K2 reasoning and vision models"
  },
  {
    id: "groq",
    name: "Groq",
    endpoint: AI_PROVIDERS.GROQ.BASE_URL,
    description: "Groq LPU hosted models with ultra-low latency"
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    endpoint: LOCAL_SERVICES.OLLAMA.BASE_URL,
    description: "Run open models locally with Ollama"
  },
  {
    id: "lmstudio",
    name: "LM Studio (Local)",
    endpoint: LOCAL_SERVICES.LM_STUDIO.BASE_URL,
    description: "Connect to LM Studio on localhost"
  },
  {
    id: "custom",
    name: "Custom Provider",
    endpoint: "",
    description: "Manually configure any OpenAI-compatible endpoint"
  }
];

const STUDIO_PI_AUTH_MIGRATION_VERSION = 1;

const KNOWN_PI_OAUTH_PROVIDER_IDS = new Set<string>([
  "anthropic",
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
]);

const PI_PROVIDER_LABEL_OVERRIDES: Record<string, string> = {
  "openai-codex": "OpenAI Codex (OAuth)",
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Google Gemini CLI",
  "google-antigravity": "Google Antigravity",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  groq: "Groq",
  minimax: "MiniMax",
  google: "Google Gemini",
  mistral: "Mistral",
  xai: "xAI",
};

const DEFAULT_PI_PROVIDER_HINTS = [
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
  "openai",
  "anthropic",
  "openrouter",
  "groq",
  "minimax",
  "google",
  "mistral",
  "xai",
];

const STRICT_PI_ENDPOINT_MAPPING_RULES: Array<{ providerId: string; markers: string[] }> = [
  {
    providerId: "openai",
    markers: ["api.openai.com"],
  },
  {
    providerId: "anthropic",
    markers: ["api.anthropic.com", "anthropic.com", "claude.ai"],
  },
  {
    providerId: "openrouter",
    markers: ["openrouter.ai"],
  },
  {
    providerId: "groq",
    markers: ["api.groq.com", "groq.com"],
  },
  {
    providerId: "minimax",
    markers: ["minimax"],
  },
  {
    providerId: "google",
    markers: ["generativelanguage.googleapis.com", "ai.google.dev"],
  },
  {
    providerId: "mistral",
    markers: ["api.mistral.ai", "mistral.ai"],
  },
  {
    providerId: "xai",
    markers: ["api.x.ai", "x.ai"],
  },
];

export type StudioPiAuthMigrationSkipReason =
  | "missing_api_key"
  | "unmapped_endpoint"
  | "duplicate_provider_mapping";

export type StudioPiAuthMigrationSkip = {
  source: string;
  reason: StudioPiAuthMigrationSkipReason;
  providerId?: string;
};

export type StudioPiAuthMigrationCandidateSet = {
  candidates: StudioPiApiKeyMigrationCandidate[];
  skipped: StudioPiAuthMigrationSkip[];
};

function normalizeProviderId(value: string): string {
  return normalizeStudioPiProviderId(value);
}

function normalizeEndpoint(endpoint: string): string {
  return String(endpoint || "").trim().toLowerCase().replace(/\/+$/, "");
}

function resolvePiProviderFromEndpoint(endpoint: string): string | null {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) {
    return null;
  }

  for (const rule of STRICT_PI_ENDPOINT_MAPPING_RULES) {
    if (rule.markers.some((marker) => normalized.includes(marker))) {
      return rule.providerId;
    }
  }
  return null;
}

function formatPiProviderLabel(record: StudioPiProviderAuthRecord): string {
  const normalized = normalizeProviderId(record.provider);
  if (record.displayName?.trim()) {
    return record.displayName.trim();
  }
  if (PI_PROVIDER_LABEL_OVERRIDES[normalized]) {
    return PI_PROVIDER_LABEL_OVERRIDES[normalized];
  }
  return normalized || "Unknown provider";
}

function summarizePiAuthRecord(record: StudioPiProviderAuthRecord): string {
  if (record.source === "oauth") {
    if (record.oauthExpiresAt && Number.isFinite(record.oauthExpiresAt)) {
      const date = new Date(record.oauthExpiresAt);
      if (!Number.isNaN(date.getTime())) {
        return `OAuth token stored in auth.json. Expires ${date.toLocaleString()}.`;
      }
    }
    return "OAuth token stored in auth.json.";
  }
  if (record.source === "api_key") {
    return "API key stored in auth.json.";
  }
  if (record.source === "environment_or_fallback") {
    return "Credentials resolved from environment or fallback config.";
  }
  return "No credentials configured yet.";
}

function hasStoredPiCredential(record: StudioPiProviderAuthRecord): boolean {
  return hasAuthenticatedStudioPiProvider(record);
}

export function compareStudioPiAuthRecords(left: StudioPiProviderAuthRecord, right: StudioPiProviderAuthRecord): number {
  const leftHasStoredCredential = hasStoredPiCredential(left);
  const rightHasStoredCredential = hasStoredPiCredential(right);
  if (leftHasStoredCredential !== rightHasStoredCredential) {
    return leftHasStoredCredential ? -1 : 1;
  }

  if (left.hasAnyAuth !== right.hasAnyAuth) {
    return left.hasAnyAuth ? -1 : 1;
  }

  return formatPiProviderLabel(left).localeCompare(formatPiProviderLabel(right));
}

function getPiApiKeyButtonText(record: StudioPiProviderAuthRecord): string {
  return record.credentialType === "api_key" ? "API key ✓" : "Set API key";
}

function getPiApiKeyButtonTooltip(record: StudioPiProviderAuthRecord): string {
  if (record.credentialType === "api_key") {
    return `API key saved for ${record.provider}. Click to replace it.`;
  }
  return `Save API key for ${record.provider}`;
}

function getPiOAuthButtonText(record: StudioPiProviderAuthRecord): string {
  if (!record.supportsOAuth) {
    return "OAuth n/a";
  }
  return record.credentialType === "oauth" ? "OAuth ✓" : "OAuth login";
}

function getPiOAuthButtonTooltip(record: StudioPiProviderAuthRecord): string {
  if (!record.supportsOAuth) {
    return "Provider is API-key only";
  }
  if (record.credentialType === "oauth") {
    return `OAuth already configured for ${record.provider}. Click to refresh login.`;
  }
  return `Run OAuth login for ${record.provider}`;
}

function summarizeMigrationRollup(migrated: number, skipped: number, errors: number): string {
  const parts = [`migrated ${migrated}`];
  if (skipped > 0) {
    parts.push(`skipped ${skipped}`);
  }
  if (errors > 0) {
    parts.push(`errors ${errors}`);
  }
  return parts.join(", ");
}

function summarizeMigrationSkip(entry: StudioPiApiKeyMigrationEntry): string {
  if (entry.reason === "existing_oauth") {
    return "existing OAuth credentials";
  }
  if (entry.reason === "existing_api_key") {
    return "existing API key credentials";
  }
  if (entry.reason === "existing_stored_credential") {
    return "existing stored credentials";
  }
  if (entry.reason === "invalid_provider") {
    return "invalid provider";
  }
  if (entry.reason === "empty_key") {
    return "empty API key";
  }
  return entry.reason || "skipped";
}

export function deriveStudioPiMigrationCandidates(
  providers: CustomProvider[],
  legacyOpenAiApiKey: string
): StudioPiAuthMigrationCandidateSet {
  const candidates: StudioPiApiKeyMigrationCandidate[] = [];
  const skipped: StudioPiAuthMigrationSkip[] = [];
  const seenProviders = new Set<string>();

  for (const provider of providers) {
    const apiKey = String(provider.apiKey || "").trim();
    const source = `custom-provider:${provider.id || provider.name || "<unknown>"}`;
    if (!apiKey) {
      skipped.push({
        source,
        reason: "missing_api_key",
      });
      continue;
    }
    const mappedProvider = resolvePiProviderFromEndpoint(provider.endpoint || "");
    if (!mappedProvider) {
      skipped.push({
        source,
        reason: "unmapped_endpoint",
      });
      continue;
    }
    if (seenProviders.has(mappedProvider)) {
      skipped.push({
        source,
        reason: "duplicate_provider_mapping",
        providerId: mappedProvider,
      });
      continue;
    }
    seenProviders.add(mappedProvider);
    candidates.push({
      providerId: mappedProvider,
      apiKey,
      origin: source,
    });
  }

  const normalizedLegacyOpenAiApiKey = String(legacyOpenAiApiKey || "").trim();
  if (normalizedLegacyOpenAiApiKey) {
    if (!seenProviders.has("openai")) {
      candidates.push({
        providerId: "openai",
        apiKey: normalizedLegacyOpenAiApiKey,
        origin: "legacy:openAiApiKey",
      });
    } else {
      skipped.push({
        source: "legacy:openAiApiKey",
        reason: "duplicate_provider_mapping",
        providerId: "openai",
      });
    }
  }

  return {
    candidates,
    skipped,
  };
}

type ButtonVariant = "primary" | "secondary";

function styleSettingButton(button: ButtonComponent, variant: ButtonVariant, label: string): void {
  const buttonEl = button.buttonEl;
  buttonEl.classList.remove("mod-cta");
  buttonEl.classList.remove("mod-cta-outline");
  buttonEl.classList.remove("mod-warning");
  buttonEl.classList.remove("ss-button--primary");
  buttonEl.classList.remove("ss-button--secondary");
  buttonEl.classList.add("ss-button");
  buttonEl.classList.add(variant === "primary" ? "ss-button--primary" : "ss-button--secondary");
  buttonEl.dataset.ssIdleLabel = label;
  button.setButtonText(label);
}

interface ButtonLoadingOptions {
  idleText?: string;
  loadingText: string;
}

async function withButtonLoadingState<T>(
  button: ButtonComponent,
  options: ButtonLoadingOptions,
  action: () => Promise<T>
): Promise<T> {
  const buttonEl = button.buttonEl;

  if (!buttonEl.dataset.ssIdleLabel) {
    buttonEl.dataset.ssIdleLabel = buttonEl.textContent?.trim() || "";
  }

  const idleText = options.idleText ?? buttonEl.dataset.ssIdleLabel ?? "";

  if (!buttonEl.classList.contains("ss-button")) {
    styleSettingButton(button, "primary", idleText || buttonEl.textContent?.trim() || "");
  }
  const previousMinWidth = buttonEl.style.minWidth;
  if (!previousMinWidth) {
    const width = buttonEl.getBoundingClientRect().width;
    if (width > 0) {
      buttonEl.style.minWidth = `${width}px`;
    }
  }

  button.setDisabled(true);
  button.setButtonText(options.loadingText);
  buttonEl.classList.add("ss-loading");

  try {
    return await action();
  } finally {
    buttonEl.classList.remove("ss-loading");
    button.setDisabled(false);
    button.setButtonText(buttonEl.dataset.ssIdleLabel || idleText);
    if (previousMinWidth) {
      buttonEl.style.minWidth = previousMinWidth;
    } else {
      buttonEl.style.removeProperty("min-width");
    }
  }
}

export function displaySetupTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab, isProActive: boolean) {
  containerEl.empty();
  if (containerEl.classList.contains('systemsculpt-tab-content')) {
    containerEl.dataset.tab = "setup";
  }

  renderAccountSection(containerEl, tabInstance, isProActive);
  renderLocalPiAuthSection(containerEl, tabInstance);
  renderProvidersSection(containerEl, tabInstance);
  renderSupportSection(containerEl, tabInstance, isProActive);
}

function renderAccountSection(root: HTMLElement, tabInstance: SystemSculptSettingTab, isProActive: boolean) {
  root.createEl('h3', { text: 'Account & License' });

  const { plugin } = tabInstance;
  const userStatus = checkPremiumUserStatus(plugin.settings);

  const statusSetting = new Setting(root)
    .setName('SystemSculpt account')
    .setDesc(isProActive ? (userStatus.greeting || 'Pro features enabled.') : 'Activate a license to unlock SystemSculpt hosted models.');

  if (!isProActive) {
    statusSetting.addButton((button) => {
      button
        .setButtonText('View plans')
        .setCta()
        .onClick(() => window.open(SYSTEMSCULPT_WEBSITE.LIFETIME, '_blank'));
    });
  } else {
    statusSetting.addExtraButton((button) => {
      button
        .setIcon('external-link')
        .setTooltip('Manage subscription')
        .onClick(() => window.open(SYSTEMSCULPT_WEBSITE.LICENSE, '_blank'));
    });
  }

  const licenseSetting = new Setting(root)
    .setName('License key')
    .setDesc(isProActive ? 'License validated.' : 'Paste your license key to enable SystemSculpt Pro.');

  let licenseInput: TextComponent | null = null;
  licenseSetting.addText((text) => {
    licenseInput = text;
    text
      .setPlaceholder('skss-...')
      .setValue(plugin.settings.licenseKey || '')
      .onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({ licenseKey: value });
      });
    text.inputEl.type = 'password';
    tabInstance.registerListener(text.inputEl, 'focus', () => {
      text.inputEl.type = 'text';
    });
    tabInstance.registerListener(text.inputEl, 'blur', () => {
      text.inputEl.type = 'password';
    });
  });

  licenseSetting.addButton((button) => {
    button.setButtonText(isProActive ? 'Deactivate' : 'Activate');
    if (!isProActive) {
      button.setCta();
    }

    button.onClick(async () => {
        if (!licenseInput) return;
        const currentValue = (licenseInput.getValue() || '').trim();

        try {
          button.setDisabled(true);
          button.setButtonText('Working...');

          if (isProActive) {
            await plugin.getSettingsManager().updateSettings({
              licenseValid: false,
              enableSystemSculptProvider: false,
              useSystemSculptAsFallback: false
            });
            new Notice('License deactivated.');
            tabInstance.display();
            return;
          }

          if (!currentValue) {
            new Notice('Please enter a license key first.');
            return;
          }

          await plugin.getSettingsManager().updateSettings({ licenseKey: currentValue });
          const validatingNotice = new Notice('Validating license key...', 0);
          try {
            const success = await plugin.getLicenseManager().validateLicenseKey(true, false);
            validatingNotice.hide();
            if (success) {
              try {
                plugin.customProviderService.clearCache();
              } catch (_) {
              }
              try {
                await plugin.modelService.refreshModels();
              } catch (_) {
              }
              new Notice('License activated successfully.');
              tabInstance.display();
            } else {
              new Notice('Invalid license key. Please check and try again.');
            }
          } catch (error: any) {
            validatingNotice.hide();
            new Notice(`License validation failed: ${error?.message || error}`);
          }
        } finally {
          button.setDisabled(false);
          button.setButtonText(isProActive ? 'Deactivate' : 'Activate');
        }
      });
  });

  if (isProActive && (plugin.settings.licenseKey || '').length > 0) {
    licenseSetting.addExtraButton((button) => {
      button
        .setIcon('copy')
        .setTooltip('Copy license key')
        .onClick(async () => {
          if (!plugin.settings.licenseKey) return;
          await navigator.clipboard.writeText(plugin.settings.licenseKey);
          new Notice('License key copied to clipboard.');
        });
    });
  }

  if (isProActive && (plugin.settings.licenseKey || '').trim().length > 0) {
    const creditsSetting = new Setting(root)
      .setName('Credits')
      .setDesc('Fetching credits balance…');

    const aiService = SystemSculptService.getInstance(plugin);

    const formatCredits = (value: number): string => {
      try {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
      } catch {
        return String(value);
      }
    };

    const formatDate = (iso: string): string => {
      if (!iso) return 'unknown';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return 'unknown';
      try {
        return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
      } catch {
        return date.toISOString().slice(0, 10);
      }
    };

    const formatUsd = (cents: number): string => {
      const normalizedCents = Number.isFinite(cents) ? Math.max(0, Math.floor(cents)) : 0;
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(normalizedCents / 100);
      } catch {
        return `$${(normalizedCents / 100).toFixed(2)}`;
      }
    };

    let purchaseUrl: string | null = null;
    let annualUpgradeOffer: { amountSavedCents: number; percentSaved: number; checkoutUrl: string } | null = null;
    let refreshAnnualUpgradeButton: (() => void) | null = null;

    const syncCredits = async () => {
      try {
        creditsSetting.setDesc('Fetching credits balance…');
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
          ? ` Switch to annual to save ${formatUsd(annualUpgradeOffer.amountSavedCents)} per year${annualUpgradeOffer.percentSaved > 0 ? ` (${annualUpgradeOffer.percentSaved}%)` : ''}.`
          : '';
        creditsSetting.setDesc(
          `Remaining: ${formatCredits(balance.totalRemaining)} credits (Included ${formatCredits(balance.includedRemaining)}/${formatCredits(balance.includedPerMonth)}, Add-on ${formatCredits(balance.addOnRemaining)}). Resets ${formatDate(balance.cycleEndsAt)}.${annualSavingsSuffix}`
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
      button
        .setButtonText('Details')
        .onClick(async () => {
          await plugin.openCreditsBalanceModal({
            settingsTab: "overview",
          });
        });
    });

    creditsSetting.addButton((button) => {
      button
        .setButtonText('Refresh')
        .onClick(async () => {
          await syncCredits();
        });
    });

    creditsSetting.addButton((button) => {
      const applyState = () => {
        const enabled = !!annualUpgradeOffer?.checkoutUrl;
        button.buttonEl.style.display = enabled ? '' : 'none';
        button.setDisabled(!enabled);
        if (enabled && annualUpgradeOffer) {
          button.setTooltip(`Save ${formatUsd(annualUpgradeOffer.amountSavedCents)} per year`);
        } else {
          button.setTooltip('Available for monthly subscriptions');
        }
      };
      refreshAnnualUpgradeButton = applyState;
      button
        .setButtonText('Switch to annual')
        .onClick(() => {
          if (!annualUpgradeOffer?.checkoutUrl) {
            new Notice('Annual upgrade offer is currently unavailable for this account.');
            return;
          }
          window.open(annualUpgradeOffer.checkoutUrl, '_blank');
        });
      applyState();
    });

    creditsSetting.addExtraButton((button) => {
      button
        .setIcon('external-link')
        .setTooltip('Buy more credits')
        .onClick(() => {
          window.open(purchaseUrl || SYSTEMSCULPT_WEBSITE.LICENSE, '_blank');
        });
    });

    void syncCredits();
  }
}

let studioPiMigrationInFlight = false;

async function maybeRunStudioPiAuthMigration(tabInstance: SystemSculptSettingTab): Promise<void> {
  const currentVersion = Number(tabInstance.plugin.settings.studioPiAuthMigrationVersion || 0);
  if (currentVersion >= STUDIO_PI_AUTH_MIGRATION_VERSION || studioPiMigrationInFlight) {
    return;
  }

  studioPiMigrationInFlight = true;
  try {
    const migrationInput = deriveStudioPiMigrationCandidates(
      tabInstance.plugin.settings.customProviders || [],
      tabInstance.plugin.settings.openAiApiKey || ""
    );

    const report = await migrateStudioPiProviderApiKeys(migrationInput.candidates);
    const skippedBecauseInput = migrationInput.skipped.length;
    const skippedBecauseStorage = report.skipped.length;
    const totalSkipped = skippedBecauseInput + skippedBecauseStorage;
    const totalErrors = report.errors.length;

    await tabInstance.plugin.getSettingsManager().updateSettings({
      studioPiAuthMigrationVersion: STUDIO_PI_AUTH_MIGRATION_VERSION,
    });

    if (report.migrated.length > 0 || totalSkipped > 0 || totalErrors > 0) {
      new Notice(
        `Local Pi auth migration complete: ${summarizeMigrationRollup(
          report.migrated.length,
          totalSkipped,
          totalErrors
        )}.`,
        6000
      );
    }

    if (report.skipped.length > 0) {
      const preview = report.skipped
        .slice(0, 3)
        .map((entry) => `${entry.provider} (${summarizeMigrationSkip(entry)})`)
        .join(", ");
      if (preview) {
        new Notice(`Pi auth migration skipped: ${preview}${report.skipped.length > 3 ? ", …" : ""}`, 6000);
      }
    }

    if (migrationInput.skipped.length > 0) {
      const mappedPreview = migrationInput.skipped
        .slice(0, 3)
        .map((entry) => {
          if (entry.reason === "unmapped_endpoint") return `${entry.source} (unmapped endpoint)`;
          if (entry.reason === "missing_api_key") return `${entry.source} (missing API key)`;
          return `${entry.source} (${entry.providerId || "duplicate"})`;
        })
        .join(", ");
      if (mappedPreview) {
        new Notice(
          `Pi auth migration inputs skipped: ${mappedPreview}${migrationInput.skipped.length > 3 ? ", …" : ""}`,
          6000
        );
      }
    }

    if (report.errors.length > 0) {
      const firstError = report.errors[0];
      new Notice(
        `Pi auth migration error for ${firstError.provider}: ${firstError.message || "unknown error"}`,
        7000
      );
    }
  } finally {
    studioPiMigrationInFlight = false;
  }
}

function collectPiProviderHints(customProviders: CustomProvider[]): string[] {
  const hintSet = new Set<string>(DEFAULT_PI_PROVIDER_HINTS);
  for (const customProvider of customProviders) {
    const mapped = resolvePiProviderFromEndpoint(customProvider.endpoint || "");
    if (mapped) {
      hintSet.add(mapped);
    }
  }
  return Array.from(hintSet.values());
}

function renderLocalPiAuthSection(root: HTMLElement, tabInstance: SystemSculptSettingTab): void {
  root.createEl("h3", { text: "Local Pi Auth" });

  const summarySetting = new Setting(root)
    .setName("Pi-first authentication")
    .setDesc("Manage Local Pi OAuth and API keys proactively. Credentials stay local in ~/.pi/agent/auth.json.");

  const recordsRoot = root.createDiv({ cls: "ss-setup-pi-auth-list" });

  const refreshRecords = async () => {
    summarySetting.setDesc("Loading Local Pi auth providers…");
    recordsRoot.empty();

    try {
      await maybeRunStudioPiAuthMigration(tabInstance);

      const providerHints = collectPiProviderHints(tabInstance.plugin.settings.customProviders || []);
      const records = await listStudioPiProviderAuthRecords({ providerHints });
      for (const oauthOnlyProvider of KNOWN_PI_OAUTH_PROVIDER_IDS.values()) {
        if (!records.some((record) => normalizeProviderId(record.provider) === oauthOnlyProvider)) {
          records.push({
            provider: oauthOnlyProvider,
            supportsOAuth: true,
            hasAnyAuth: false,
            hasStoredCredential: false,
            source: "none",
            credentialType: "none",
            oauthExpiresAt: null,
          });
        }
      }

      if (records.length === 0) {
        summarySetting.setDesc("No Local Pi providers detected yet. Add credentials below or run `pi --list-models` once.");
        return;
      }

      records.sort(compareStudioPiAuthRecords);
      summarySetting.setDesc(
        `${records.length} provider${records.length === 1 ? "" : "s"} available. Secrets are never shown here.`
      );

      for (const record of records) {
        const setting = new Setting(recordsRoot)
          .setName(formatPiProviderLabel(record))
          .setDesc(summarizePiAuthRecord(record));
        setting.settingEl.classList.add("ss-setup-pi-auth-row");
        if (hasStoredPiCredential(record)) {
          setting.settingEl.classList.add("is-authenticated");
        }

        setting.addButton((button) => {
          button
            .setButtonText(getPiApiKeyButtonText(record))
            .setTooltip(getPiApiKeyButtonTooltip(record))
            .onClick(async () => {
              const actionLabel = record.credentialType === "api_key" ? "Update" : "Set";
              const rawValue = window.prompt(
                `${actionLabel} API key for ${formatPiProviderLabel(record)} (${record.provider}):`,
                ""
              );
              if (rawValue === null) {
                return;
              }
              const apiKey = String(rawValue || "").trim();
              if (!apiKey) {
                new Notice("API key cannot be empty.");
                return;
              }
              try {
                await setStudioPiProviderApiKey(record.provider, apiKey);
                new Notice(`Saved API key for ${formatPiProviderLabel(record)}.`);
                await refreshRecords();
              } catch (error: any) {
                new Notice(`Failed to save key for ${formatPiProviderLabel(record)}: ${error?.message || error}`);
              }
            });
        });

        setting.addButton((button) => {
          button
            .setButtonText(getPiOAuthButtonText(record))
            .setTooltip(getPiOAuthButtonTooltip(record))
            .setDisabled(!record.supportsOAuth)
            .onClick(async () => {
              try {
                await runSetupPiOAuthLogin({
                  app: tabInstance.app,
                  record,
                  providerLabel: formatPiProviderLabel(record),
                });
                new Notice(`OAuth login complete for ${formatPiProviderLabel(record)}.`);
                await refreshRecords();
              } catch (error: any) {
                const message = error?.message || error;
                new Notice(`Failed OAuth login for ${formatPiProviderLabel(record)}: ${message}`);
              }
            });
        });

        setting.addExtraButton((button) => {
          button
            .setIcon("trash")
            .setTooltip(`Clear stored auth for ${record.provider}`)
            .onClick(async () => {
              try {
                await clearStudioPiProviderAuth(record.provider);
                new Notice(`Cleared stored auth for ${formatPiProviderLabel(record)}.`);
                await refreshRecords();
              } catch (error: any) {
                new Notice(`Failed to clear auth for ${formatPiProviderLabel(record)}: ${error?.message || error}`);
              }
            });
        });

        setting.addExtraButton((button) => {
          button
            .setIcon("refresh-cw")
            .setTooltip(`Refresh auth state for ${record.provider}`)
            .onClick(async () => {
              await refreshRecords();
            });
        });
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      summarySetting.setDesc(`Local Pi auth is unavailable right now: ${message}`);
      recordsRoot.createEl("p", {
        text: "If Pi auth storage is unavailable in this runtime, use Studio's recovery wizard or run `pi /login <provider>` in Terminal.",
        cls: "setting-item-description",
      });
    }
  };

  summarySetting.addButton((button) => {
    button
      .setButtonText("Refresh")
      .onClick(async () => {
        await refreshRecords();
      });
  });

  void refreshRecords();
}

function renderProvidersSection(root: HTMLElement, tabInstance: SystemSculptSettingTab) {
  root.createEl('h3', { text: 'Custom Endpoint Providers (Advanced Fallback)' });

  const { plugin } = tabInstance;
  const providers: CustomProvider[] = [...(plugin.settings.customProviders || [])];
  const isAdvancedMode = plugin.settings.settingsMode === 'advanced';

  const addSetting = new Setting(root)
    .setName('Add provider')
    .setDesc('Optional advanced fallback: connect OpenAI-compatible endpoints directly when Pi auth is not the path you want.');

  addSetting.addButton((button) => {
    styleSettingButton(button, "primary", "New provider");

    button.onClick(async () => {
      const preset = await presentProviderPresetPicker(tabInstance);
      if (!preset) {
        return;
      }

      try {
        await withButtonLoadingState(button, {
          loadingText: "Opening wizard…",
        }, async () => {
          await openCustomProviderSetup(tabInstance, preset.name, preset.endpoint);
        });
      } catch (error: any) {
        new Notice(`Failed to open provider setup: ${error?.message || error}`);
      }
    });
  });

  addSetting.addButton((button) => {
    styleSettingButton(button, "secondary", "Scan local");

    button.onClick(async () => {
      try {
        await withButtonLoadingState(button, {
          loadingText: "Scanning…",
        }, async () => {
          await scanLocalProviders(tabInstance);
        });
      } catch (error: any) {
        new Notice(`Scan failed: ${error?.message || error}`);
      }
    });
  });

  if (!isAdvancedMode) {
    const summary = new Setting(root)
      .setName('Advanced management')
      .setDesc('Switch to Advanced mode to manage endpoint-level fallback providers.');
    summary.addButton((button) => {
      button
        .setButtonText('Switch to Advanced')
        .onClick(async () => {
          await plugin.getSettingsManager().updateSettings({ settingsMode: 'advanced' as any });
          tabInstance.display();
        });
    });
    return;
  }

  if (providers.length === 0) {
    root.createEl('p', {
      text: 'No endpoint fallback providers configured yet. You can still use Local Pi auth above.',
      cls: 'setting-item-description'
    });
    return;
  }

  providers.forEach((provider) => {
    const providerSetting = new Setting(root)
      .setName(provider.name || 'Custom provider')
      .setDesc(provider.endpoint || 'No endpoint configured');

    providerSetting.addToggle((toggle) => {
      toggle
        .setValue(provider.isEnabled ?? true)
        .onChange(async (value) => {
          if (!value) {
            provider.isEnabled = false;
            await saveProviders(tabInstance, provider);
            plugin.customProviderService.clearCache();
            await plugin.modelService.refreshModels();
            new Notice(`${provider.name} disabled.`);
            tabInstance.display();
            return;
          }

          const enableNotice = new Notice(`Testing ${provider.name}...`, 0);
          try {
            const result = await plugin.customProviderService.testConnection(provider, {
              force: true,
              reason: "setup-toggle",
            });
            enableNotice.hide();
            if (result.success) {
              provider.isEnabled = true;
              provider.failureCount = 0;
              delete provider.lastFailureTime;
              provider.lastTested = Date.now();
              await saveProviders(tabInstance, provider);
              plugin.customProviderService.clearCache();
              await plugin.modelService.refreshModels();
              new Notice(`${provider.name} enabled (${result.models?.length || 0} models).`);
              tabInstance.display();
            } else {
              new Notice(`Failed to enable ${provider.name}: ${result.error || 'Connection failed'}`, 6000);
              toggle.setValue(false);
            }
          } catch (error: any) {
            enableNotice.hide();
            new Notice(`Failed to enable ${provider.name}: ${error?.message || error}`);
            toggle.setValue(false);
          }
        });
    });

    providerSetting.addExtraButton((button) => {
      button
        .setIcon('refresh-cw')
        .setTooltip('Test connection')
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await plugin.customProviderService.testConnection(provider, {
              force: true,
              reason: "setup-manual-test",
            });
            provider.lastTested = Date.now();
            await saveProviders(tabInstance, provider);
            new Notice(
              result.success
                ? `✅ ${provider.name}: ${result.models?.length || 0} model(s) available.`
                : `❌ ${provider.name}: ${result.error || 'Connection failed.'}`
            );
            tabInstance.display();
          } finally {
            button.setDisabled(false);
          }
        });
    });

    providerSetting.addExtraButton((button) => {
      button
        .setIcon('settings')
        .setTooltip('Edit provider')
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await openCustomProviderSetup(tabInstance, provider.name, provider.endpoint, provider.id, provider.apiKey, provider.isEnabled);
          } finally {
            button.setDisabled(false);
          }
        });
    });

    providerSetting.addExtraButton((button) => {
      button
        .setIcon('trash')
        .setTooltip('Remove provider')
        .onClick(async () => {
          const { confirmed } = await showConfirm(
            tabInstance.app,
            `Remove '${provider.name}'?`,
            {
              title: "Remove Provider",
              primaryButton: "Remove",
              secondaryButton: "Cancel",
              icon: "trash",
            }
          );
          if (!confirmed) return;
          const updated = (plugin.settings.customProviders || []).filter((p) => p.id !== provider.id);
          await plugin.getSettingsManager().updateSettings({ customProviders: updated });
          plugin.customProviderService.clearCache();
          await plugin.modelService.refreshModels();
          new Notice(`${provider.name} removed.`);
          tabInstance.display();
        });
    });
  });
}

async function presentProviderPresetPicker(tabInstance: SystemSculptSettingTab): Promise<typeof PROVIDER_PRESETS[number] | null> {
  const items: ListItem[] = PROVIDER_PRESETS.map((preset, index) => ({
    id: `preset-${index}`,
    title: preset.name,
    description: preset.description,
    icon: preset.id === 'custom' ? 'settings' : 'network',
    metadata: preset,
  }));

  const modal = new ListSelectionModal(tabInstance.app, items, {
    title: 'Add provider',
    description: 'Choose a provider template to pre-fill the connection details.',
    withSearch: true,
    size: 'medium',
  });

  const [selection] = await modal.openAndGetSelection();
  if (!selection?.metadata) {
    return null;
  }

  return selection.metadata as typeof PROVIDER_PRESETS[number];
}

function renderSupportSection(root: HTMLElement, tabInstance: SystemSculptSettingTab, isProActive: boolean) {
  root.createEl('h3', { text: 'Help & resources' });

  const linksSetting = new Setting(root)
    .setName('Documentation')
    .setDesc('Guides, troubleshooting, and ways to contact support.');

  const linkContainer = linksSetting.controlEl.createDiv({ cls: 'ss-help-links' });
  createExternalHelpLink(linkContainer, {
    text: 'Docs',
    href: SYSTEMSCULPT_WEBSITE.DOCS,
    ariaLabel: 'Open the SystemSculpt documentation (opens in new tab)'
  });

  linkContainer.createSpan({ text: '•', cls: 'ss-help-separator' });
  createExternalHelpLink(linkContainer, {
    text: 'Support',
    href: SYSTEMSCULPT_WEBSITE.SUPPORT,
    ariaLabel: 'Contact SystemSculpt support (opens in new tab)'
  });

  linkContainer.createSpan({ text: '•', cls: 'ss-help-separator' });
  createExternalHelpLink(linkContainer, {
    text: 'Report an issue',
    href: SYSTEMSCULPT_WEBSITE.FEEDBACK,
    ariaLabel: 'Open the feedback form on GitHub (opens in new tab)'
  });

  const releaseSetting = new Setting(root)
    .setName('Release notes')
    .setDesc('See what changed in the latest release and the roadmap.');

  releaseSetting.addButton((button) => {
    button
      .setButtonText('View changelog')
      .onClick(() => window.open(`${SYSTEMSCULPT_WEBSITE.BASE_URL}/changelog`, '_blank'));
  });
}

async function scanLocalProviders(tabInstance: SystemSculptSettingTab) {
  try {
    const options = await scanLocalLLMProviders();
    if (!options || options.length === 0) {
      new Notice('No local providers detected on the default ports.');
      return;
    }

    const items: ListItem[] = options.map((opt, index) => ({
      id: `local-${index}`,
      title: opt.label,
      description: `${opt.endpoint} • ${opt.models.length} model${opt.models.length === 1 ? '' : 's'}`,
      icon: opt.type === 'ollama' ? 'layers' : 'cpu',
      metadata: { index }
    }));

    const modal = new ListSelectionModal(tabInstance.app, items, {
      title: 'Local providers',
      description: 'Choose local endpoints to add or enable.',
      withSearch: false,
      multiSelect: true,
      size: 'medium'
    });

    const selection = await modal.openAndGetSelection();
    if (!selection || selection.length === 0) return;

    const chosenIndexes = new Set(selection.map((item) => (item.metadata?.index as number) ?? -1));
    const chosen = options.filter((_, idx) => chosenIndexes.has(idx));

    const existing: CustomProvider[] = tabInstance.plugin.settings.customProviders || [];
    const updated: CustomProvider[] = [...existing];

    for (const opt of chosen) {
      const baseName = opt.type === 'ollama' ? 'Ollama' : 'LM Studio';
      const normalizedEndpoint = (opt.endpoint || '').replace(/\/$/, '');
      const already = updated.find((p) => (p.endpoint || '').replace(/\/$/, '') === normalizedEndpoint);
      if (already) {
        already.isEnabled = true;
        continue;
      }
      const newProvider: CustomProvider = {
        id: `local-${baseName.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: baseName,
        endpoint: opt.endpoint,
        apiKey: '',
        isEnabled: true
      };
      updated.push(newProvider);
    }

    await tabInstance.plugin.getSettingsManager().updateSettings({ customProviders: updated });
    tabInstance.plugin.customProviderService.clearCache();
    await tabInstance.plugin.modelService.refreshModels();
    new Notice(`Added or enabled ${chosen.length} local provider${chosen.length === 1 ? '' : 's'}.`);
    tabInstance.display();
  } catch (error: any) {
    new Notice(`Scan failed: ${error?.message || error}`);
  }
}

async function saveProviders(tabInstance: SystemSculptSettingTab, provider: CustomProvider) {
  const providers: CustomProvider[] = [...(tabInstance.plugin.settings.customProviders || [])];
  const updated = providers.map((p) => (p.id === provider.id ? provider : p));
  await tabInstance.plugin.getSettingsManager().updateSettings({ customProviders: updated });
}

async function openCustomProviderSetup(
  tabInstance: SystemSculptSettingTab,
  name: string,
  endpoint: string,
  existingId?: string,
  apiKey?: string,
  isEnabled?: boolean
): Promise<boolean> {
  const { app, plugin } = tabInstance;
  const provider = await showCustomProviderModal(app, plugin, {
    name,
    endpoint,
    existingId,
    apiKey,
    isEnabled: existingId ? isEnabled : true
  });

  if (!provider) {
    return false;
  }

  let updatedProviders = [...(plugin.settings.customProviders || [])];
  if (existingId) {
    updatedProviders = updatedProviders.map((p) => (p.id === existingId ? provider : p));
  } else {
    updatedProviders.push(provider);
  }

  await plugin.getSettingsManager().updateSettings({ customProviders: updatedProviders });

  if (provider.isEnabled) {
    try {
      plugin.customProviderService.clearCache();
      await plugin.modelService.refreshModels();
      new Notice(`✅ ${provider.name} is ready and models have been loaded.`);
    } catch (error) {
      new Notice(`⚠️ ${provider.name} added but model refresh failed. Check credentials and connection.`);
    }
  } else {
    new Notice(`${existingId ? 'Updated' : 'Added'} ${provider.name}.`);
  }

  tabInstance.display();
  return true;
}
