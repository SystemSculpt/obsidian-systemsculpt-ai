import { Setting } from "obsidian";
import { ChatModule } from "../ChatModule";
import { DEFAULT_CHAT_SETTINGS } from "./ChatSettings";

export function renderSystemPromptSetting(
  containerEl: HTMLElement,
  module: ChatModule,
): void {
  new Setting(containerEl)
    .setName("System Prompt")
    .setDesc("The system prompt used for the chat.")
    .addTextArea((text) => {
      text
        .setPlaceholder("Enter system prompt")
        .setValue(module.settings.systemPrompt)
        .onChange(async (newValue: string) => {
          module.settings.systemPrompt = newValue;
          await module.saveSettings();
        });
      text.inputEl.rows = 10;
      text.inputEl.cols = 50;
    })
    .addExtraButton((button) => {
      button
        .setIcon("reset")
        .setTooltip("Reset to default system prompt")
        .onClick(async () => {
          module.settings.systemPrompt = DEFAULT_CHAT_SETTINGS.systemPrompt;
          await module.saveSettings();
          module.settingsDisplay(containerEl);
        });
    });
}
