import { MarkdownView, requestUrl, Setting, TFolder } from 'obsidian';
import SystemSculptPlugin from '../../main';
import { AIService } from '../../api/AIService';
import { showCustomNotice } from '../../modals';
import { TemplatesSuggest } from './TemplatesSuggest';
import { checkLicenseValidity } from './functions/checkLicenseValidity';
import { IGenerationModule } from '../../interfaces/IGenerationModule';
import { BlankTemplateModal } from './views/BlankTemplateModal';
import { logger } from '../../utils/logger';
import { MultiSuggest } from '../../utils/MultiSuggest';
import { renderLicenseKeySetting } from './settings/LicenseKeySetting';

export interface TemplatesSettings {
  templatesPath: string;
  blankTemplatePrompt: string;
  licenseKey: string;
  templatesVersion: string;
  showSSSyncTemplates: boolean;
  triggerKey: string;
  isPatreonMember: boolean;
}

export const DEFAULT_TEMPLATES_SETTINGS: TemplatesSettings = {
  templatesPath: 'SystemSculpt/Templates',
  blankTemplatePrompt: `You are an AI assistant tasked with generating concise and specific content based on the user's prompt. Your role is to provide a focused and useful response without unnecessary prose.
  
Rules:
- Carefully analyze the user's prompt to understand their intent and desired output.
- Generate content that directly addresses the prompt, avoiding tangents or filler text.
- Aim to provide a succinct and actionable response that meets the user's needs.
- Ensure your output is well-structured, clear, and easy to follow.
- Do not introduce any new formatting or markdown syntax unless specifically requested in the prompt.
- Your generation response should be purely the requested content, without any additional labels or explanations.`,
  licenseKey: '',
  templatesVersion: '0.0.1',
  showSSSyncTemplates: true,
  triggerKey: '/',
  isPatreonMember: false,
};

export class TemplatesModule implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: TemplatesSettings;
  private _AIService: AIService | null = null;
  abortController: AbortController | null = null;
  isGenerationCompleted: boolean = false;
  private firstLicenseCheckDone: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_TEMPLATES_SETTINGS;
  }

  get AIService(): AIService {
    if (!this._AIService) {
      this._AIService = this.plugin.brainModule.AIService;
    }
    return this._AIService as AIService;
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

    // Wait for the BrainModule to initialize the AIService
    await this.plugin.brainModule.initializeAIService();
    await this.AIService.ensureModelCacheInitialized();
  }

  async loadSettings() {
    const savedSettings = await this.plugin.loadData();
    this.settings = Object.assign(
      {},
      DEFAULT_TEMPLATES_SETTINGS,
      savedSettings
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }


  registerCodeMirror() {
    this.plugin.registerEditorSuggest(new TemplatesSuggest(this));
  }

  registerDomEvent() {
    if (this.settings.triggerKey) {
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

  settingsDisplay(containerEl: HTMLElement): void {
    containerEl.empty();
    
    new Setting(containerEl).setName('Templates').setHeading();
    containerEl.createEl('p', {
      text: 'Change your default AI templates location, what your default blank prompt does in the background, and more.',
    });

    // Add Patreon member toggle with custom style
    const patreonSetting = new Setting(containerEl)
      .setName('Are you a Patreon member?')
      .setDesc('Toggle to show Patreon member options')
      .addToggle(toggle => {
        toggle
          .setValue(this.settings.isPatreonMember)
          .onChange(async (value: boolean) => {
            this.settings.isPatreonMember = value;
            await this.saveSettings();
            this.settingsDisplay(containerEl); // Refresh the settings view
          });
      });

    // Apply custom CSS class
    patreonSetting.settingEl.addClass('patreon-member-setting');

    if (this.settings.isPatreonMember) {
      const infoBoxEl = containerEl.createDiv('info-box');
      infoBoxEl.createEl('p', {
        text: "If you're a Patreon member, download the latest AI templates from SystemSculpt!",
      });

      // Apply custom CSS class to info box
      infoBoxEl.addClass('patreon-sub-setting');

      this.renderLicenseKeySetting(containerEl);

      const ssSyncSetting = new Setting(containerEl)
        .setName('Show SS-Sync templates in suggestions')
        .setDesc('Toggle the display of templates within the SS-Sync folder')
        .addToggle(toggle => {
          toggle
            .setValue(this.settings.showSSSyncTemplates)
            .onChange(async (value: boolean) => {
              this.settings.showSSSyncTemplates = value;
              await this.saveSettings();
            });

          const keepInMindBoxEl = containerEl.createDiv('info-box');
          keepInMindBoxEl.createEl('p', {
            text: "Whenever you sync to the latest templates, all templates found in the SS-Sync folder will be overwritten. This means that if you want to modify one to your own liking, make sure to place it in the Templates folder, outside of the SS-Sync directory - it will be safe there and won't be overwritten.",
          });

          // Apply custom CSS class to keepInMindBoxEl
          keepInMindBoxEl.addClass('patreon-sub-setting');
        });

      // Apply custom CSS class to ssSyncSetting
      ssSyncSetting.settingEl.addClass('patreon-sub-setting');
    } else {
      const becomePatreonEl = containerEl.createDiv('info-box');
      const becomePatreonButton = becomePatreonEl.createEl('button', {
        cls: '',
        text: 'Click here to become a Patreon member for only $10 bucks!',
      });
      becomePatreonButton.addEventListener('click', () => {
        window.open('https://patreon.com/systemsculpt', '_blank');
      });
    }

    this.renderTriggerKeySetting(containerEl);
    this.renderTemplatesPathSetting(containerEl);
    this.renderBlankTemplatePromptSetting(containerEl);
  }

  private renderLicenseKeySetting(containerEl: HTMLElement): void {
    renderLicenseKeySetting(containerEl, this);
  }

  private renderTriggerKeySetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Trigger key')
      .setDesc(
        'The key that triggers the template suggestion modal (single character only, leave empty to disable)'
      )
      .addText(text => {
        text
          .setPlaceholder('Enter trigger key or leave empty')
          .setValue(this.settings.triggerKey);

        text.inputEl.addEventListener(
          'keydown',
          async (event: KeyboardEvent) => {
            event.preventDefault();
            const triggerKey = event.key.length === 1 ? event.key : '';
            this.settings.triggerKey = triggerKey;
            await this.saveSettings();
            text.setValue(triggerKey);
            this.registerDomEvent(); // Re-register the event listener
          }
        );
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default trigger key')
          .onClick(async () => {
            this.settings.triggerKey = '/';
            await this.saveSettings();
            this.settingsDisplay(containerEl); // Refresh the settings view
            this.registerDomEvent(); // Re-register the event listener
          });
      });
  }

  private renderTemplatesPathSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Templates folder location')
      .setDesc('Path where the templates will be stored')
      .addText(text => {
        text
          .setPlaceholder('Enter path')
          .setValue(this.settings.templatesPath)
          .onChange(async value => {
            this.settings.templatesPath = value;
            await this.saveSettings();
          });

        // Add folder suggestion
        const inputEl = text.inputEl;
        const suggestionContent = this.getFolderSuggestions();
        const onSelectCallback = (selectedPath: string) => {
          this.settings.templatesPath = selectedPath;
          text.setValue(selectedPath);
          this.saveSettings();
        };

        new MultiSuggest(
          inputEl,
          suggestionContent,
          onSelectCallback,
          this.plugin.app
        );
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default path')
          .onClick(async () => {
            this.settings.templatesPath =
              DEFAULT_TEMPLATES_SETTINGS.templatesPath;
            await this.saveSettings();
            this.settingsDisplay(containerEl);
          });
      });
  }

  private getFolderSuggestions(): Set<string> {
    const folders = this.plugin.app.vault
      .getAllLoadedFiles()
      .filter(file => file instanceof TFolder) as TFolder[];
    const suggestionContent = new Set(folders.map(folder => folder.path));
    return suggestionContent;
  }

  private renderBlankTemplatePromptSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Blank template prompt')
      .setDesc('The system prompt used for the Blank Template.')
      .addTextArea(text => {
        text
          .setPlaceholder('Enter blank template prompt')
          .setValue(this.settings.blankTemplatePrompt)
          .onChange(async (newValue: string) => {
            this.settings.blankTemplatePrompt = newValue;
            await this.saveSettings();
          });
        text.inputEl.rows = 10;
        text.inputEl.cols = 50;
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default blank template prompt')
          .onClick(async () => {
            this.settings.blankTemplatePrompt =
              DEFAULT_TEMPLATES_SETTINGS.blankTemplatePrompt;
            await this.saveSettings();
            this.settingsDisplay(containerEl);
          });
      });
  }
}
