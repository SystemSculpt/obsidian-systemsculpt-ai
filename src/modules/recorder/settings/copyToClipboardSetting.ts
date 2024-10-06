import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

export function renderCopyToClipboardToggle(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Copy to clipboard")
    .setDesc("Automatically copy the transcription to the clipboard")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.copyToClipboard)
        .onChange(async (value: boolean) => {
          plugin.settings.copyToClipboard = value;
          await plugin.saveSettings();
        });
    });
}
