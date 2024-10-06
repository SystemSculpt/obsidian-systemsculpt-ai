import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

export function renderSaveTranscriptionToFileToggle(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Save transcription to file")
    .setDesc("Automatically save transcriptions to separate files")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.saveTranscriptionToFile)
        .onChange(async (value: boolean) => {
          plugin.settings.saveTranscriptionToFile = value;
          await plugin.saveSettings();
        });
    });
}
