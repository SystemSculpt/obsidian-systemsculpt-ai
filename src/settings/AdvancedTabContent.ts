import { Notice, ButtonComponent } from "obsidian";
import { createCatalogSetting } from "./SettingsCatalog";
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

    createCatalogSetting(containerEl, "advanced.relative-line-numbers")
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
    const resetSetting = createCatalogSetting(containerEl, "advanced.reset");

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

    createCatalogSetting(containerEl, "advanced.record-diagnostics")
        .addToggle((toggle) => {
            toggle
                .setValue(plugin.settings.showDiagnostics === true)
                .onChange(async (value) => {
                    await plugin.getSettingsManager().updateSettings({
                        showDiagnostics: value,
                    });
                });
        });

    createCatalogSetting(containerEl, "advanced.copy-diagnostics")
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

    const diagnosticsFolderSetting = createCatalogSetting(containerEl, "advanced.diagnostics-folder");
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
