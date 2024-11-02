import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";

export function renderWhisperProviderSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule
): void {
  new Setting(containerEl)
    .setName("Whisper Provider")
    .setDesc("Choose the provider for Whisper transcription")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("openai", "OpenAI Whisper")
        .addOption("groq", "Groq Whisper")
        .addOption("local", "Local Whisper")
        .setValue(plugin.settings.whisperProvider)
        .onChange(async (value: string) => {
          if (value === "openai" || value === "groq" || value === "local") {
            plugin.settings.whisperProvider = value;
            await plugin.saveSettings();
            plugin.settingsDisplay(containerEl);
          }
        });
    });

  if (plugin.settings.whisperProvider === "local") {
    new Setting(containerEl)
      .setName("Local Whisper Endpoint")
      .setDesc(
        "The endpoint URL for your local Whisper instance (e.g., http://127.0.0.1:8000)"
      )
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:8000")
          .setValue(plugin.settings.localWhisperEndpoint)
          .onChange(async (value) => {
            const sanitizedValue = value.replace("0.0.0.0", "127.0.0.1");
            plugin.settings.localWhisperEndpoint = sanitizedValue;
            await plugin.saveSettings();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default endpoint")
          .onClick(async () => {
            plugin.settings.localWhisperEndpoint = "http://127.0.0.1:8000";
            await plugin.saveSettings();
            plugin.settingsDisplay(containerEl);
          });
      });
  }
}
