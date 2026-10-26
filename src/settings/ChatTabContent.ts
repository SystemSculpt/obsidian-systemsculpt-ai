import { mountCodexExecutionControls } from "../services/codex/CodexExecutionControls";
import { createCatalogSetting } from "./SettingsCatalog";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { beginTextSettings } from "./TextSettings";

const codexSettingsCleanup = new WeakMap<HTMLElement, () => void>();

export async function displayChatTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    const bindTextSetting = beginTextSettings(containerEl, tabInstance);
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

    createCatalogSetting(containerEl, "chat.default-tag")
        .addText((text) => {
            text
                .setPlaceholder("Ai-chat")
                .setValue(plugin.settings.defaultChatTag || "");
            bindTextSetting("defaultChatTag", text.inputEl, async (value) => {
                const normalized = normalizeDefaultChatTag(value);
                return plugin.getSettingsManager().updateSettings({ defaultChatTag: normalized });
            });
        });

// --- Default Chat Font Size ---
createCatalogSetting(containerEl, "chat.font-size")
    .addDropdown(dropdown => {
        dropdown
            .addOption("small", "Small")
            .addOption("medium", "Medium")
            .addOption("large", "Large")
            .setValue(plugin.settings.chatFontSize || "medium")
            .onChange(async (value: string) => {
                if (value !== "small" && value !== "medium" && value !== "large") return;
                await plugin.getSettingsManager().updateSettings({ chatFontSize: value });
            });
	    });

// --- Reduced Motion Preference ---
createCatalogSetting(containerEl, "chat.reduce-motion")
    .addToggle((toggle) => {
        toggle
            .setValue(plugin.settings.reduceChatMotion ?? false)
            .onChange(async (value) => {
                await plugin.getSettingsManager().updateSettings({ reduceChatMotion: value });
            });
    });
}
