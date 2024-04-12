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
    setInterval(() => this.checkAndUpdateTemplates(), 10800000); // 3 hours in milliseconds

    this.plugin.addCommand({
      id: 'sync-templates',
      name: 'Sync templates from server',
      callback: async () => {
        await downloadTemplatesFromServer(this);
      },
    });
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
    const serverVersionResponse = await requestUrl({
      url: 'https://license.systemsculpt.com/templates-version',
    });
    const serverVersion = serverVersionResponse.json.version;
    if (this.settings.templatesVersion !== serverVersion) {
      await downloadTemplatesFromServer(this);
      this.settings.templatesVersion = serverVersion;
      await this.saveSettings();
      showCustomNotice('SS-Sync Templates updated to the latest version!');
    } else {
      showCustomNotice('You already have the latest version of the templates.');
      await downloadTemplatesFromServer(this);
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

    renderLicenseKeySetting(containerEl, this.plugin);

    renderTemplatesPathSetting(containerEl, this.plugin);
    renderBlankTemplatePromptSetting(containerEl, this.plugin);
  }
}
