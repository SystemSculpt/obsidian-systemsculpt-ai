import { Setting, Notice, ButtonComponent } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showPrompt } from "../core/ui/modals/PromptModal";
import { DEFAULT_SETTINGS } from "../types";
import { tryCopyToClipboard } from "../utils/clipboard";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";

export function displayAdvancedTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty(); // Ensure clean slate
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "advanced";
    }
    const { app, plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Advanced settings" }); // Added header for clarity
    tabInstance.renderQuickActionsSection(containerEl);

    new Setting(containerEl)
        .setName("Relative line numbers")
        .setDesc("Show a vim-style line number gutter in the editor: the current line shows its absolute number, every other line shows its distance from the cursor. Tip: turn off Obsidian's core \"Show line number\" to avoid a doubled gutter.")
        .addToggle((toggle) => {
            toggle
                .setValue(Boolean(plugin.settings.relativeLineNumbersEnabled))
                .onChange(async (value) => {
                    await plugin.getSettingsManager().updateSettings({
                        relativeLineNumbersEnabled: value,
                    });
                    new Notice(
                        value
                            ? "Relative line numbers enabled."
                            : "Relative line numbers disabled."
                    );
                });
        });

    // Reset to Factory Settings button
    const resetSetting = new Setting(containerEl)
        .setName("Reset to factory settings")
        .setDesc(
            "Clear all custom settings and restore defaults for this plugin."
        );

    const resetButton = new ButtonComponent(resetSetting.controlEl);
    resetButton.setButtonText("Reset…");
    resetButton.setWarning();
    resetButton.onClick(async () => {
        const confirm = await showPrompt(
            app,
            "Reset to Factory Defaults",
            {
                description:
                    "This will delete ALL saved settings and customizations for SystemSculpt, returning everything to default. Do you want to continue?",
                primaryButton: "Reset & Reload",
                secondaryButton: "Cancel",
            }
        );
        if (!confirm || !confirm.confirmed) {
            return;
        }

        try {
            // Reset settings to default
            await plugin.saveData(null);
            // Ensure DEFAULT_SETTINGS includes the new title gen fields
            await plugin.getSettingsManager().updateSettings({...DEFAULT_SETTINGS}); // Spread to ensure defaults are fresh

            // No need to manually clear specific settings
            // The updateSettings call with DEFAULT_SETTINGS will handle everything

            // Force reload to ensure clean state
             new Notice("Settings reset. Reloading Obsidian...", 3000);
             const ownerWindow = getSurfaceOwnerWindow(containerEl);
             ownerWindow.setTimeout(() => ownerWindow.location.reload(), 1000);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Couldn’t reset settings: ${message}`);
        }
    });

    // Add a divider
    containerEl.createEl("hr", { cls: "settings-separator" });

    containerEl.createEl("h3", { text: "Diagnostics" });

    new Setting(containerEl)
        .setName("Copy diagnostics snapshot")
        .setDesc("Copies recent logs and resource metrics for support tickets.")
        .addButton((button) => {
            button.setButtonText("Copy snapshot").onClick(async () => {
                const { text, path } = await plugin.exportDiagnosticsSnapshot();
                const copied = await tryCopyToClipboard(text);
                if (copied) {
                    new Notice("Diagnostics snapshot copied to clipboard.", 4000);
                } else if (path) {
                    new Notice(`Diagnostics snapshot saved to ${path}.`, 5000);
                } else {
                    new Notice("Unable to copy diagnostics (clipboard unavailable).", 5000);
                }
            });
        });

    new Setting(containerEl)
        .setName("Open diagnostics folder")
        .setDesc("Opens the .systemsculpt/diagnostics folder inside your vault.")
        .addButton((button) => {
            button.setButtonText("Open folder").onClick(async () => {
                const opened = await plugin.openDiagnosticsFolder();
                if (opened) {
                    new Notice("Opened diagnostics folder in your file manager.", 4000);
                } else {
                    new Notice("Unable to open diagnostics folder. Locate .systemsculpt/diagnostics manually.", 5000);
                }
            });
        });
}
