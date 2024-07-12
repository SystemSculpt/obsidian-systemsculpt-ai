import { Plugin, TFile, Notice } from 'obsidian';
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
import { ChatModule } from './modules/chat/ChatModule';
import { ChatView, VIEW_TYPE_CHAT } from './modules/chat/ChatView';
import { AIService } from './api/AIService';
import { registerMp3ContextMenu } from './events';
import { checkForUpdate } from './modules/brain/functions/checkForUpdate';
import { listAllSettings } from './utils/listAllSettings';
import { logger } from './utils/logger';

export default class SystemSculptPlugin extends Plugin {
  settings: SystemSculptSettings;
  tasksModule: TasksModule;
  brainModule: BrainModule;
  templatesModule: TemplatesModule;
  dataModule: DataModule;
  recorderModule: RecorderModule;
  aboutModule: AboutModule;
  chatModule: ChatModule;
  modelToggleStatusBarItem: HTMLElement | null = null;
  maxTokensToggleStatusBarItem: HTMLElement | null = null;
  taskToggleStatusBarItem: HTMLElement | null = null;
  recorderToggleStatusBarItem: HTMLElement | null = null;
  chatToggleStatusBarItem: HTMLElement | null = null;
  settingsTab: SystemSculptSettingTab;

  async onload() {
    await this.loadSettings();

    // Initialize modules with dependencies
    this.brainModule = this.initializeBrainModule();
    this.tasksModule = this.initializeTasksModule(this.brainModule);
    this.templatesModule = new TemplatesModule(this);
    this.dataModule = new DataModule(this);
    this.recorderModule = new RecorderModule(
      this,
      this.brainModule.openAIService
    );
    this.aboutModule = new AboutModule(this);
    this.chatModule = new ChatModule(this);

    // Load modules
    const modules = [
      { name: 'Brain', load: () => this.brainModule.load() },
      { name: 'Tasks', load: () => this.tasksModule.load() },
      { name: 'Templates', load: () => this.templatesModule.load() },
      { name: 'Data', load: () => this.dataModule.load() },
      { name: 'Recorder', load: () => this.recorderModule.load() },
      { name: 'About', load: () => this.aboutModule.load() },
      { name: 'Chat', load: () => this.chatModule.load() },
    ];

    for (const module of modules) {
      try {
        await module.load();
        logger.log(`${module.name} module loaded successfully.`);
      } catch (error) {
        logger.error(`Failed to load ${module.name} module:`, error);
      }
    }

    this.settingsTab = new SystemSculptSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Register the context menu item for .mp3 files using the new events module
    registerMp3ContextMenu(this, this.recorderModule);

    // Add commands and event listeners
    this.addCommands();
    this.registerEvents();

    // Perform async checks
    this.performAsyncChecks();
  }

  private addCommands() {
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

    // Add command to reload Obsidian
    this.addCommand({
      id: 'reload-systemsculpt',
      name: 'Reload SystemSculpt',
      callback: () => {
        location.reload();
      },
    });

    // Add command to list all settings
    this.addCommand({
      id: 'list-all-settings',
      name: 'List all settings',
      callback: () => {
        const allSettings = listAllSettings(this);
        const settingsString = allSettings.join('\n');
        new Notice('All settings copied to clipboard');
        navigator.clipboard.writeText(settingsString);
        logger.log('All settings:', allSettings);
      },
    });
  }

  private registerEvents() {
    // Register file open event to load chat files into Chat View
    this.registerEvent(
      this.app.workspace.on('file-open', async file => {
        if (
          file &&
          file.path.startsWith('SystemSculpt/Chats') &&
          file instanceof TFile
        ) {
          let chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

          if (!chatLeaf) {
            //@ts-ignore
            chatLeaf = this.app.workspace.getRightLeaf(false);
            if (chatLeaf) {
              await chatLeaf.setViewState({ type: VIEW_TYPE_CHAT });
            }
          } else {
            this.app.workspace.revealLeaf(chatLeaf);
          }

          const chatView = chatLeaf.view as ChatView;
          chatView.setChatFile(file);
          await chatView.loadChatFile(file);
        }
      })
    );

    // Register file change event to update chat view when the chat file changes
    this.registerEvent(
      this.app.vault.on('modify', async file => {
        if (
          file instanceof TFile &&
          file.path.startsWith('SystemSculpt/Chats')
        ) {
          const chatLeaf =
            this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
          if (chatLeaf) {
            const chatView = chatLeaf.view as ChatView;
            await chatView.onFileChange(file);
          }
        }
      })
    );

    // Register file rename event to update chat view when the file is renamed
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (
          file instanceof TFile &&
          file.path.startsWith('SystemSculpt/Chats')
        ) {
          const chatLeaf =
            this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
          if (chatLeaf) {
            const chatView = chatLeaf.view as ChatView;
            await chatView.onFileRename(file, oldPath);
          }
        }
      })
    );
  }

  private performAsyncChecks() {
    setTimeout(async () => {
      await checkForUpdate(this.brainModule);
      setInterval(async () => {
        await checkForUpdate(this.brainModule);
      }, 1 * 60 * 60 * 1000); // recurring 1 hour check
    }, 5000);
  }

  private initializeBrainModule(): BrainModule {
    const openAIService = AIService.getInstance(
      this.settings.openAIApiKey,
      this.settings.groqAPIKey,
      this.settings.openRouterAPIKey,
      {
        openAIApiKey: this.settings.openAIApiKey,
        groqAPIKey: this.settings.groqAPIKey,
        openRouterAPIKey: this.settings.openRouterAPIKey,
        apiEndpoint: this.settings.apiEndpoint,
        localEndpoint: this.settings.localEndpoint,
        temperature: this.settings.temperature,
      }
    );

    // Check if the API key and local endpoint are initially valid
    return new BrainModule(this);
  }

  private initializeTasksModule(brainModule: BrainModule): TasksModule {
    return new TasksModule(this, brainModule);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.temperature === undefined) {
      this.settings.temperature = DEFAULT_SETTINGS.temperature;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
    // Add any additional cleanup logic here if needed
  }

  onClickEvent(element: HTMLElement, callback: () => void) {
    element.addEventListener('click', callback);
  }
}
