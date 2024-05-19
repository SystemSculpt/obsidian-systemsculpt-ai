import { Setting, TFolder } from 'obsidian';
import { ChatModule } from '../ChatModule';
import { DEFAULT_CHAT_SETTINGS } from './ChatSettings';
import { MultiSuggest } from '../../../utils/MultiSuggest';

export function renderChatsPathSetting(
  containerEl: HTMLElement,
  plugin: ChatModule
): void {
  new Setting(containerEl)
    .setName('Chats folder location')
    .setDesc('Path where the chats will be stored')
    .addText(text => {
      text
        .setPlaceholder('Enter path')
        .setValue(plugin.settings.chatsPath)
        .onChange(async value => {
          plugin.settings.chatsPath = value;
          await plugin.saveSettings();
        });

      const inputEl = text.inputEl;
      const suggestionContent = getFolderSuggestions(plugin);
      const onSelectCallback = (selectedPath: string) => {
        plugin.settings.chatsPath = selectedPath;
        text.setValue(selectedPath);
        plugin.saveSettings();
      };

      new MultiSuggest(
        inputEl,
        suggestionContent,
        onSelectCallback,
        plugin.plugin.app
      );
    })
    .addExtraButton(button => {
      button
        .setIcon('reset')
        .setTooltip('Reset to default path')
        .onClick(async () => {
          plugin.settings.chatsPath = DEFAULT_CHAT_SETTINGS.chatsPath;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}

function getFolderSuggestions(plugin: ChatModule): Set<string> {
  const folders = plugin.plugin.app.vault
    .getAllLoadedFiles()
    .filter(file => file instanceof TFolder) as TFolder[];
  const suggestionContent = new Set(folders.map(folder => folder.path));
  return suggestionContent;
}
