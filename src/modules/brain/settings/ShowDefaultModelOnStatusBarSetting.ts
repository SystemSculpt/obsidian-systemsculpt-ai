import { Setting } from "obsidian";
import { BrainModule } from "../BrainModule";

export function renderShowDefaultModelOnStatusBarSetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
): void {
  new Setting(containerEl)
    .setName("Show default model on status bar")
    .setDesc("Toggle the display of default model on the status bar")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.showDefaultModelOnStatusBar)
        .onChange(async (value) => {
          plugin.settings.showDefaultModelOnStatusBar = value;
          if (value && plugin.plugin.modelToggleStatusBarItem) {
            const modelName = await plugin.getCurrentModelShortName();
            plugin.plugin.modelToggleStatusBarItem.setText(
              `Model: ${modelName}`,
            );
          } else if (plugin.plugin.modelToggleStatusBarItem) {
            plugin.plugin.modelToggleStatusBarItem.setText("");
          }
          await plugin.saveSettings();
        });
    });
}
