import {
  MarkdownView,
  App,
  PluginSettingTab,
  requestUrl,
  Setting,
} from 'obsidian';
import SystemSculptPlugin from '../../main';
import {
  TemplatesSettings,
  DEFAULT_TEMPLATES_SETTINGS,
} from './settings/TemplatesSettings';
import { renderTemplatesPathSetting } from './settings/TemplatesPathSetting';
import { AIService } from '../../api/AIService';
import { showCustomNotice } from '../../modals';
import { renderBlankTemplatePromptSetting } from './settings/BlankTemplatePromptSetting';
import { TemplatesSuggest } from './TemplatesSuggest';
import { renderLicenseKeySetting } from './settings/LicenseKeySetting';
import { checkLicenseValidity } from './functions/checkLicenseValidity';
import { IGenerationModule } from '../../interfaces/IGenerationModule';
import { BlankTemplateModal } from './views/BlankTemplateModal';

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
      console.log(
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
      console.log('No valid license key found. Skipping update check.');
      return;
    }
    if (await checkLicenseValidity(this)) {
      await this.checkAndUpdateTemplates();
    }
  }

  async checkAndUpdateTemplates(): Promise<void> {
    // First, check if the license key is empty
    if (!this.settings.licenseKey || this.settings.licenseKey.trim() === '') {
      console.log(
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

    new Setting(containerEl)
      .setName('Show SS-Sync templates in suggestions')
      .setDesc('Toggle the display of templates within the SS-Sync folder')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showSSSyncTemplates)
          .onChange(async (value: boolean) => {
            this.plugin.settings.showSSSyncTemplates = value;
            await this.plugin.saveSettings();
          });

        const keepInMindBoxEl = containerEl.createDiv('info-box');
        keepInMindBoxEl.createEl('p', {
          text: "Whenever you sync to the latest templates, all templates found in the SS-Sync folder will be overwritten. This means that if you want to modify one to your own liking, make sure to place it in the Templates folder, outside of the SS-Sync directory - it will be safe there and won't be overwritten.",
        });
      });

    new Setting(containerEl)
      .setName('Trigger key')
      .setDesc(
        'The key that triggers the template suggestion modal (single character only)'
      )
      .addText(text => {
        text
          .setPlaceholder('Enter trigger key')
          .setValue(this.plugin.settings.triggerKey);

        text.inputEl.addEventListener(
          'keydown',
          async (event: KeyboardEvent) => {
            event.preventDefault();
            const triggerKey = event.key.length === 1 ? event.key : '/';
            this.plugin.settings.triggerKey = triggerKey;
            await this.plugin.saveSettings();
            text.setValue(triggerKey);
          }
        );
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default trigger key')
          .onClick(async () => {
            this.plugin.settings.triggerKey = '/';
            await this.plugin.saveSettings();
            this.display(); // Refresh the settings view
          });
      });

    renderTemplatesPathSetting(containerEl, this.plugin);
    renderBlankTemplatePromptSetting(containerEl, this.plugin);
  }
}
