import { Notice, Setting, ToggleComponent } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";

export async function displayChatTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty();
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "chat";
    }
    const { plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Chat settings" });

    containerEl.createEl('p', {
        text: 'SystemSculpt chat works the same way across desktop and mobile. Use this tab for chat preferences and display choices.',
        cls: 'setting-item-description'
    });

    const normalizeDefaultChatTag = (value: string): string => value.trim().replace(/^#+/, "");

    new Setting(containerEl)
        .setName("Default chat tag")
        .setDesc("Optional. Adds this tag to new chat history notes (frontmatter `tags`).")
        .addText((text) => {
            text
                .setPlaceholder("ai-chat")
                .setValue(plugin.settings.defaultChatTag || "")
                .onChange(async (value) => {
                    const normalized = normalizeDefaultChatTag(value);
                    await plugin.getSettingsManager().updateSettings({ defaultChatTag: normalized });
                });
        });

// --- Default Chat Font Size ---
new Setting(containerEl)
    .setName("Default Chat Font Size")
    .setDesc("Select the default text size for new chat messages.")
    .addDropdown(dropdown => {
        dropdown
            .addOption("small", "Small")
            .addOption("medium", "Medium")
            .addOption("large", "Large")
            .setValue(plugin.settings.chatFontSize || "medium")
            .onChange(async (value: string) => {
                await plugin.getSettingsManager().updateSettings({ chatFontSize: value as any });
                new Notice(`Default chat font size set to: ${value}`);
            });
	    });

new Setting(containerEl)
    .setName("Hide SystemSculpt system messages")
    .setDesc("Keep system-role messages in the saved chat history, but hide them from the chat view.")
    .addToggle((toggle: ToggleComponent) => {
        toggle
            .setValue(plugin.settings.hideSystemMessagesInChat ?? false)
            .onChange(async (value) => {
                await plugin.getSettingsManager().updateSettings({ hideSystemMessagesInChat: value });
                new Notice(`System messages ${value ? 'hidden' : 'shown'} in chat.`);
            });
    });

// --- Reduced Motion Preference ---
new Setting(containerEl)
    .setName("Honor OS Reduced Motion")
    .setDesc("When enabled, SystemSculpt animations/transitions are minimized if your system prefers reduced motion. Disable if you want full animations.")
    .addToggle((toggle: ToggleComponent) => {
        toggle
            .setValue(plugin.settings.respectReducedMotion ?? true)
            .onChange(async (value) => {
                await plugin.getSettingsManager().updateSettings({ respectReducedMotion: value });
                new Notice(`Honor OS reduced motion ${value ? 'enabled' : 'disabled'}.`);
            });
    });
}
