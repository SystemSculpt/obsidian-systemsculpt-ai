import { Setting, TFolder } from 'obsidian';
import { RecorderModule } from '../RecorderModule';
import { DEFAULT_RECORDER_SETTINGS } from './RecorderSettings';
import { MultiSuggest } from '../../../utils/MultiSuggest';

export function renderRecordingsPathSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Recordings path')
    .setDesc('Path where the recordings will be stored')
    .addText(text => {
      text
        .setPlaceholder('Enter path')
        .setValue(plugin.settings.recordingsPath)
        .onChange(async value => {
          plugin.settings.recordingsPath = value;
          await plugin.saveSettings();
        });

      // Add folder suggestion
      const inputEl = text.inputEl;
      const suggestionContent = getFolderSuggestions(plugin);
      const onSelectCallback = (selectedPath: string) => {
        plugin.settings.recordingsPath = selectedPath;
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
          plugin.settings.recordingsPath =
            DEFAULT_RECORDER_SETTINGS.recordingsPath;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}

function getFolderSuggestions(plugin: RecorderModule): Set<string> {
  const folders = plugin.plugin.app.vault
    .getAllLoadedFiles()
    .filter(file => file instanceof TFolder) as TFolder[];
  const suggestionContent = new Set(folders.map(folder => folder.path));
  return suggestionContent;
}
