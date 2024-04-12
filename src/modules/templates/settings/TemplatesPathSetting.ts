import { Setting, TFolder } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { DEFAULT_TEMPLATES_SETTINGS } from '../settings/TemplatesSettings';
import { MultiSuggest } from '../../../utils/MultiSuggest';

export function renderTemplatesPathSetting(
  containerEl: HTMLElement,
  plugin: TemplatesModule
): void {
  new Setting(containerEl)
    .setName('Template folder location')
    .setDesc('Path where the templates will be stored')
    .addText(text => {
      text
        .setPlaceholder('Enter path')
        .setValue(plugin.settings.templatesPath)
        .onChange(async value => {
          plugin.settings.templatesPath = value;
          await plugin.saveSettings();
        });

      // Add folder suggestion
      const inputEl = text.inputEl;
      const suggestionContent = getFolderSuggestions(plugin);
      const onSelectCallback = (selectedPath: string) => {
        plugin.settings.templatesPath = selectedPath;
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
          plugin.settings.templatesPath =
            DEFAULT_TEMPLATES_SETTINGS.templatesPath;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}

function getFolderSuggestions(plugin: TemplatesModule): Set<string> {
  const folders = plugin.plugin.app.vault
    .getAllLoadedFiles()
    .filter(file => file instanceof TFolder) as TFolder[];
  const suggestionContent = new Set(folders.map(folder => folder.path));
  return suggestionContent;
}
