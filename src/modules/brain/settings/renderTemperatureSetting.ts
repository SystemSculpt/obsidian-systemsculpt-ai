import { Setting } from "obsidian";
import { BrainModule } from "../BrainModule";
import { DEFAULT_BRAIN_SETTINGS } from "./BrainSettings";

export function renderTemperatureSetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
): void {
  new Setting(containerEl)
    .setName("Temperature")
    .setDesc("Set the temperature for the AI model (0.0 to 2.0)")
    .addSlider((slider) => {
      slider
        .setLimits(0, 2, 0.1)
        .setValue(plugin.settings.temperature)
        .setDynamicTooltip()
        .onChange(async (value: number) => {
          plugin.settings.temperature = value;
          await plugin.saveSettings();
          plugin.refreshAIService();
        });
    })
    .addExtraButton((button) => {
      button
        .setIcon("reset")
        .setTooltip("Reset to default temperature")
        .onClick(async () => {
          plugin.settings.temperature = DEFAULT_BRAIN_SETTINGS.temperature;
          await plugin.saveSettings();
          plugin.refreshAIService();
          plugin.settingsDisplay(containerEl);
        });
    });
}
