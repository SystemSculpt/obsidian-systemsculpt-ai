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
  }
}
