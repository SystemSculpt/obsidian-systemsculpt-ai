import { Notice, Setting } from "obsidian";
import { ListSelectionModal, ListItem } from "../../core/ui/modals/standard/ListSelectionModal";
import { showConfirm } from "../../core/ui/notifications";
import { AI_PROVIDERS, LOCAL_SERVICES } from "../../constants/externalServices";
import { showCustomProviderModal } from "../../modals/CustomProviderModal";
import { scanLocalLLMProviders } from "../../services/providers/LocalLLMScanner";
import type { CustomProvider } from "../../types/llm";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";
import { styleSettingButton, withButtonLoadingState } from "./SetupTabButtonUtils";

const PROVIDER_PRESETS: Array<{ id: string; name: string; endpoint: string; description: string }> = [
  {
    id: "openai",
    name: "OpenAI",
    endpoint: AI_PROVIDERS.OPENAI.BASE_URL,
    description: "ChatGPT, GPT-4o, GPT-4.1, and latest OpenAI APIs",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    endpoint: AI_PROVIDERS.ANTHROPIC.BASE_URL,
    description: "Claude 3 family with fast and reliable reasoning",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: AI_PROVIDERS.OPENROUTER.BASE_URL,
    description: "One API for many frontier models (Meta, Mistral, Perplexity)",
  },
  {
    id: "minimax",
    name: "MiniMax",
    endpoint: AI_PROVIDERS.MINIMAX.BASE_URL,
    description: "MiniMax M-series models with OpenAI-compatible endpoints",
  },
  {
    id: "moonshot",
    name: "Kimi K2 (Moonshot)",
    endpoint: AI_PROVIDERS.MOONSHOT.BASE_URL,
    description: "Moonshot (Kimi) K2 reasoning and vision models",
  },
  {
    id: "groq",
    name: "Groq",
    endpoint: AI_PROVIDERS.GROQ.BASE_URL,
    description: "Groq LPU hosted models with ultra-low latency",
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    endpoint: LOCAL_SERVICES.OLLAMA.BASE_URL,
    description: "Run open models locally with Ollama",
  },
  {
    id: "lmstudio",
    name: "LM Studio (Local)",
    endpoint: LOCAL_SERVICES.LM_STUDIO.BASE_URL,
    description: "Connect to LM Studio on localhost",
  },
  {
    id: "custom",
    name: "Custom Provider",
    endpoint: "",
    description: "Manually configure any OpenAI-compatible endpoint",
  },
];

export function renderProvidersSection(root: HTMLElement, tabInstance: SystemSculptSettingTab): void {
  root.createEl("h3", { text: "Custom Endpoint Providers (Advanced Fallback)" });

  const { plugin } = tabInstance;
  const providers: CustomProvider[] = [...(plugin.settings.customProviders || [])];
  const isAdvancedMode = plugin.settings.settingsMode === "advanced";

  const addSetting = new Setting(root)
    .setName("Add provider")
    .setDesc("Optional advanced fallback: connect OpenAI-compatible endpoints directly when Pi auth is not the path you want.");

  addSetting.addButton((button) => {
    styleSettingButton(button, "primary", "New provider");

    button.onClick(async () => {
      const preset = await presentProviderPresetPicker(tabInstance);
      if (!preset) {
        return;
      }

      try {
        await withButtonLoadingState(
          button,
          {
            loadingText: "Opening wizard…",
          },
          async () => {
            await openCustomProviderSetup(tabInstance, preset.name, preset.endpoint);
          }
        );
      } catch (error: any) {
        new Notice(`Failed to open provider setup: ${error?.message || error}`);
      }
    });
  });

  addSetting.addButton((button) => {
    styleSettingButton(button, "secondary", "Scan local");

    button.onClick(async () => {
      try {
        await withButtonLoadingState(
          button,
          {
            loadingText: "Scanning…",
          },
          async () => {
            await scanLocalProviders(tabInstance);
          }
        );
      } catch (error: any) {
        new Notice(`Scan failed: ${error?.message || error}`);
      }
    });
  });

  if (!isAdvancedMode) {
    const summary = new Setting(root)
      .setName("Advanced management")
      .setDesc("Switch to Advanced mode to manage endpoint-level fallback providers.");
    summary.addButton((button) => {
      button.setButtonText("Switch to Advanced").onClick(async () => {
        await plugin.getSettingsManager().updateSettings({ settingsMode: "advanced" as any });
        tabInstance.display();
      });
    });
    return;
  }

  if (providers.length === 0) {
    root.createEl("p", {
      text: "No endpoint fallback providers configured yet. You can still use Local Pi auth above.",
      cls: "setting-item-description",
    });
    return;
  }

  providers.forEach((provider) => {
    const providerSetting = new Setting(root)
      .setName(provider.name || "Custom provider")
      .setDesc(provider.endpoint || "No endpoint configured");

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
              new Notice(`Failed to enable ${provider.name}: ${result.error || "Connection failed"}`, 6000);
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
        .setIcon("refresh-cw")
        .setTooltip("Test connection")
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
                : `❌ ${provider.name}: ${result.error || "Connection failed."}`
            );
            tabInstance.display();
          } finally {
            button.setDisabled(false);
          }
        });
    });

    providerSetting.addExtraButton((button) => {
      button
        .setIcon("settings")
        .setTooltip("Edit provider")
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await openCustomProviderSetup(
              tabInstance,
              provider.name,
              provider.endpoint,
              provider.id,
              provider.apiKey,
              provider.isEnabled
            );
          } finally {
            button.setDisabled(false);
          }
        });
    });

    providerSetting.addExtraButton((button) => {
      button
        .setIcon("trash")
        .setTooltip("Remove provider")
        .onClick(async () => {
          const { confirmed } = await showConfirm(tabInstance.app, `Remove '${provider.name}'?`, {
            title: "Remove Provider",
            primaryButton: "Remove",
            secondaryButton: "Cancel",
            icon: "trash",
          });
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

async function presentProviderPresetPicker(
  tabInstance: SystemSculptSettingTab
): Promise<(typeof PROVIDER_PRESETS)[number] | null> {
  const items: ListItem[] = PROVIDER_PRESETS.map((preset, index) => ({
    id: `preset-${index}`,
    title: preset.name,
    description: preset.description,
    icon: preset.id === "custom" ? "settings" : "network",
    metadata: preset,
  }));

  const modal = new ListSelectionModal(tabInstance.app, items, {
    title: "Add provider",
    description: "Choose a provider template to pre-fill the connection details.",
    withSearch: true,
    size: "medium",
  });

  const [selection] = await modal.openAndGetSelection();
  if (!selection?.metadata) {
    return null;
  }

  return selection.metadata as (typeof PROVIDER_PRESETS)[number];
}

async function scanLocalProviders(tabInstance: SystemSculptSettingTab): Promise<void> {
  try {
    const options = await scanLocalLLMProviders();
    if (!options || options.length === 0) {
      new Notice("No local providers detected on the default ports.");
      return;
    }

    const items: ListItem[] = options.map((opt, index) => ({
      id: `local-${index}`,
      title: opt.label,
      description: `${opt.endpoint} • ${opt.models.length} model${opt.models.length === 1 ? "" : "s"}`,
      icon: opt.type === "ollama" ? "layers" : "cpu",
      metadata: { index },
    }));

    const modal = new ListSelectionModal(tabInstance.app, items, {
      title: "Local providers",
      description: "Choose local endpoints to add or enable.",
      withSearch: false,
      multiSelect: true,
      size: "medium",
    });

    const selection = await modal.openAndGetSelection();
    if (!selection || selection.length === 0) return;

    const chosenIndexes = new Set(selection.map((item) => (item.metadata?.index as number) ?? -1));
    const chosen = options.filter((_, idx) => chosenIndexes.has(idx));

    const existing: CustomProvider[] = tabInstance.plugin.settings.customProviders || [];
    const updated: CustomProvider[] = [...existing];

    for (const opt of chosen) {
      const baseName = opt.type === "ollama" ? "Ollama" : "LM Studio";
      const normalizedEndpoint = (opt.endpoint || "").replace(/\/$/, "");
      const already = updated.find((p) => (p.endpoint || "").replace(/\/$/, "") === normalizedEndpoint);
      if (already) {
        already.isEnabled = true;
        continue;
      }
      const newProvider: CustomProvider = {
        id: `local-${baseName.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: baseName,
        endpoint: opt.endpoint,
        apiKey: "",
        isEnabled: true,
      };
      updated.push(newProvider);
    }

    await tabInstance.plugin.getSettingsManager().updateSettings({ customProviders: updated });
    tabInstance.plugin.customProviderService.clearCache();
    await tabInstance.plugin.modelService.refreshModels();
    new Notice(`Added or enabled ${chosen.length} local provider${chosen.length === 1 ? "" : "s"}.`);
    tabInstance.display();
  } catch (error: any) {
    new Notice(`Scan failed: ${error?.message || error}`);
  }
}

async function saveProviders(tabInstance: SystemSculptSettingTab, provider: CustomProvider): Promise<void> {
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
    isEnabled: existingId ? isEnabled : true,
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
    } catch {
      new Notice(`⚠️ ${provider.name} added but model refresh failed. Check credentials and connection.`);
    }
  } else {
    new Notice(`${existingId ? "Updated" : "Added"} ${provider.name}.`);
  }

  tabInstance.display();
  return true;
}
