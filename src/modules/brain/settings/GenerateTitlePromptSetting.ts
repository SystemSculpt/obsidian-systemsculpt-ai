import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { DEFAULT_BRAIN_SETTINGS } from './BrainSettings';

export function renderGenerateTitlePrompt(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  new Setting(containerEl)
    .setName('Generate title prompt')
    .setDesc(
      'The prompt used when generating titles for notes. Use {note} as a placeholder for the note content.'
    )
    .addTextArea(text => {
      text
        .setPlaceholder('Enter generate title prompt')
        .setValue(plugin.settings.generateTitlePrompt)
        .onChange(async (newValue: string) => {
          plugin.settings.generateTitlePrompt = newValue;
          await plugin.saveSettings();
        });
      text.inputEl.rows = 3;
      text.inputEl.cols = 50;
    })
    .addExtraButton(button => {
      button
        .setIcon('reset')
        .setTooltip('Reset to default generate title prompt')
        .onClick(async () => {
          plugin.settings.generateTitlePrompt =
            DEFAULT_BRAIN_SETTINGS.generateTitlePrompt;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}
