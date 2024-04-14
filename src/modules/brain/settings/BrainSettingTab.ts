import { App, PluginSettingTab, DropdownComponent, Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { renderOpenAIApiKeySetting } from './OpenAIApiKeySetting';
import { renderModelDropdown } from './ModelSetting';
import { renderGenerateTitlePrompt } from './GenerateTitlePromptSetting';
import { renderGeneralGenerationPromptSetting } from './GeneralGenerationPromptSetting';
import { renderMaxTokensSetting } from './MaxTokensSetting';
import { updateMaxTokensStatusBar } from '../functions/updateMaxTokensStatusBar';
import { renderUpdateButtonStatusBarSetting } from './UpdateButtonStatusBarSetting';

export class BrainSettingTab extends PluginSettingTab {
  plugin: BrainModule;

  constructor(app: App, plugin: BrainModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName('Brain').setHeading();

    containerEl.createEl('p', {
      text: 'Set the more general settings here, which are used across all modules.',
    });
    if (this.plugin.plugin.updateModule.updateAvailable) {
      new Setting(containerEl)
        .setName('Update plugin')
        .setDesc(
          'A new version of SystemSculpt AI is available. Click to update.'
        )
        .addButton(button => {
          button
            .setButtonText('Update')
            .setCta()
            .onClick(async () => {
              button.setButtonText('Updating...');
              button.setDisabled(true);
              await this.plugin.plugin.updateModule.updatePlugin();
            });
        });

      // Add toggle for showing Update Button on the status bar
      renderUpdateButtonStatusBarSetting(containerEl, this.plugin);
    }

    renderOpenAIApiKeySetting(containerEl, this.plugin);
    renderModelDropdown(containerEl, this.plugin);

    // Add toggle for showing Default Model on the status bar
    new Setting(containerEl)
      .setName('Show default model on status bar')
      .setDesc('Toggle the display of default model on the status bar')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showDefaultModelOnStatusBar)
          .onChange(async value => {
            this.plugin.settings.showDefaultModelOnStatusBar = value;
            if (value) {
              this.plugin.plugin?.modelToggleStatusBarItem?.setText(
                `GPT-${this.plugin.getCurrentModelShortName()}` // Show on status bar
              );
            } else {
              if (this.plugin.plugin?.modelToggleStatusBarItem) {
                this.plugin.plugin.modelToggleStatusBarItem.setText(''); // Hide from status bar
              }
            }
            await this.plugin.saveSettings();
          });
      });

    renderMaxTokensSetting(containerEl, this.plugin);

    // Add toggle for showing Max Tokens on the status bar
    new Setting(containerEl)
      .setName('Show max tokens on status bar')
      .setDesc('Toggle the display of max tokens on the status bar')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showMaxTokensOnStatusBar)
          .onChange(async value => {
            this.plugin.settings.showMaxTokensOnStatusBar = value;
            if (value) {
              updateMaxTokensStatusBar(this.plugin); // Show on status bar
            } else {
              if (this.plugin.plugin?.maxTokensToggleStatusBarItem) {
                this.plugin.plugin.maxTokensToggleStatusBarItem.setText(''); // Hide from status bar
              }
            }
            await this.plugin.saveSettings();
          });
      });

    renderGenerateTitlePrompt(containerEl, this.plugin);
    renderGeneralGenerationPromptSetting(containerEl, this.plugin);
  }
}
