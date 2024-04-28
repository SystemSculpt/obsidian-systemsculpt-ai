import { App, PluginSettingTab, Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { renderOpenAIApiKeySetting } from './OpenAIApiKeySetting';
import { renderGroqAPIKeySetting } from './GroqAPIKeySetting';
import { renderLocalEndpointSetting } from './LocalEndpointSetting';
import { renderModelDropdown } from './ModelSetting';
import { renderGenerateTitlePrompt } from './GenerateTitlePromptSetting';
import { renderGeneralGenerationPromptSetting } from './GeneralGenerationPromptSetting';
import { renderMaxTokensSetting } from './MaxTokensSetting';
import { renderShowDefaultModelOnStatusBarSetting } from './ShowDefaultModelOnStatusBarSetting';
import { renderShowMaxTokensOnStatusBarSetting } from './ShowMaxTokensOnStatusBarSetting';
import { displayVersionInfo } from '../functions/displayVersionInfo';

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

    displayVersionInfo(containerEl, this.plugin);

    renderLocalEndpointSetting(containerEl, this.plugin, () =>
      this.refreshTab()
    );
    renderOpenAIApiKeySetting(containerEl, this.plugin, () =>
      this.refreshTab()
    );
    renderGroqAPIKeySetting(containerEl, this.plugin, () => this.refreshTab());
    renderModelDropdown(containerEl, this.plugin);
    renderShowDefaultModelOnStatusBarSetting(containerEl, this.plugin);
    renderMaxTokensSetting(containerEl, this.plugin);
    renderShowMaxTokensOnStatusBarSetting(containerEl, this.plugin);
    renderGenerateTitlePrompt(containerEl, this.plugin);
    renderGeneralGenerationPromptSetting(containerEl, this.plugin);
  }

  refreshTab(): void {
    this.display();
  }
}
