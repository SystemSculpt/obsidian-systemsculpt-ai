import { Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';

export function renderWhisperProviderSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName('Whisper Provider')
    .setDesc('Choose the provider for Whisper transcription')
    .addDropdown(dropdown => {
      dropdown
        .addOption('openai', 'OpenAI Whisper')
        .addOption('groq', 'Groq Whisper')
        .setValue(plugin.settings.whisperProvider)
        .onChange(async (value: string) => {
          if (value === 'openai' || value === 'groq') {
            plugin.settings.whisperProvider = value;
            await plugin.saveSettings();
          }
        });
    });
}
