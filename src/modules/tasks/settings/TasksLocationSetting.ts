import { Setting, TFile } from 'obsidian';
import { TasksModule } from '../TasksModule';
import { DEFAULT_TASKS_SETTINGS } from './TasksSettings';
import { MultiSuggest } from '../../../utils/MultiSuggest';

export function renderTasksLocationSetting(
  containerEl: HTMLElement,
  plugin: TasksModule
): void {
  new Setting(containerEl)
    .setName('Tasks location')
    .setDesc('The file path where tasks will be stored')
    .addText(text => {
      text
        .setPlaceholder('Enter tasks location')
        .setValue(plugin.settings.tasksLocation)
        .onChange(async (newValue: string) => {
          plugin.settings.tasksLocation = newValue;
          await plugin.saveSettings();
        });

      // Add file suggestion
      const inputEl = text.inputEl;
      const suggestionContent = getFileSuggestions(plugin);
      const onSelectCallback = (selectedPath: string) => {
        plugin.settings.tasksLocation = selectedPath;
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
        .setTooltip('Reset to default tasks location')
        .onClick(async () => {
          plugin.settings.tasksLocation = DEFAULT_TASKS_SETTINGS.tasksLocation;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}

function getFileSuggestions(plugin: TasksModule): Set<string> {
  const files = plugin.plugin.app.vault.getFiles();
  const mdFiles = files.filter(file => file.path.endsWith('.md'));
  const suggestionContent = new Set(mdFiles.map(file => file.path));
  return suggestionContent;
}
