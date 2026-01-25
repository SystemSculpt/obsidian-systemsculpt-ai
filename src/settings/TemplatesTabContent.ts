import { Setting } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";

export function displayTemplatesTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty(); // Ensure clean slate
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "templates";
    }
    const { plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Templates Settings" });

    new Setting(containerEl)
        .setName("Enable Template Hotkey")
        .setDesc("Enable the template hotkey to quickly access system prompts")
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.enableTemplateHotkey)
                .onChange(async (value) => {
                    await plugin.getSettingsManager().updateSettings({ enableTemplateHotkey: value });
                })
        );

    new Setting(containerEl)
        .setName("Template Hotkey")
        .setDesc("Set the hotkey that will trigger the system prompts list when typed at the beginning of a new line")
        .addText((text) =>
            text
                .setPlaceholder("/")
                .setValue(plugin.settings.templateHotkey)
                .onChange(async (value) => {
                    // Only allow a single character
                    if (value.length > 1) {
                        value = value.charAt(0);
                        text.setValue(value);
                    }

                    await plugin.getSettingsManager().updateSettings({ templateHotkey: value });
                })
        );

    containerEl.createEl("div", {
        text: "When the template hotkey is pressed at the beginning of a new line, a list of all system prompts in your system prompts directory will be shown.",
        cls: "setting-item-description",
    });
}
