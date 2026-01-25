
import { App, Setting, Notice } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { StandardSystemPromptSelectionModal } from "../modals/StandardSystemPromptSelectionModal";
import { showTitleGenerationPromptModal } from "../modals/TitleGenerationPromptModal";
import { PostProcessingPromptModal } from "../modals/PostProcessingPromptModal";

interface PromptSummary {
  text: string;
  missing?: boolean;
}

type PluginInstance = SystemSculptSettingTab["plugin"];

export async function displaySystemPromptSettingsTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains('systemsculpt-tab-content')) {
    containerEl.dataset.tab = "system-prompt-settings";
  }

  const { app, plugin } = tabInstance;

  containerEl.createEl("h3", { text: "System prompts" });
  containerEl.createEl("p", {
    text: "Choose the presets or files used for chats, title generation, and post-processing.",
    cls: "setting-item-description"
  });

  const isAdvancedMode = plugin.settings.settingsMode === 'advanced';
  const useLatestPrompt = plugin.settings.useLatestSystemPromptForNewChats ?? true;

  if (isAdvancedMode) {
    new Setting(containerEl)
      .setName("Use your latest selection")
      .setDesc("When enabled, new chats start with whichever prompt you last picked.")
      .addToggle((toggle) => {
        toggle
          .setValue(useLatestPrompt)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ useLatestSystemPromptForNewChats: value });
            tabInstance.display();
          });
      });
  } else {
    new Setting(containerEl)
      .setName("Use your latest selection")
      .setDesc("Always enabled in Standard mode.")
      .addToggle((toggle) => {
        toggle.setValue(true).setDisabled(true);
      });
  }

  const chatPromptSummary = describeChatPrompt(app, plugin);
  const chatPromptSetting = new Setting(containerEl)
    .setName('Default chat prompt')
    .setDesc(chatPromptSummary.text);
  if (chatPromptSummary.missing) {
    chatPromptSetting.descEl.addClass('ss-inline-note');
  }
  chatPromptSetting.addButton((button) => {
    button
      .setButtonText('Change...')
      .onClick(() => {
        const modal = new StandardSystemPromptSelectionModal({
          app,
          plugin,
          currentType: plugin.settings.systemPromptType || 'general-use',
          currentPath: plugin.settings.systemPromptPath,
          title: 'Select default system prompt',
          description: 'Pick the system prompt applied to new chat conversations.',
          onSelect: async (result) => {
            try {
              const updates: Record<string, unknown> = { systemPromptType: result.type };
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

  if (shouldShowManualPromptInput(plugin)) {
    const manualSetting = new Setting(containerEl)
      .setName('Custom prompt text')
      .setDesc('Used when the default prompt is set to "Custom text".');
    manualSetting.addTextArea((text) => {
      text
        .setValue(plugin.settings.systemPrompt || '')
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ systemPrompt: value });
        });
      text.inputEl.rows = 6;
    });
  }

  const titlePromptSummary = describeTitlePrompt(app, plugin);
  const titleSetting = new Setting(containerEl)
    .setName('Title generation prompt')
    .setDesc(titlePromptSummary.text);
  if (titlePromptSummary.missing) {
    titleSetting.descEl.addClass('ss-inline-note');
  }

  titleSetting.addButton((button) => {
    button
      .setButtonText('Change...')
      .onClick(async () => {
        try {
          const result = await showTitleGenerationPromptModal(app, plugin, plugin.settings.titleGenerationPrompt, {
            systemPromptsDirectory: plugin.settings.systemPromptsDirectory
          });
          if (result) {
            plugin.emitter?.emit?.('settingsChanged');
            new Notice('Title generation prompt updated.', 3000);
            tabInstance.display();
          }
        } catch (error) {
          new Notice('Failed to update title generation prompt.', 4000);
        }
      });
  });

  const postProcessingSummary = describePostProcessingPrompt(app, plugin);
  const postProcessingSetting = new Setting(containerEl)
    .setName('Post-processing prompt')
    .setDesc(postProcessingSummary.text);
  if (postProcessingSummary.missing) {
    postProcessingSetting.descEl.addClass('ss-inline-note');
  }

  postProcessingSetting.addButton((button) => {
    button
      .setButtonText('Change...')
      .onClick(async () => {
        try {
          const modal = new PostProcessingPromptModal(app, plugin, plugin.settings.postProcessingPrompt, plugin.settings.systemPromptsDirectory);
          const result = await modal.openAndGetResult();
          if (result) {
            plugin.emitter?.emit?.('settingsChanged');
            new Notice('Post-processing prompt updated.', 3000);
            tabInstance.display();
          }
        } catch (error) {
          new Notice('Failed to update post-processing prompt.', 4000);
        }
      });
  });
}

function describeChatPrompt(app: App, plugin: PluginInstance): PromptSummary {
  const type = plugin.settings.systemPromptType;
  const path = plugin.settings.systemPromptPath;
  switch (type) {
    case 'general-use':
      return { text: 'General use preset' };
    case 'concise':
      return { text: 'Concise preset' };
    case 'agent':
      return { text: 'Agent mode preset' };
    case 'custom':
      if (path) {
        return describeCustomFile(app, path, 'Custom prompt');
      }
      return { text: 'Custom prompt (manual text)' };
    default:
      return { text: 'General use preset' };
  }
}

function describeTitlePrompt(app: App, plugin: PluginInstance): PromptSummary {
  const type = plugin.settings.titleGenerationPromptType;
  const path = plugin.settings.titleGenerationPromptPath;
  switch (type) {
    case 'precise':
      return { text: 'Precise preset' };
    case 'movie-style':
      return { text: 'Movie style preset' };
    case 'custom':
      if (path) {
        return describeCustomFile(app, path, 'Custom prompt');
      }
      return { text: 'Custom prompt (manual text)' };
    default:
      return { text: 'Precise preset' };
  }
}

function describePostProcessingPrompt(app: App, plugin: PluginInstance): PromptSummary {
  const type = plugin.settings.postProcessingPromptType;
  const path = plugin.settings.postProcessingPromptFilePath;
  const presetId = plugin.settings.postProcessingPromptPresetId;

  if (type === 'file' && path) {
    return describeCustomFile(app, path, 'Custom prompt');
  }

  if (type === 'preset') {
    return { text: `Preset (${presetId || 'default'})` };
  }

  return { text: 'Preset (default)' };
}

function describeCustomFile(app: App, path: string, fallback: string): PromptSummary {
  const file = app.vault.getAbstractFileByPath(path);
  if (file) {
    const fileName = path.split('/').pop()?.replace(/\.md$/, '') || fallback;
    return { text: `Custom file: ${fileName}` };
  }
  const missingName = path.split('/').pop() || path;
  return { text: `Custom file missing: ${missingName}`, missing: true };
}

function shouldShowManualPromptInput(plugin: PluginInstance): boolean {
  return plugin.settings.systemPromptType === 'custom' && !plugin.settings.systemPromptPath;
}

function formatPromptSelection(result: {
  type: string;
  path?: string;
  prompt?: string;
}): string {
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
        return `Custom file (${fileName})`;
      }
      return 'Custom text';
    default:
      return result.type;
  }
}
