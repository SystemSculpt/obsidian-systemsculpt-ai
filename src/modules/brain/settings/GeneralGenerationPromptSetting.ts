import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { DEFAULT_BRAIN_SETTINGS } from './BrainSettings';

export function renderGeneralGenerationPromptSetting(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  new Setting(containerEl)
    .setName('General Generation Prompt')
    .setDesc(
      'The prompt used for general note continuation. Use {{context}} as a placeholder for the note content.'
    )
    .addTextArea(text => {
      text
        .setPlaceholder('Enter general generation prompt')
        .setValue(plugin.settings.generalGenerationPrompt)
        .onChange(async (newValue: string) => {
          plugin.settings.generalGenerationPrompt = newValue;
          await plugin.saveSettings();
        });
      text.inputEl.rows = 10;
      text.inputEl.cols = 50;
    })
    .addExtraButton(button => {
      button
        .setIcon('reset')
        .setTooltip('Reset to default general generation prompt')
        .onClick(async () => {
          plugin.settings.generalGenerationPrompt =
            DEFAULT_BRAIN_SETTINGS.generalGenerationPrompt;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}
