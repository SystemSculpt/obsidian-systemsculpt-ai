import { App, PluginSettingTab, requestUrl, Setting } from 'obsidian';
import SystemSculptPlugin from '../../main';
import {
  TemplatesSettings,
  DEFAULT_TEMPLATES_SETTINGS,
} from './settings/TemplatesSettings';
import { renderTemplatesPathSetting } from './settings/TemplatesPathSetting';
import { OpenAIService } from '../../api/OpenAIService';
import { showCustomNotice } from '../../modals';
import { renderBlankTemplatePromptSetting } from './settings/BlankTemplatePromptSetting';
import { downloadTemplatesFromServer } from './functions/downloadTemplatesFromServer';
import { TemplatesSuggest } from './TemplatesSuggest';
import { renderLicenseKeySetting } from './settings/LicenseKeySetting';
import { checkLicenseValidity } from './functions/checkLicenseValidity';

export class TemplatesModule {
  plugin: SystemSculptPlugin;
  settings: TemplatesSettings;
  openAIService: OpenAIService;
  abortController: AbortController | null = null;
  isGenerationCompleted: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.openAIService = plugin.brainModule.openAIService;
  }

  async load() {
    await this.loadSettings();
    this.registerCodeMirror();
    setTimeout(async () => {
      if (await checkLicenseValidity(this)) {
        this.checkAndUpdateTemplates();
        setInterval(() => this.checkAndUpdateTemplates(), 10800000); // 3 hours in milliseconds
      }
    }, 5000); // Delay of 5 seconds after plugin initialization
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_TEMPLATES_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new TemplatesSettingTab(this.plugin.app, this, containerEl).display();
  }

  registerCodeMirror() {
    this.plugin.registerEditorSuggest(new TemplatesSuggest(this));
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      showCustomNotice('Template generation stopped', 5000);
    }
  }

  async checkAndUpdateTemplates(): Promise<void> {
    // First, check if the license key is valid
    if (!this.settings.licenseKey || this.settings.licenseKey.trim() === '') {
      console.log(
        'No valid license key found. Please enter your license key in the settings.'
      );
      return;
    }

    // Check if the license key is valid by calling the license validation function
    const isValidLicense = await checkLicenseValidity(this);
    if (!isValidLicense) {
      console.log(
        'Your license key is not valid. Please check your license key in the settings.'
      );
      return;
    }

    // Proceed with checking the server for the latest templates version
    const serverVersionResponse = await requestUrl({
      url: 'https://license.systemsculpt.com/templates-version',
    });
    const serverVersion = serverVersionResponse.json.version;
    if (this.settings.templatesVersion !== serverVersion) {
      showCustomNotice(
        'A new version of the templates is available. Please update manually through the settings.'
      );
    } else {
      console.log('You already have the latest version of the templates.');
    }
  }
}

class TemplatesSettingTab extends PluginSettingTab {
  plugin: TemplatesModule;

  constructor(app: App, plugin: TemplatesModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName('Templates').setHeading();
    containerEl.createEl('p', {
      text: 'Change your default AI templates location, what your default blank prompt does in the background, and more.',
    });

    const infoBoxEl = containerEl.createDiv('info-box');
    infoBoxEl.createEl('p', {
      text: "If you're a Patreon member, download the latest AI templates from SystemSculpt!",
    });

    renderLicenseKeySetting(containerEl, this.plugin);

    renderTemplatesPathSetting(containerEl, this.plugin);
    renderBlankTemplatePromptSetting(containerEl, this.plugin);
  }
}
