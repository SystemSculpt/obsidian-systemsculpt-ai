import { Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';
import { DEFAULT_RECORDER_SETTINGS } from './RecorderSettings';

export function renderCustomWhisperPromptSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Enable Custom Transcription Prompt')
    .setDesc('Enable or disable the custom transcription prompt')
    .addToggle(toggle => {
      toggle
        .setValue(plugin.settings.enableCustomWhisperPrompt)
        .onChange(async value => {
          plugin.settings.enableCustomWhisperPrompt = value;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });

  if (plugin.settings.enableCustomWhisperPrompt) {
    new Setting(containerEl)
      .setName('Custom Whisper Prompt')
      .setDesc('Customize the prompt used for Whisper transcription')
      .addTextArea(text => {
        text
          .setPlaceholder('Enter custom prompt')
          .setValue(plugin.settings.customWhisperPrompt)
          .onChange(async value => {
            plugin.settings.customWhisperPrompt = value;
            await plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default custom Whisper prompt')
          .onClick(async () => {
            plugin.settings.customWhisperPrompt = DEFAULT_RECORDER_SETTINGS.customWhisperPrompt;
            await plugin.saveSettings();
            plugin.settingsDisplay(containerEl);
          });
      });
  }
}