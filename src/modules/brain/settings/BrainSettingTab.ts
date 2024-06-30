import { App, PluginSettingTab, Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { renderOpenAIApiKeySetting } from './OpenAIApiKeySetting';
import { renderGroqAPIKeySetting } from './GroqAPIKeySetting';
import { renderLocalEndpointSetting } from './LocalEndpointSetting';
import { renderModelSelectionButton } from './ModelSetting';
import { renderGenerateTitlePrompt } from './GenerateTitlePromptSetting';
import { renderGeneralGenerationPromptSetting } from './GeneralGenerationPromptSetting';
import { renderMaxTokensSetting } from './MaxTokensSetting';
import { renderShowDefaultModelOnStatusBarSetting } from './ShowDefaultModelOnStatusBarSetting';
import { renderShowMaxTokensOnStatusBarSetting } from './ShowMaxTokensOnStatusBarSetting';
import { displayVersionInfo } from '../functions/displayVersionInfo';
import { renderAPIEndpointToggles } from './APIEndpointToggles';
import { renderTemperatureSetting } from './renderTemperatureSetting';
import { renderOpenRouterAPIKeySetting } from './OpenRouterAPIKeySetting';

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

    renderAPIEndpointToggles(containerEl, this.plugin, () => this.refreshTab());

    renderLocalEndpointSetting(containerEl, this.plugin, () =>
      this.refreshTab()
    );
    renderOpenAIApiKeySetting(containerEl, this.plugin, () =>
      this.refreshTab()
    );
    renderGroqAPIKeySetting(containerEl, this.plugin, () => this.refreshTab());
    renderOpenRouterAPIKeySetting(containerEl, this.plugin, () =>
      this.refreshTab()
    );

    // Add this line back to render the model dropdown
    renderModelSelectionButton(containerEl, this.plugin);

    renderShowDefaultModelOnStatusBarSetting(containerEl, this.plugin);
    renderTemperatureSetting(containerEl, this.plugin);

    const temperatureInfoBox = containerEl.createDiv('info-box');
    temperatureInfoBox.createEl('p', {
      text: 'If your LLM temperature is at or above 1.0, it may lead to over-creative results, which potentially runs the risk of producing gibberish or random text in some cases. It is recommended to stay under 1.0.',
    });

    renderMaxTokensSetting(containerEl, this.plugin);
    renderShowMaxTokensOnStatusBarSetting(containerEl, this.plugin);
    renderGenerateTitlePrompt(containerEl, this.plugin);
    renderGeneralGenerationPromptSetting(containerEl, this.plugin);
  }

  refreshTab(): void {
    this.display();
  }
}
