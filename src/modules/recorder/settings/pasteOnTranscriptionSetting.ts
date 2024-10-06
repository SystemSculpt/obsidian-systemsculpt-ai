import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

export function renderPasteOnTranscriptionToggle(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Paste into active note")
    .setDesc(
      "Automatically paste the transcription into the active note at the cursor position",
    )
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.pasteIntoActiveNote)
        .onChange(async (value: boolean) => {
          plugin.settings.pasteIntoActiveNote = value;
          await plugin.saveSettings();
        });
    });
}
