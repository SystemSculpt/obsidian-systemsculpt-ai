import SystemSculptPlugin from '../../main';
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from './settings/ChatSettings';
import { ChatSettingTab } from './settings/ChatSettingTab';
import { ChatView } from './ChatView';
import { ChatFileManager } from './ChatFileManager';
import { TFile } from 'obsidian';

export class ChatModule {
  plugin: SystemSculptPlugin;
  settings: ChatSettings;
  chatFileManager: ChatFileManager;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_CHAT_SETTINGS;
  }

  async load() {
    console.log('ChatModule load method called');
    await this.loadSettings();

    this.chatFileManager = new ChatFileManager(
      this.plugin.app,
      this.settings.chatsPath
    );

    this.plugin.addRibbonIcon(
      'message-square-plus',
      'New SystemSculpt AI Chat',
      () => {
        this.openNewChat();
      }
    );

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
          .getLeavesOfType('chat-view')
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
            this.plugin.app.workspace.getLeavesOfType('chat-view')[0];
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

    if (this.settings.lastOpenedChatPath) {
      const file = this.plugin.app.vault.getAbstractFileByPath(
        this.settings.lastOpenedChatPath
      );
      if (file instanceof TFile) {
        this.openChatWithFile(file);
      }
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
    const leaves = this.plugin.app.workspace.getLeavesOfType('chat-view');
    let chatLeaf;

    if (leaves.length > 0) {
      chatLeaf = leaves[0];
      chatLeaf.detach(); // Detach the existing leaf to reset it
    }

    // Ensure the sidebar is expanded
    const rightSplit = this.plugin.app.workspace.rightSplit;
    if (rightSplit && rightSplit.collapsed) {
      rightSplit.expand();
    }

    chatLeaf = this.plugin.app.workspace.getRightLeaf(false);
    if (chatLeaf) {
      chatLeaf.setViewState({
        type: 'chat-view',
        active: true,
      });
    }

    if (this.plugin.app.workspace.getLeavesOfType('chat-view').length > 0) {
      const chatLeaf =
        this.plugin.app.workspace.getLeavesOfType('chat-view')[0];
      if (chatLeaf) {
        this.plugin.app.workspace.revealLeaf(chatLeaf);
      }
    }

    // Add a slight delay to ensure the DOM is fully updated
    setTimeout(() => {
      const chatView = this.plugin.app.workspace.getLeavesOfType('chat-view')[0]
        .view as ChatView;
      chatView.focusInput();
      this.updateTokenCount(chatView); // Ensure token count is updated
    }, 100); // 100ms delay
  }

  openChatWithFile(file: TFile) {
    const leaves = this.plugin.app.workspace.getLeavesOfType('chat-view');
    if (leaves.length === 0) {
      const rightLeaf = this.plugin.app.workspace.getRightLeaf(false);
      if (rightLeaf) {
        rightLeaf.setViewState({
          type: 'chat-view',
          active: true,
        });
      }
    }
    const chatView = this.plugin.app.workspace.getLeavesOfType('chat-view')[0]
      .view as ChatView;
    chatView.setChatFile(file);
    this.plugin.app.workspace.revealLeaf(
      this.plugin.app.workspace.getLeavesOfType('chat-view')[0]
    );

    // Add a slight delay to ensure the DOM is fully updated
    setTimeout(() => {
      chatView.focusInput();
      this.updateTokenCount(chatView); // Ensure token count is updated
    }, 100); // 100ms delay

    this.saveLastOpenedChat(file.path);
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
}
