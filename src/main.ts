import { Plugin, TFile, Notice, WorkspaceLeaf, Menu } from 'obsidian';
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
import { registerMp3ContextMenu } from './events';
import { checkForUpdate } from './modules/brain/functions/checkForUpdate';
import { logger } from './utils/logger';

export default class SystemSculptPlugin extends Plugin {
  settings!: SystemSculptSettings;
  tasksModule!: TasksModule;
  brainModule!: BrainModule;
  templatesModule!: TemplatesModule;
  dataModule!: DataModule;
  recorderModule!: RecorderModule;
  aboutModule!: AboutModule;
  chatModule!: ChatModule;
  modelToggleStatusBarItem: HTMLElement | null = null;
  taskToggleStatusBarItem: HTMLElement | null = null;
  recorderToggleStatusBarItem: HTMLElement | null = null;
  chatToggleStatusBarItem: HTMLElement | null = null;
  settingsTab!: SystemSculptSettingTab;

  async onload() {
    await this.loadSettings();

    // Initialize modules with dependencies
    this.brainModule = new BrainModule(this);
    await this.brainModule.load();

    this.tasksModule = this.initializeTasksModule(this.brainModule);
    this.templatesModule = new TemplatesModule(this);
    this.dataModule = new DataModule(this);
    this.recorderModule = new RecorderModule(this, this.brainModule.AIService);
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

    // Register the context menu item for PDF extraction
    this.addCommand({
      id: 'extract-pdf',
      name: 'Extract PDF with SystemSculpt',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === 'pdf') {
          if (!checking) {
            this.chatModule.extractPDF(file);
          }
          return true;
        }
        return false;
      },
    });

    // Register the context menu item for PDF files
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'pdf') {
          menu.addItem((item) => {
            item
              .setTitle('Extract PDF with SystemSculpt')
              .setIcon('file-text')
              .onClick(() => this.chatModule.extractPDF(file));
          });
        }
      })
    );

    // Add commands and event listeners
    this.addCommands();
    this.registerEvents();

    // Perform async checks
    this.performAsyncChecks();

    // Ensure the views are initialized
    this.app.workspace.onLayoutReady(() => {
      this.initializeViews();
    });
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
  }

  private registerEvents() {
    // Register file open event to load chat files into Chat View
    this.registerEvent(
      this.app.workspace.on('file-open', async file => {
        if (
          file &&
          file instanceof TFile &&
          file.parent &&
          file.parent.path === this.chatModule.settings.chatsPath &&
          file.extension === 'md'
        ) {
          let chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

          if (!chatLeaf) {
            const newLeaf = this.app.workspace.getRightLeaf(false);
            if (newLeaf) {
              await newLeaf.setViewState({ type: VIEW_TYPE_CHAT });
              chatLeaf = newLeaf;
            } else {
              // Handle the case where a new leaf couldn't be created
              return;
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

  private initializeViews() {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).length === 0) {
      this.app.workspace.getRightLeaf(false)?.setViewState({
        type: VIEW_TYPE_CHAT,
        active: false,
      }) ??
        this.app.workspace.getLeaf(true).setViewState({
          type: VIEW_TYPE_CHAT,
          active: false,
        });
    }
  }

  onClickEvent(element: HTMLElement, callback: () => void) {
    element.addEventListener('click', callback);
  }
}