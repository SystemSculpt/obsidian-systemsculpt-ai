import SystemSculptPlugin from '../../main';
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from './settings/ChatSettings';
import { ChatSettingTab } from './settings/ChatSettingTab';
import { ChatView, VIEW_TYPE_CHAT } from './ChatView';
import { ChatFileManager } from './ChatFileManager';
import { TFile, WorkspaceLeaf } from 'obsidian';
import { logger } from '../../utils/logger';
import { DocumentExtractor } from './DocumentExtractor';
import { Notice } from 'obsidian';
import { createHash } from 'crypto';
import { ContextFileManager } from './ContextFileManager';
import { RecorderModule } from '../recorder/RecorderModule';

export class ChatModule {
  plugin: SystemSculptPlugin;
  settings: ChatSettings;
  chatFileManager: ChatFileManager;
  documentExtractor: DocumentExtractor;
  recorderModule: RecorderModule;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_CHAT_SETTINGS;
    this.chatFileManager = new ChatFileManager(this.plugin.app, this);
    this.documentExtractor = new DocumentExtractor(this, this.plugin.app);
    this.recorderModule = plugin.recorderModule;
  }

  async load() {
    logger.log('ChatModule load method called');
    await this.loadSettings();

    this.chatFileManager = new ChatFileManager(this.plugin.app, this);

    // Ensure attachments directory exists
    await this.plugin.app.vault.createFolder(this.settings.attachmentsPath).catch(() => {});

    this.plugin.addRibbonIcon(
      'message-square-plus',
      'New SystemSculpt AI Chat',
      () => {
        this.openNewChat();
      }
    );

    // Reinitialize existing ChatViews
    this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).forEach(leaf => {
      const view = leaf.view as ChatView;
      if (view instanceof ChatView) {
        view.setChatModule(this);
      }
    });

    this.plugin.addCommand({
      id: 'open-new-chat',
      name: 'Open New Chat',
      callback: () => this.openNewChat(),
    });

    this.plugin.addCommand({
      id: 'open-chat-with-file',
      name: 'Open Chat with Selected File',
      checkCallback: (checking: boolean) => {
        const file = this.plugin.app.workspace.getActiveFile();
        if (file && file.extension === 'md' && this.chatFileManager.isDirectlyInChatsDirectory(file)) {
          if (!checking) {
            this.openChatWithFile(file);
          }
          return true;
        }
        return false;
      },
    });

    this.plugin.addCommand({
      id: 'open-chat-actions',
      name: 'Open Chat Actions',
      callback: () => {
        let chatView = this.plugin.app.workspace
          .getLeavesOfType(VIEW_TYPE_CHAT)
          .map(leaf => leaf.view as ChatView)
          .find(view => view instanceof ChatView);

        if (!chatView) {
          // If no chat view is open, open a new one
          this.openNewChat();

          // Wait for the new chat view to be created
          setTimeout(() => {
            // @ts-ignore
            chatView = this.plugin.app.workspace.getActiveViewOfType(ChatView);
            if (chatView) {
              chatView.showActionsModal();
            }
          }, 300);
        } else {
          // If a chat view is already open, switch to it and show the actions modal
          const leaf =
            this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
          this.plugin.app.workspace.revealLeaf(leaf);
          chatView.showActionsModal();
        }
      },
    });

    // Add status bar item for chat
    if (
      this.settings.showChatButtonOnStatusBar &&
      !this.plugin.chatToggleStatusBarItem
    ) {
      this.plugin.chatToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.chatToggleStatusBarItem.setText('C'); // Set text to "C"
      this.plugin.chatToggleStatusBarItem.addClass('chat-toggle-button');
    }

    if (this.plugin.chatToggleStatusBarItem) {
      this.plugin.chatToggleStatusBarItem.onClickEvent(() => {
        this.openNewChat();
      });
    }

    this.registerExtractDocumentCommand();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_CHAT_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }

  openNewChat() {
    // Ensure the sidebar is expanded
    const rightSplit = this.plugin.app.workspace.rightSplit;
    if (rightSplit && rightSplit.collapsed) {
      rightSplit.expand();
    }

    // Check for an existing chat view leaf
    let chatLeaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

    if (!chatLeaf) {
      // If no chat view exists, create a new leaf
      chatLeaf =
        this.plugin.app.workspace.getRightLeaf(false) ||
        this.plugin.app.workspace.getLeaf('tab');
    }

    if (chatLeaf) {
      chatLeaf.setViewState({
        type: VIEW_TYPE_CHAT,
        active: true,
      });
    }

    this.plugin.app.workspace.revealLeaf(chatLeaf);

    // Use requestAnimationFrame for smoother UI updates
    requestAnimationFrame(() => {
      const chatView = chatLeaf.view as ChatView;
      if (chatView) {
        chatView.initializeChatView(); // This now includes updating token count and cost
        chatView.clearChatView(); // Clear the chat view visually
        chatView.focusInput();
      }
    });
  }

  openChatWithFile(file: TFile) {
    if (!this.chatFileManager.isDirectlyInChatsDirectory(file)) {
      new Notice("This file is not a chat history file.");
      return;
    }

    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    let chatLeaf: WorkspaceLeaf | null;

    if (leaves.length === 0) {
      chatLeaf = this.plugin.app.workspace.getRightLeaf(false);
      if (!chatLeaf) {
        chatLeaf = this.plugin.app.workspace.getLeaf('tab');
      }
    } else {
      chatLeaf = leaves[0];
    }

    if (chatLeaf) {
      chatLeaf.setViewState({
        type: VIEW_TYPE_CHAT,
        active: true,
      });

      this.plugin.app.workspace.revealLeaf(chatLeaf);
      const chatView = new ChatView(chatLeaf, this.plugin.brainModule, this);
      chatLeaf.view = chatView;

      if (chatView instanceof ChatView) {
        chatView.setChatFile(file);
        chatView.loadChatFile(file);

        // Add a slight delay to ensure the DOM is fully updated
        setTimeout(() => {
          chatView.focusInput();
          this.updateTokenCount(chatView);
        }, 100);
      }

      this.saveLastOpenedChat(file.path);
    } else {
      // Handle the case where we couldn't create a chat leaf
      console.error('Failed to create or find a chat leaf');
    }
  }

  async saveLastOpenedChat(filePath: string) {
    this.settings.lastOpenedChatPath = filePath;
    await this.saveSettings();
  }

  updateTokenCount(chatView: ChatView) {
    chatView.updateTokenCount();
  }

  settingsDisplay(containerEl: HTMLElement): void {
    containerEl.empty();
    new ChatSettingTab(this.plugin.app, this, containerEl).display();
  }

  activateView() {
    this.openNewChat();
  }

  async calculateMD5(file: TFile): Promise<string> {
    const arrayBuffer = await this.plugin.app.vault.readBinary(file);
    const hash = createHash('md5');
    hash.update(Buffer.from(arrayBuffer));
    return hash.digest('hex');
  }

  async extractDocument(file: TFile) {
    const documentExtractor = new DocumentExtractor(this, this.plugin.app);
    const extractedContent = await documentExtractor.extractDocument(file);
    const contextFileManager = new ContextFileManager(this.plugin.app, this);
    await contextFileManager.saveExtractedContent(file, extractedContent);
  }

  registerExtractDocumentCommand() {
    const extractDocument = (file: TFile) => {
      if (file && ['pdf', 'docx', 'pptx'].includes(file.extension.toLowerCase())) {
        this.openChatAndAddFile(file);
      }
    };

    // Register the context menu item
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && ['pdf', 'docx', 'pptx'].includes(file.extension.toLowerCase())) {
          menu.addItem((item) => {
            item
              .setTitle('Extract Document with SystemSculpt')
              .setIcon('file-text')
              .onClick(() => extractDocument(file));
          });
        }
      })
    );
  }

  private async openChatAndAddFile(file: TFile) {
    const chatLeaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0] || 
                     this.plugin.app.workspace.getRightLeaf(false);

    if (chatLeaf) {
      await chatLeaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      this.plugin.app.workspace.revealLeaf(chatLeaf);
      const chatView = chatLeaf.view as ChatView;

      if (chatView instanceof ChatView) {
        await chatView.addFileToContext(file);
      } else {
        new Notice('Failed to open chat view');
      }
    } else {
      new Notice('Failed to create a new chat view');
    }
  }
}