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
    this.renderAPISettings();
    this.renderModelSettings();
    this.renderTemperatureSettings();
    this.renderTokenSettings();
    this.renderPromptSettings();
  }

  private renderAPISettings(): void {
    renderAPIEndpointToggles(this.containerEl, this.plugin, () => this.refreshTab());
    renderLocalEndpointSetting(this.containerEl, this.plugin, () => this.refreshTab());
    renderOpenAIApiKeySetting(this.containerEl, this.plugin, () => this.refreshTab());
    renderGroqAPIKeySetting(this.containerEl, this.plugin, () => this.refreshTab());
    renderOpenRouterAPIKeySetting(this.containerEl, this.plugin, () => this.refreshTab());
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

  private renderTokenSettings(): void {
    renderMaxTokensSetting(this.containerEl, this.plugin);
    renderShowMaxTokensOnStatusBarSetting(this.containerEl, this.plugin);
  }

  private renderPromptSettings(): void {
    renderGenerateTitlePrompt(this.containerEl, this.plugin);
    renderGeneralGenerationPromptSetting(this.containerEl, this.plugin);
  }

  refreshTab(): void {
    this.display();
  }
}
