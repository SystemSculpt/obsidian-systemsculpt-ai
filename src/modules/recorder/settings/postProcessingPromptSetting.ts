import { Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';
import { DEFAULT_RECORDER_SETTINGS } from './RecorderSettings';

export function renderPostProcessingPromptSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Enable Post-Processing Prompt')
    .setDesc('Enable or disable the post-processing prompt for transcriptions')
    .addToggle(toggle => {
      toggle
        .setValue(plugin.settings.enablePostProcessingPrompt)
        .onChange(async value => {
          plugin.settings.enablePostProcessingPrompt = value;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });

  if (plugin.settings.enablePostProcessingPrompt) {
    new Setting(containerEl)
      .setName('Post-Processing Prompt')
      .setDesc('Customize the prompt used for post-processing transcriptions')
      .addTextArea(text => {
        text
          .setPlaceholder('Enter post-processing prompt')
          .setValue(plugin.settings.postProcessingPrompt)
          .onChange(async value => {
            plugin.settings.postProcessingPrompt = value;
            await plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default post-processing prompt')
          .onClick(async () => {
            plugin.settings.postProcessingPrompt = DEFAULT_RECORDER_SETTINGS.postProcessingPrompt;
            await plugin.saveSettings();
            plugin.settingsDisplay(containerEl);
          });
      });
  }
}