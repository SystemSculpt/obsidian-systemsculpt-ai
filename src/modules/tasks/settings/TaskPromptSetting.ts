import { Setting } from 'obsidian';
import { TasksModule } from '../TasksModule';
import { DEFAULT_TASKS_SETTINGS } from './TasksSettings';

export function renderTaskPromptSetting(
  containerEl: HTMLElement,
  plugin: TasksModule
): void {
  new Setting(containerEl)
    .setName('Task Prompt')
    .setDesc(
      'The prompt used when generating tasks. Use {task} as a placeholder for the task description.'
    )
    .addTextArea(text => {
      text
        .setPlaceholder('Enter task prompt')
        .setValue(plugin.settings.defaultTaskPrompt)
        .onChange(async (newValue: string) => {
          plugin.settings.defaultTaskPrompt = newValue;
          await plugin.saveSettings();
        });
      text.inputEl.rows = 3;
      text.inputEl.cols = 50;
    })
    .addExtraButton(button => {
      button
        .setIcon('reset')
        .setTooltip('Reset to default task prompt')
        .onClick(async () => {
          plugin.settings.defaultTaskPrompt =
            DEFAULT_TASKS_SETTINGS.defaultTaskPrompt;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}
