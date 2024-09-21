import { App, PluginSettingTab, Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { EndpointManager } from './EndpointManager';
import { renderModelSelectionButton } from './ModelSetting';
import { renderGenerateTitlePrompt } from './GenerateTitlePromptSetting';
import { renderGeneralGenerationPromptSetting } from './GeneralGenerationPromptSetting';
import { renderShowDefaultModelOnStatusBarSetting } from './ShowDefaultModelOnStatusBarSetting';
import { displayVersionInfo } from '../functions/displayVersionInfo';
import { renderTemperatureSetting } from './renderTemperatureSetting';

export class BrainSettingTab extends PluginSettingTab {
  plugin: BrainModule;

  constructor(app: App, plugin: BrainModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addHeading();
    this.addDescription();
    this.renderSettings();
  }

  private addHeading(): void {
    new Setting(this.containerEl).setName('Brain').setHeading();
  }

  private addDescription(): void {
    this.containerEl.createEl('p', {
      text: 'Set the more general settings here, which are used across all modules.',
    });
  }

  private renderSettings(): void {
    displayVersionInfo(this.containerEl, this.plugin);
    const endpointManager = new EndpointManager(
      this.containerEl,
      this.plugin,
      () => this.refreshTab()
    );
    endpointManager.renderEndpointSettings();
    this.renderBaseApiUrlSetting();
    this.renderModelSettings();
    this.renderTemperatureSettings();
    this.renderPromptSettings();
  }

  private renderBaseApiUrlSetting(): void {
    new Setting(this.containerEl)
      .setName('OpenAI API Base URL')
      .setDesc('Set the base URL for OpenAI API calls. Leave blank to use the default.')
      .addText(text => text
        .setPlaceholder('https://api.openai.com/v1')
        .setValue(this.plugin.settings.baseApiUrl)
        .onChange(async (value) => {
          this.plugin.settings.baseApiUrl = value || 'https://api.openai.com/v1';
          await this.plugin.saveSettings();
        }));
  }

  private renderModelSettings(): void {
    renderModelSelectionButton(this.containerEl, this.plugin);
    renderShowDefaultModelOnStatusBarSetting(this.containerEl, this.plugin);
  }

  private renderTemperatureSettings(): void {
    renderTemperatureSetting(this.containerEl, this.plugin);
    this.addTemperatureInfoBox();
  }

  private addTemperatureInfoBox(): void {
    const temperatureInfoBox = this.containerEl.createDiv('info-box');
    temperatureInfoBox.createEl('p', {
      text: 'If your LLM temperature is at or above 1.0, it may lead to over-creative results, which potentially runs the risk of producing gibberish or random text in some cases. It is recommended to stay under 1.0.',
    });
  }

  private renderPromptSettings(): void {
    renderGenerateTitlePrompt(this.containerEl, this.plugin);
    renderGeneralGenerationPromptSetting(this.containerEl, this.plugin);
  }

  refreshTab(): void {
    this.display();
  }
}
