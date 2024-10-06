import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

export function renderMicrophoneDropdown(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Microphone")
    .setDesc("Select the microphone for recording")
    .addDropdown(async (dropdown) => {
      const microphones = await plugin.getMicrophones();
      microphones.forEach((microphone) => {
        dropdown.addOption(microphone.deviceId, microphone.label);
      });
      dropdown.setValue(plugin.settings.selectedMicrophone);
      dropdown.onChange(async (value) => {
        plugin.settings.selectedMicrophone = value;
        await plugin.saveSettings();
      });
    });
}
