import { Setting } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { DEFAULT_TEMPLATES_SETTINGS } from './TemplatesSettings';

export function renderBlankTemplatePromptSetting(
  containerEl: HTMLElement,
  plugin: TemplatesModule
): void {
  new Setting(containerEl)
    .setName('Blank Template Prompt')
    .setDesc('The system prompt used for the Blank Template.')
    .addTextArea(text => {
      text
        .setPlaceholder('Enter blank template prompt')
        .setValue(plugin.settings.blankTemplatePrompt)
        .onChange(async (newValue: string) => {
          plugin.settings.blankTemplatePrompt = newValue;
          await plugin.saveSettings();
        });
      text.inputEl.rows = 10;
      text.inputEl.cols = 50;
    })
    .addExtraButton(button => {
      button
        .setIcon('reset')
        .setTooltip('Reset to default blank template prompt')
        .onClick(async () => {
          plugin.settings.blankTemplatePrompt =
            DEFAULT_TEMPLATES_SETTINGS.blankTemplatePrompt;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}
