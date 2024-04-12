import { Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';

export function renderSaveAudioClipsToggle(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Save audio clips')
    .setDesc('Save audio clips after transcription')
    .addToggle(toggle => {
      toggle
        .setValue(plugin.settings.saveAudioClips)
        .onChange(async (value: boolean) => {
          plugin.settings.saveAudioClips = value;
          await plugin.saveSettings();
        });
    });
}
