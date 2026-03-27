import { Setting, Notice, ButtonComponent, Platform } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showPopup } from "../core/ui";
import { DEFAULT_SETTINGS } from "../types";
import { UpdateNotificationWarningModal } from "../modals/UpdateNotificationWarningModal";
import { tryCopyToClipboard } from "../utils/clipboard";

export function displayAdvancedTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty(); // Ensure clean slate
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "advanced";
    }
    const { app, plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Advanced Settings" }); // Added header for clarity
    tabInstance.renderQuickActionsSection(containerEl);

    if (Platform.isDesktopApp) {
        new Setting(containerEl)
            .setName("Desktop automation bridge")
            .setDesc("Expose a token-protected localhost bridge so the already-running desktop Obsidian instance can be tested without taking application focus.")
            .addToggle((toggle) => {
                toggle
                    .setValue(Boolean(plugin.settings.desktopAutomationBridgeEnabled))
                    .onChange(async (value) => {
                        await plugin.getSettingsManager().updateSettings({
                            desktopAutomationBridgeEnabled: value,
                        });
                        new Notice(
                            value
                                ? "Desktop automation bridge enabled."
                                : "Desktop automation bridge disabled."
                        );
                    });
            });
    }

    // Update Notifications setting
    const updateNotificationsSetting = new Setting(containerEl)
        .setName("Update notifications")
        .setDesc("Show notifications when plugin updates are available")
        .addToggle((toggle) => {
            toggle
                .setValue(plugin.settings.showUpdateNotifications)
                .onChange(async (value) => {
                    if (!value) {
                        // Show warning modal when disabling
                        const warningModal = new UpdateNotificationWarningModal(app);
                        const result = await warningModal.open();
                        
                        if (result.confirmed) {
                            await plugin.getSettingsManager().updateSettings({
                                showUpdateNotifications: false
                            });
                            // Notify version checker to stop checking
                            plugin.versionCheckerService?.onUpdateNotificationsDisabled();
                            new Notice("Update notifications disabled. You can re-enable them anytime in Advanced settings.");
                        } else {
                            // User cancelled, reset toggle
                            toggle.setValue(true);
                        }
                    } else {
                        // Enabling notifications - no warning needed
                        await plugin.getSettingsManager().updateSettings({
                            showUpdateNotifications: true
                        });
                        // Notify version checker to start checking again
                        plugin.versionCheckerService?.onUpdateNotificationsEnabled();
                        new Notice("Update notifications enabled.");
                    }
                });
        });


    // Reset to Factory Settings button
    const resetSetting = new Setting(containerEl)
        .setName("Reset to Factory Settings")
        .setDesc(
            "Clear all custom settings and restore defaults for this plugin."
        );

    const resetButton = new ButtonComponent(resetSetting.controlEl);
    resetButton.setButtonText("Reset…");
    resetButton.setWarning();
    resetButton.onClick(async () => {
        const confirm = await showPopup(
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
             setTimeout(() => window.location.reload(), 1000); // Delay reload slightly

        } catch (error) {
            showPopup(app, "Failed to reset: " + String(error));
        }
    });

    // Add a divider
    containerEl.createEl("hr", { cls: "settings-separator" });

    containerEl.createEl("h3", { text: "Diagnostics" });

    new Setting(containerEl)
        .setName("Copy diagnostics snapshot")
        .setDesc("Copies recent logs and resource metrics for support tickets.")
        .addButton((button) => {
            button.setButtonText("Copy Snapshot").onClick(async () => {
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
            button.setButtonText("Open Folder").onClick(async () => {
                const opened = await plugin.openDiagnosticsFolder();
                if (opened) {
                    new Notice("Opened diagnostics folder in your file manager.", 4000);
                } else {
                    new Notice("Unable to open diagnostics folder. Locate .systemsculpt/diagnostics manually.", 5000);
                }
            });
        });
}
