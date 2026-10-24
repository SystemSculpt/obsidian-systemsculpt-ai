import { Setting, Notice, ButtonComponent } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showPrompt } from "../core/ui/modals/PromptModal";
import { DEFAULT_SETTINGS } from "../types";
import { tryCopyToClipboard } from "../utils/clipboard";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import { flashButtonResult } from "../core/ui/notifications";
import { hasHostCapability } from "../platform/hostCapabilities";

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
        .setDesc("Use a vim-style line number gutter in the editor. The current line shows its absolute number; other lines show their distance from the Cursor. Turn off Obsidian's core \"show line number\" setting to avoid a doubled gutter.")
        .addToggle((toggle) => {
            toggle
                .setValue(Boolean(plugin.settings.relativeLineNumbersEnabled))
                .onChange(async (value) => {
                    await plugin.getSettingsManager().updateSettings({
                        relativeLineNumbersEnabled: value,
                    });
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
                    "Reset SystemSculpt’s saved settings to defaults and reload Obsidian? Your current settings will be replaced.",
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
             resetButton.setButtonText("Reloading…").setDisabled(true);
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
        .setName("Record diagnostics")
        .setDesc("Save resource samples and long-frame reports in .systemsculpt/diagnostics. Leave off unless you are troubleshooting. Chat lifecycle logs follow the log level; failed chat runs still save incident reports.")
        .addToggle((toggle) => {
            toggle
                .setValue(plugin.settings.showDiagnostics === true)
                .onChange(async (value) => {
                    await plugin.getSettingsManager().updateSettings({
                        showDiagnostics: value,
                    });
                });
        });

    new Setting(containerEl)
        .setName("Copy diagnostics snapshot")
        .setDesc("Copies a content-free runtime and resource summary for support.")
        .addButton((button) => {
            button.setButtonText("Copy snapshot").onClick(async () => {
                const { text, path } = await plugin.exportDiagnosticsSnapshot();
                const copied = await tryCopyToClipboard(text);
                if (copied) {
                    flashButtonResult(button.buttonEl, "Copied");
                } else if (path) {
                    new Notice(`Diagnostics snapshot saved to ${path}.`, 5000);
                } else {
                    new Notice("Unable to copy diagnostics (clipboard unavailable).", 5000);
                }
            });
        });

    const diagnosticsFolderSetting = new Setting(containerEl)
        .setName("Diagnostics folder")
        .setDesc("Saved in .systemsculpt/diagnostics inside your vault.");
    if (hasHostCapability("file-manager-reveal", containerEl)) {
        diagnosticsFolderSetting.addButton((button) => {
            button.setButtonText("Open folder").onClick(async () => {
                if (!await plugin.openDiagnosticsFolder()) {
                    new Notice("Unable to open diagnostics folder. Locate .systemsculpt/diagnostics manually.", 5000);
                }
            });
        });
    }
}
