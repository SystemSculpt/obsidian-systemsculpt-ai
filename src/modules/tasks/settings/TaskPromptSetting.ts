import { Setting } from "obsidian";
import { TasksModule } from "../TasksModule";
import { DEFAULT_TASKS_SETTINGS } from "./TasksSettings";

export function renderTaskPromptSetting(
  containerEl: HTMLElement,
  plugin: TasksModule
): void {
  new Setting(containerEl)
    .setName("Task prompt")
    .setDesc("The prompt used when generating tasks.")
    .addTextArea((text) => {
      text
        .setPlaceholder("Enter task prompt")
        .setValue(plugin.settings.defaultTaskPrompt)
        .onChange(async (newValue: string) => {
          plugin.settings.defaultTaskPrompt = newValue;
          await plugin.saveSettings();
        });
      text.inputEl.rows = 3;
      text.inputEl.cols = 50;
    })
    .addExtraButton((button) => {
      button
        .setIcon("reset")
        .setTooltip("Reset to default task prompt")
        .onClick(async () => {
          plugin.settings.defaultTaskPrompt =
            DEFAULT_TASKS_SETTINGS.defaultTaskPrompt;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
      const infoBoxEl = containerEl.createDiv("systemsculpt-info-box");
      infoBoxEl.createEl("p", {
        text: "This is the system prompt that runs alongside whatever task you input. It is used to generate the actual tasks. If you prefer a different task structure, this is where you would input your custom instructions.",
      });
    });
}
