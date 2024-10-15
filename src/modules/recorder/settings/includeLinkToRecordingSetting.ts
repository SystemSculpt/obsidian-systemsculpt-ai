import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

export function renderIncludeLinkToRecordingToggle(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Include link to recording")
    .setDesc("Include a link to the audio recording along with the transcription")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.includeLinkToRecording)
        .onChange(async (value: boolean) => {
          plugin.settings.includeLinkToRecording = value;
          await plugin.saveSettings();
        });
    });
}