import SystemSculptPlugin from '../../main';
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from './settings/ChatSettings';
import { ChatSettingTab } from './settings/ChatSettingTab';
import { ChatView, VIEW_TYPE_CHAT } from './ChatView';
import { ChatFileManager } from './ChatFileManager';
import { TFile, WorkspaceLeaf } from 'obsidian';
import { logger } from '../../utils/logger';

export class ChatModule {
  plugin: SystemSculptPlugin;
  settings: ChatSettings;
  chatFileManager: ChatFileManager;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_CHAT_SETTINGS;
    this.chatFileManager = new ChatFileManager(this.plugin.app, this);
  }

  async load() {
    logger.log('ChatModule load method called');
    await this.loadSettings();

    this.chatFileManager = new ChatFileManager(this.plugin.app, this);

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
        if (file && file.path.startsWith(this.settings.chatsPath)) {
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
        chatView.initializeChatView(); // Reset the chat view
        chatView.clearChatView(); // Clear the chat view visually
        chatView.focusInput();
        this.updateTokenCount(chatView);
      }
    });
  }

  openChatWithFile(file: TFile) {
    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    let chatLeaf: WorkspaceLeaf | null;

    if (leaves.length === 0) {
      chatLeaf = this.plugin.app.workspace.getRightLeaf(false);
      if (!chatLeaf) {
        // If getRightLeaf returns null, create a new leaf
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
      const chatView = chatLeaf.view as ChatView;
      if (chatView && chatView instanceof ChatView) {
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
}
