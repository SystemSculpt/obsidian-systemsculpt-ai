import { MarkdownView, requestUrl } from 'obsidian';
import SystemSculptPlugin from '../../main';
import {
  TemplatesSettings,
  DEFAULT_TEMPLATES_SETTINGS,
} from './settings/TemplatesSettings';
import { AIService } from '../../api/AIService';
import { showCustomNotice } from '../../modals';
import { TemplatesSuggest } from './TemplatesSuggest';
import { checkLicenseValidity } from './functions/checkLicenseValidity';
import { IGenerationModule } from '../../interfaces/IGenerationModule';
import { BlankTemplateModal } from './views/BlankTemplateModal';
import { TemplatesSettingTab } from './settings/TemplatesSettingTab';
import { logger } from '../../utils/logger';

export class TemplatesModule implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: TemplatesSettings;
  openAIService: AIService;
  abortController: AbortController | null = null;
  isGenerationCompleted: boolean = false;
  private firstLicenseCheckDone: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.openAIService = plugin.brainModule.openAIService;
  }

  async load() {
    await this.loadSettings();
    this.registerCodeMirror();
    this.registerDomEvent();
    setTimeout(async () => {
      await this.checkLicenseOnStartup();
      setInterval(() => this.checkForUpdate(), 3 * 60 * 60 * 1000); // 3 hours in milliseconds
    }, 5000); // Delay of 5 seconds after plugin initialization
    this.plugin.addCommand({
      id: 'trigger-template-suggestions',
      name: 'Trigger template suggestions',
      callback: () => this.triggerTemplateSuggestions(),
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

  registerDomEvent() {
    this.plugin.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
      if (evt.key === this.settings.triggerKey) {
        const activeView =
          this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const editor = activeView.editor;
          const selectedText = editor.getSelection();
          if (selectedText) {
            evt.preventDefault();
            new BlankTemplateModal(this).open();
          }
        }
      }
    });
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.isGenerationCompleted = false;
      showCustomNotice('Template generation stopped', 5000);
    }
  }

  async checkLicenseOnStartup(): Promise<void> {
    if (this.firstLicenseCheckDone) return;

    const licenseKey = this.settings.licenseKey;
    if (!licenseKey || !licenseKey.includes('-') || licenseKey.includes(' ')) {
      logger.log(
        'License key format is invalid or missing. Skipping license check on startup.'
      );
      return;
    }

    if (await checkLicenseValidity(this)) {
      await this.checkAndUpdateTemplates();
    }
    this.firstLicenseCheckDone = true;
  }

  async checkForUpdate(): Promise<void> {
    if (!this.settings.licenseKey || this.settings.licenseKey.trim() === '') {
      logger.log('No valid license key found. Skipping update check.');
      return;
    }
    if (await checkLicenseValidity(this)) {
      await this.checkAndUpdateTemplates();
    }
  }

  async checkAndUpdateTemplates(): Promise<void> {
    // Check if the user is a Patreon member
    if (!this.settings.isPatreonMember) {
      logger.log(
        'User is not a Patreon member. Skipping template update check.'
      );
      return;
    }

    // First, check if the license key is empty
    if (!this.settings.licenseKey || this.settings.licenseKey.trim() === '') {
      logger.log(
        'No valid license key found. Please enter your license key in the settings. If you need a license key, please message on Patreon or Discord.'
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
    }
  }

  async triggerTemplateSuggestions(): Promise<void> {
    const activeView =
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const selectedText = editor.getSelection();
      if (selectedText) {
        new BlankTemplateModal(this).open();
      }
    }
  }
}
