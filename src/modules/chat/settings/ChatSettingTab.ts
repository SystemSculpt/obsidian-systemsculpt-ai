import { App, PluginSettingTab, Setting } from 'obsidian';
import { ChatModule } from '../ChatModule';
import { renderChatsPathSetting } from './ChatsPathSetting';
import { renderSystemPromptSetting } from './SystemPromptSetting';

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatModule;

  constructor(app: App, plugin: ChatModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName('Chat Settings').setHeading();
    containerEl.createEl('p', {
      text: 'Configure your chat settings, including chat history limits, system prompts, and chat storage paths.',
    });

    renderChatsPathSetting(containerEl, this.plugin);
    renderSystemPromptSetting(containerEl, this.plugin);

    new Setting(containerEl)
      .setName('Show chat button on status bar')
      .setDesc('Toggle the display of chat button on the status bar')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showChatButtonOnStatusBar)
          .onChange(async value => {
            this.plugin.settings.showChatButtonOnStatusBar = value;
            if (!this.plugin.plugin.chatToggleStatusBarItem) {
              this.plugin.plugin.chatToggleStatusBarItem =
                this.plugin.plugin.addStatusBarItem();
              this.plugin.plugin.chatToggleStatusBarItem.setText('C');
              this.plugin.plugin.chatToggleStatusBarItem.style.display =
                'inline-block';
              this.plugin.plugin.chatToggleStatusBarItem.addClass(
                'chat-toggle-button'
              );
              this.plugin.plugin.chatToggleStatusBarItem.onClickEvent(() => {
                this.plugin.openNewChat();
              });
            }

            if (value) {
              this.plugin.plugin.chatToggleStatusBarItem.style.display =
                'inline-block';
            } else {
              this.plugin.plugin.chatToggleStatusBarItem.style.display = 'none';
            }
            await this.plugin.saveSettings();
          });
      });
  }
}
