import { Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';
import { DEFAULT_RECORDER_SETTINGS } from './RecorderSettings';

export function renderRecordingsPathSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Recordings Path')
    .setDesc('Path where the recordings will be stored')
    .addText(text => {
      text
        .setPlaceholder('Enter path')
        .setValue(plugin.settings.recordingsPath)
        .onChange(async value => {
          plugin.settings.recordingsPath = value;
          await plugin.saveSettings();
        });
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
