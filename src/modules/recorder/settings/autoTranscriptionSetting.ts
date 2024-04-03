import { Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';

export function renderAutoTranscriptionToggle(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Auto-Transcription')
    .setDesc('Automatically transcribe recordings')
    .addToggle(toggle => {
      toggle
        .setValue(plugin.settings.autoTranscriptionEnabled)
        .onChange(async (value: boolean) => {
          plugin.settings.autoTranscriptionEnabled = value;
          await plugin.saveSettings();
        });
    });
}
