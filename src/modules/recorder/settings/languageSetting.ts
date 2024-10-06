import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

const supportedLanguages: { [key: string]: string } = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  // Add more languages as needed
};

export function renderLanguageSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Transcription Language")
    .setDesc("Select the language of the audio for transcription")
    .addDropdown((dropdown) => {
      for (const [code, language] of Object.entries(supportedLanguages)) {
        dropdown.addOption(code, language);
      }
      dropdown
        .setValue(plugin.settings.language)
        .onChange(async (value: string) => {
          plugin.settings.language = value;
          await plugin.saveSettings();
        });
    });
}
