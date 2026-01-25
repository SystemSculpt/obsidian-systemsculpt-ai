import { App, Setting, TextAreaComponent, Notice, ToggleComponent } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { SystemPromptService } from "../services/SystemPromptService";
import { FavoritesService } from "../services/FavoritesService";
import { SystemSculptModel } from "../types/llm";
import { StandardModelSelectionModal } from "../modals/StandardModelSelectionModal";
import { StandardSystemPromptSelectionModal } from "../modals/StandardSystemPromptSelectionModal";
import { ensureCanonicalId } from "../utils/modelUtils";
async function getCurrentDefaultPresetDisplayName(plugin: SystemSculptPlugin, app: App): Promise<string> {
    const type = plugin.settings.systemPromptType;
    const path = plugin.settings.systemPromptPath;

    if (type === 'general-use') return "General Use Preset";
    if (type === 'concise') return "Concise Preset";
    if (type === 'agent') return "Vault Agent Preset";
    if (type === 'custom') {
        if (path) {
            try {
                const spService = SystemPromptService.getInstance(app, () => plugin.settings);
                // Check if the custom file still exists
                const file = app.vault.getAbstractFileByPath(path);
                if (!file) {
                    // File doesn't exist, fall back to general-use
                    await plugin.getSettingsManager().updateSettings({
                        systemPromptType: 'general-use',
                        systemPromptPath: ''
                    });
                    return "General Use Preset (auto-switched from missing custom file)";
                }
                
                // File exists, return its name
                const fileName = path.split('/').pop() || path;
                return `Custom Preset File: ${fileName}`;
            } catch (error) {
                // On error, fall back to general-use
                await plugin.getSettingsManager().updateSettings({
                    systemPromptType: 'general-use',
                    systemPromptPath: ''
                });
                return "General Use Preset (auto-switched due to custom file error)";
            }
        } else {
            return "Custom (Manually Entered Text)";
        }
    }
    
    // Handle invalid/unknown system prompt types
    const validDefaultTypes = ['general-use', 'concise', 'agent', 'custom'];
    if (!validDefaultTypes.includes(type as string)) {
        // Unknown or invalid type, fall back to general-use
        await plugin.getSettingsManager().updateSettings({
            systemPromptType: 'general-use',
            systemPromptPath: ''
        });
        return "General Use Preset (auto-switched from invalid type)";
    }
    
    // This should never be reached, but keeping as final fallback
    return "General Use Preset";
}

function formatPromptSelection(result: { type: string; path?: string }): string {
    switch (result.type) {
        case 'general-use':
            return 'General use';
        case 'concise':
            return 'Concise';
        case 'agent':
            return 'Agent mode';
        case 'custom':
            if (result.path) {
                const fileName = result.path.split('/').pop() || result.path;
                return `Custom: ${fileName}`;
            }
            return 'Custom text';
        default:
            return result.type;
    }
}

export async function displayChatTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty();
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "chat";
    }
    const { app, plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Chat settings" });

    containerEl.createEl('p', {
        text: 'Tip: adjust models and prompts in the “Models & Prompts” tab.',
        cls: 'setting-item-description'
    });

    const presetLabel = await getCurrentDefaultPresetDisplayName(plugin, app);
    const promptSetting = new Setting(containerEl)
        .setName('Default system prompt')
        .setDesc(presetLabel);

    promptSetting.addButton((button) => {
        button
            .setButtonText('Change...')
            .onClick(() => {
                const modal = new StandardSystemPromptSelectionModal({
                    app,
                    plugin,
                    currentType: plugin.settings.systemPromptType || 'general-use',
                    currentPath: plugin.settings.systemPromptPath,
                    title: 'Select default system prompt',
                    description: 'Choose the default system prompt for new chat conversations.',
                    onSelect: async (result) => {
                        try {
                            const updates: Record<string, unknown> = {
                                systemPromptType: result.type
                            };

                            if (result.type === 'custom' && result.path) {
                                updates.systemPromptPath = result.path;
                            } else {
                                updates.systemPromptPath = '';
                            }

                            if (result.type === 'custom' && !result.path && result.prompt) {
                                updates.systemPrompt = result.prompt;
                            }

                            await plugin.getSettingsManager().updateSettings(updates);
                            plugin.emitter?.emit?.('settingsChanged');

                            const displayName = formatPromptSelection(result);
                            new Notice(`Default system prompt set to ${displayName}.`, 3000);
                            tabInstance.display();
                        } catch (error) {
                            new Notice('Failed to update default system prompt. Please try again.', 4000);
                        }
                    }
                });

                modal.open();
            });
    });

    if (plugin.settings.systemPromptType === 'custom' && !plugin.settings.systemPromptPath) {
        new Setting(containerEl)
            .setName('Custom prompt text')
            .setDesc('Used when the default prompt is set to custom text.')
            .addTextArea((text: TextAreaComponent) => {
                text
                    .setValue(plugin.settings.systemPrompt)
                    .setPlaceholder('Enter your custom default system prompt here...')
                    .onChange(async (value) => {
                        await plugin.getSettingsManager().updateSettings({ systemPrompt: value });
                    });
                text.inputEl.rows = 6;
            });
    }

// --- Default Chat Font Size ---
new Setting(containerEl)
    .setName("Default Chat Font Size")
    .setDesc("Select the default text size for new chat messages.")
    .addDropdown(dropdown => {
        dropdown
            .addOption("small", "Small")
            .addOption("medium", "Medium")
            .addOption("large", "Large")
            .setValue(plugin.settings.chatFontSize || "medium")
            .onChange(async (value: string) => {
                await plugin.getSettingsManager().updateSettings({ chatFontSize: value as any });
                new Notice(`Default chat font size set to: ${value}`);
            });
	    });

// --- Reduced Motion Preference ---
new Setting(containerEl)
    .setName("Honor OS Reduced Motion")
    .setDesc("When enabled, SystemSculpt animations/transitions are minimized if your system prefers reduced motion. Disable if you want full animations.")
    .addToggle((toggle: ToggleComponent) => {
        toggle
            .setValue(plugin.settings.respectReducedMotion ?? true)
            .onChange(async (value) => {
                await plugin.getSettingsManager().updateSettings({ respectReducedMotion: value });
                new Notice(`Honor OS reduced motion ${value ? 'enabled' : 'disabled'}.`);
            });
    });

// --- Agent Mode safety ---
containerEl.createEl("h3", { text: "Agent Mode safety" });

new Setting(containerEl)
    .setName("Require approval for destructive tools")
    .setDesc("When enabled, write/edit/move/trash tool calls require confirmation. External MCP tools always require approval.")
    .addToggle((toggle: ToggleComponent) => {
        toggle
            .setValue(plugin.settings.toolingRequireApprovalForDestructiveTools ?? true)
            .onChange(async (value) => {
                if (!value) {
                    const confirmDisable = confirm("Disable confirmations for destructive Agent Mode tools? This lets tools edit or delete notes without asking.");
                    if (!confirmDisable) {
                        toggle.setValue(true);
                        return;
                    }
                }
                await plugin.getSettingsManager().updateSettings({ toolingRequireApprovalForDestructiveTools: value });
                new Notice(`Destructive tool confirmations ${value ? 'enabled' : 'disabled'}.`);
            });
    });

new Setting(containerEl)
    .setName("Auto-approve tool list")
    .setDesc("Optional allowlist for mutating tools that can run without confirmation. One tool per line (e.g., mcp-filesystem:write or mcp-filesystem_write).")
    .addTextArea((text: TextAreaComponent) => {
        const current = (plugin.settings.mcpAutoAcceptTools || []).join("\n");
        text
            .setValue(current)
            .setPlaceholder("mcp-filesystem:write\nmcp-filesystem:edit")
            .onChange(async (value) => {
                const normalized = value
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);
                await plugin.getSettingsManager().updateSettings({ mcpAutoAcceptTools: normalized });
            });
        text.inputEl.rows = 4;
    });

// --- Favorites Management Section ---
containerEl.createEl("h3", { text: "Favorites" });

const favoritesService = FavoritesService.getInstance(plugin);
const favoritesSetting = new Setting(containerEl)
  .setName("Favorite models")
  .setDesc("Star models to pin them in pickers and quick lists.");

const favoritesSummaryEl = favoritesSetting.descEl.createDiv({ cls: "ss-inline-note" });

const refreshFavoritesSummary = async () => {
  favoritesSummaryEl.setText(await buildFavoritesSummary(plugin));
};

await refreshFavoritesSummary();

favoritesSetting.addButton((button) => {
  button
    .setButtonText("Manage…")
    .onClick(() => {
      const modal = new StandardModelSelectionModal({
        app,
        plugin,
        currentModelId: plugin.settings.selectedModelId || "",
        title: "Manage favorite models",
        description: "Star models to add or remove favorites.",
        onSelect: () => {}
      });

      void modal.open().finally(() => {
        void refreshFavoritesSummary();
      });
    });
});

favoritesSetting.addExtraButton((button) => {
  button
    .setIcon("trash")
    .setTooltip("Remove all favorites")
    .onClick(async () => {
      const favorites = plugin.settings.favoriteModels || [];
      if (favorites.length === 0) {
        new Notice("No favorite models to remove.");
        return;
      }

      if (!confirm("Remove all favorite models? This cannot be undone.")) {
        return;
      }

      try {
        const models = await plugin.modelService.getModels();
        await favoritesService.clearAllFavorites(models);
        new Notice("All favorite models removed.");
      } catch (error: any) {
        new Notice(`Failed to clear favorites: ${error?.message || error}`);
      } finally {
        await refreshFavoritesSummary();
      }
    });
});

}

async function buildFavoritesSummary(plugin: SystemSculptPlugin): Promise<string> {
  const favorites = plugin.settings.favoriteModels || [];
  if (!favorites.length) {
    return "No favorite models yet. Use Manage to star models.";
  }

  try {
    const models = await plugin.modelService.getModels().catch(() => [] as SystemSculptModel[]);
    const names = favorites.map((favorite) => {
      const canonicalId = ensureCanonicalId(favorite.modelId, favorite.provider);
      const match = models.find((model) => ensureCanonicalId(model.id) === canonicalId);
      if (match?.name) {
        return match.name;
      }
      const [, simpleId] = favorite.modelId.split("@@");
      return simpleId || favorite.modelId;
    }).filter(Boolean);

    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) {
      return `Favorites (${favorites.length}) saved.`;
    }

    const preview = uniqueNames.slice(0, 3).join(", ");
    if (uniqueNames.length <= 3) {
      return `Favorites: ${preview}`;
    }

    return `Favorites (${uniqueNames.length}): ${preview}, …`;
  } catch (error) {
    console.warn("Failed to summarize favorite models", error);
    return `Favorites (${favorites.length}) saved.`;
  }
}
