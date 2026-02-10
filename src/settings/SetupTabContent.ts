
import { App, Setting, Notice, setIcon, TextComponent, ButtonComponent } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showCustomProviderModal } from "../modals/CustomProviderModal";
import { checkPremiumUserStatus } from "../utils/licenseUtils";
import { AI_PROVIDERS, LOCAL_SERVICES, SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { scanLocalLLMProviders } from "../services/providers/LocalLLMScanner";
import { ListSelectionModal, ListItem } from "../core/ui/modals/standard/ListSelectionModal";
import { createExternalHelpLink } from "./uiHelpers";
import type { CustomProvider } from "../types/llm";
import { SystemSculptService } from "../services/SystemSculptService";

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

    let purchaseUrl: string | null = null;

    const syncCredits = async () => {
      try {
        creditsSetting.setDesc('Fetching credits balance…');
        const balance = await aiService.getCreditsBalance();
        purchaseUrl = balance.purchaseUrl;
        creditsSetting.setDesc(
          `Remaining: ${formatCredits(balance.totalRemaining)} credits (Included ${formatCredits(balance.includedRemaining)}/${formatCredits(balance.includedPerMonth)}, Add-on ${formatCredits(balance.addOnRemaining)}). Resets ${formatDate(balance.cycleEndsAt)}.`
        );
      } catch (error: any) {
        const message = error?.message || String(error);
        creditsSetting.setDesc(`Unable to fetch credits balance. (${message})`);
      }
    };

    creditsSetting.addButton((button) => {
      button
        .setButtonText('Refresh')
        .onClick(async () => {
          await syncCredits();
        });
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

function renderProvidersSection(root: HTMLElement, tabInstance: SystemSculptSettingTab) {
  root.createEl('h3', { text: 'Custom providers' });

  const { plugin } = tabInstance;
  const providers: CustomProvider[] = [...(plugin.settings.customProviders || [])];
  const isAdvancedMode = plugin.settings.settingsMode === 'advanced';

  const addSetting = new Setting(root)
    .setName('Add provider')
    .setDesc('Connect OpenAI, Anthropic, Groq, OpenRouter, or any OpenAI-compatible service.');

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
      .setDesc('Switch to Advanced mode to edit providers.');
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
      text: 'No custom providers configured yet. Add a provider to use your own API keys.',
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
          if (!confirm(`Remove '${provider.name}'?`)) return;
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
