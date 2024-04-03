import { App, PluginSettingTab, DropdownComponent, Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { renderOpenAIApiKeySetting } from './OpenAIApiKeySetting';
import { renderModelDropdown } from './ModelSetting';
import { renderGenerateTitlePrompt } from './GenerateTitlePromptSetting';
import { renderMaxTokensSetting } from './MaxTokensSetting';

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
    const brainSettingsTitle = containerEl.createEl('h3', {
      text: 'Brain Settings',
    });
    brainSettingsTitle.addClass('ss-h3');
    containerEl.createEl('p', {
      text: 'Set the more general settings here, which are used across all modules.',
    });

    renderOpenAIApiKeySetting(containerEl, this.plugin);
    renderModelDropdown(containerEl, this.plugin);

    const infoBoxEl = containerEl.createDiv('info-box');
    infoBoxEl.createEl('p', {
      text: "Note: GPT-3.5-Turbo is pretty much free; it's fractions of a cent and pretty powerful. I personally spend less than $3 a day from very heavy use of GPT-4-Turbo. Each person is different. I recommend tracking your daily use and seeing what your average is, and then adjust between using GPT-3.5-Turbo and GPT-4-Turbo.",
    });

    renderMaxTokensSetting(containerEl, this.plugin);
    renderGenerateTitlePrompt(containerEl, this.plugin);

    // Upcoming Features
    const upcomingFeaturesEl = containerEl.createDiv('upcoming-features');
    const upcomingBrainFeaturesH3 = upcomingFeaturesEl.createEl('h3', {
      text: 'Upcoming Brain Features',
    });
    upcomingBrainFeaturesH3.addClass('ss-h3');
    const featuresListEl = upcomingFeaturesEl.createEl('ul');
    featuresListEl.createEl('li', {
      text: '"Cost Caution" Toggle: cost estimates before confirming any online model interaction so you know how much you\'re about to spend',
    });
    featuresListEl.createEl('li', {
      text: 'Use your own local LLM (LMStudio / Ollama)',
    });
    featuresListEl.createEl('li', {
      text: 'Use your own local Whisper instance for Recorder transcription',
    });
    featuresListEl.createEl('li', {
      text: 'Simple / Advanced Settings Modes (further fine-tune your settings; Online Mode, Offline Mode, Mixed Mode, able to be toggled through with the click of a button on the status bar)',
    });
    featuresListEl.createEl('li', {
      text: "Toggle entire SystemSculpt AI modules on or off if you're not using them",
    });
    featuresListEl.createEl('li', {
      text: 'Include Anthropic, Google, and OpenRouter AI APIs in Online Mode',
    });
  }
}
