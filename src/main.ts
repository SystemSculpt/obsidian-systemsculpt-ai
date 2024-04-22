import { Plugin, TAbstractFile, TFile } from 'obsidian';
import {
  SystemSculptSettings,
  DEFAULT_SETTINGS,
  SystemSculptSettingTab,
} from './settings';
import { TasksModule } from './modules/tasks/TasksModule';
import { BrainModule } from './modules/brain/BrainModule';
import { TemplatesModule } from './modules/templates/TemplatesModule';
import { DataModule } from './modules/data/DataModule';
import { RecorderModule } from './modules/recorder/RecorderModule';
import { AboutModule } from './modules/about/AboutModule';
import { AIService } from './api/AIService';
import { registerMp3ContextMenu } from './events';

const development = false;

if (!development) {
  console.log = function () {}; // Disable console.log in non-development environments
}
export default class SystemSculptPlugin extends Plugin {
  settings: SystemSculptSettings;
  tasksModule: TasksModule;
  brainModule: BrainModule;
  templatesModule: TemplatesModule;
  dataModule: DataModule;
  recorderModule: RecorderModule;
  aboutModule: AboutModule;
  modelToggleStatusBarItem: HTMLElement | null = null;
  maxTokensToggleStatusBarItem: HTMLElement | null = null;
  taskToggleStatusBarItem: HTMLElement | null = null; // Add this line
  recorderToggleStatusBarItem: HTMLElement | null = null; // Add this line
  settingsTab: SystemSculptSettingTab;

  async onload() {
    await this.loadSettings();

    // Initialize modules with dependencies
    this.brainModule = this.initializeBrainModule();
    await this.brainModule.load();

    this.tasksModule = this.initializeTasksModule(this.brainModule);
    this.tasksModule.load();

    this.templatesModule = new TemplatesModule(this);
    this.templatesModule.load();

    this.dataModule = new DataModule(this);
    this.dataModule.load();

    const openAIService = AIService.getInstance(
      this.settings.openAIApiKey,
      this.settings
    );
    this.recorderModule = new RecorderModule(this, openAIService);
    this.recorderModule.load();

    this.aboutModule = new AboutModule(this);
    this.aboutModule.load();

    this.settingsTab = new SystemSculptSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Register the context menu item for .mp3 files using the new events module
    registerMp3ContextMenu(this, this.recorderModule);

    // Add command to open SystemSculpt settings
    this.addCommand({
      id: 'open-systemsculpt-settings',
      name: 'Open SystemSculpt settings',
      callback: () => {
        //@ts-ignore
        this.app.setting.open();
        //@ts-ignore
        this.app.setting.openTabById(this.settingsTab.id);
      },
    });
  }

  private initializeBrainModule(): BrainModule {
    const openAIService = AIService.getInstance(
      this.settings.openAIApiKey,
      this.settings
    );

    AIService.validateApiKey(this.settings.openAIApiKey).then(isValid => {
      if (isValid) {
        AIService.validateLocalEndpoint(this.settings.localEndpoint).then(
          isOnline => {
            openAIService.setOpenAIApiKeyValid(isOnline);
            openAIService.setLocalEndpointOnline(isOnline);
          }
        );
      } else {
        openAIService.setOpenAIApiKeyValid(false);
        openAIService.setLocalEndpointOnline(false);
      }
    });

    // Check if the API key and local endpoint are initially valid
    return new BrainModule(this, openAIService);
  }

  private initializeTasksModule(brainModule: BrainModule): TasksModule {
    return new TasksModule(this, brainModule);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
