import SystemSculptPlugin from '../../main';
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from './settings/ChatSettings';
import { ChatSettingTab } from './settings/ChatSettingTab';
import { ChatView } from './ChatView';
import { TFile } from 'obsidian';

export class ChatModule {
  plugin: SystemSculptPlugin;
  settings: ChatSettings;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  async load() {
    console.log('ChatModule load method called');
    await this.loadSettings();

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

    this.plugin.app.workspace.revealLeaf(
      this.plugin.app.workspace.getLeavesOfType('chat-view')[0]
    );

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
  }

  updateTokenCount(chatView: ChatView) {
    chatView.updateTokenCount();
  }

  settingsDisplay(containerEl: HTMLElement): void {
    containerEl.empty();
    new ChatSettingTab(this.plugin.app, this, containerEl).display();
  }
}
