import { mountCodexExecutionControls } from "../services/codex/CodexExecutionControls";
import { Notice, Setting } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";

const codexSettingsCleanup = new WeakMap<HTMLElement, () => void>();

export async function displayChatTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    codexSettingsCleanup.get(containerEl)?.(); containerEl.empty();
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "chat";
    }
    const { plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Chat settings" });

    containerEl.createEl('p', {
        text: 'Use this tab for chat preferences and display choices.',
        cls: 'setting-item-description'
    });

    const execution = containerEl.createDiv();
    const cleanup = mountCodexExecutionControls(execution, plugin, {});
    const unregister = tabInstance.registerRenderCleanup(cleanup);
    codexSettingsCleanup.set(containerEl, () => { cleanup(); unregister(); });

    const normalizeDefaultChatTag = (value: string): string => value.trim().replace(/^#+/, "");

    new Setting(containerEl)
        .setName("Default chat tag")
        .setDesc("Optional. Adds this tag to new chat history notes (frontmatter `tags`).")
        .addText((text) => {
            text
                .setPlaceholder("Ai-chat")
                .setValue(plugin.settings.defaultChatTag || "")
                .onChange(async (value) => {
                    const normalized = normalizeDefaultChatTag(value);
                    await plugin.getSettingsManager().updateSettings({ defaultChatTag: normalized });
                });
        });

// --- Default Chat Font Size ---
new Setting(containerEl)
    .setName("Default chat font size")
    .setDesc("Select the default text size for new chat messages.")
    .addDropdown(dropdown => {
        dropdown
            .addOption("small", "Small")
            .addOption("medium", "Medium")
            .addOption("large", "Large")
            .setValue(plugin.settings.chatFontSize || "medium")
            .onChange(async (value: string) => {
                if (value !== "small" && value !== "medium" && value !== "large") return;
                await plugin.getSettingsManager().updateSettings({ chatFontSize: value });
                new Notice(`Default chat font size set to: ${value}`);
            });
	    });

// --- Reduced Motion Preference ---
new Setting(containerEl)
    .setName("Honor reduced motion")
    .setDesc("When enabled, SystemSculpt animations/transitions are minimized if your system prefers reduced motion. Disable this if you want full animations.")
    .addToggle((toggle) => {
        toggle
            .setValue(plugin.settings.respectReducedMotion ?? true)
            .onChange(async (value) => {
                await plugin.getSettingsManager().updateSettings({ respectReducedMotion: value });
                new Notice(`Reduced motion ${value ? 'enabled' : 'disabled'}.`);
            });
    });
}
