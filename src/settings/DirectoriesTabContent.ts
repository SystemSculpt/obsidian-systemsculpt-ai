import { App, Setting, TextComponent } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { showPopup } from "../core/ui";

// Moved from main class
function validateDirectory(path: string): boolean {
    if (!path) return true;
    return (
        !path.includes("..") && !path.startsWith("/") && !path.startsWith("\\")
    );
}

// Moved from main class
async function handleDirectoryChange(
    tabInstance: SystemSculptSettingTab,
    value: string,
    settingKey:
        | "attachmentsDirectory"
        | "recordingsDirectory"
        | "chatsDirectory"
        | "extractionsDirectory"
        | "systemPromptsDirectory"
        | "savedChatsDirectory"
        | "benchmarksDirectory",
    createFolder: boolean = false
) {
    const { app, plugin } = tabInstance;
    if (!validateDirectory(value)) {
        showPopup(
            app,
            "Invalid directory path. Please use relative paths without '..' or leading slashes."
        );
        return;
    }

    // Update settings using SettingsManager
    await plugin.getSettingsManager().updateSettings({ [settingKey]: value });

    // Only create the directory if explicitly requested (on blur or selection)
    if (createFolder && plugin.directoryManager) {
        try {
            await plugin.directoryManager.handleDirectorySettingChange(settingKey, value);
        } catch (error) {
        }
    }
}

// Moved from main class
function createDirectorySetting(
    containerEl: HTMLElement,
    tabInstance: SystemSculptSettingTab,
    name: string,
    desc: string,
    settingKey:
        | "attachmentsDirectory"
        | "recordingsDirectory"
        | "chatsDirectory"
        | "extractionsDirectory"
        | "systemPromptsDirectory"
        | "savedChatsDirectory"
        | "benchmarksDirectory",
    placeholder: string
) {
    const { app, plugin } = tabInstance;
    new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
            text
                .setPlaceholder(placeholder)
                .setValue(plugin.settings[settingKey])
                .onChange(async (value) => {
                    await handleDirectoryChange(tabInstance, value, settingKey, false);
                });

            text.inputEl.addEventListener('blur', async () => {
                await handleDirectoryChange(tabInstance, text.inputEl.value, settingKey, true);
            });

            attachFolderSuggester(
                text.inputEl,
                async (selectedPath: string) => {
                    if (validateDirectory(selectedPath)) {
                        text.setValue(selectedPath);
                        await handleDirectoryChange(tabInstance, selectedPath, settingKey, true);
                    } else {
                        showPopup(
                            app,
                            "Invalid directory path. Please use relative paths without '..' or leading slashes."
                        );
                    }
                },
                app
            );
            return text;
        });
}

export function displayDirectoriesTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty(); // Ensure clean slate
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "directories";
    }
    const { plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Directory Settings" });

    // Core directories (always available)
    createDirectorySetting(
        containerEl,
        tabInstance,
        "Chats Directory",
        "Select the directory for your chat history",
        "chatsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Chats)"
    );

    // New: Saved Chats Directory (for notes saved via "Save chat as note")
    createDirectorySetting(
        containerEl,
        tabInstance,
        "Saved Chats Directory",
        "Select the directory where notes created via \"Save chat as note\" are stored",
        "savedChatsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Saved Chats)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Benchmarks Directory",
        "Select the directory where benchmark reports are exported",
        "benchmarksDirectory",
        "Path relative to vault root (empty = SystemSculpt/Benchmarks)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Recordings Directory",
        "Select the directory for your recordings",
        "recordingsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Recordings)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "System Prompts Directory",
        "Select the directory for your custom system prompts",
        "systemPromptsDirectory",
        "Path relative to vault root (empty = SystemSculpt/System Prompts)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Attachments Directory",
        "Select the directory for saved images and attachments",
        "attachmentsDirectory",
        "Path relative to vault root (empty = Attachments)"
    );

    // Always display these directories
    createDirectorySetting(
        containerEl,
        tabInstance,
        "Extractions Directory",
        "Select the directory where extracted PDFs/docs will be placed",
        "extractionsDirectory",
        "Path relative to vault root (empty = file's parent folder)"
    );

    // Add directory diagnostics section
    containerEl.createEl("h3", { text: "Directory Diagnostics" });

    const diagnosticsSetting = new Setting(containerEl)
      .setName('Directory diagnostics')
      .setDesc('Check that required directories exist or repair them if something looks off.');

    const statusEl = diagnosticsSetting.descEl.createDiv({ cls: 'ss-inline-note' });

    diagnosticsSetting.addButton((button) => {
      button
        .setButtonText('Verify directories')
        .onClick(async () => {
          statusEl.setText('Checking directories...');
          try {
            const result = await plugin.checkDirectoryHealth();
            if (result.valid) {
              statusEl.setText('All directories are properly configured.');
            } else {
              const messages = result.issues?.length ? result.issues.join('\n• ') : 'Issues detected.';
              statusEl.setText(`Issues found:\n• ${messages}`);
            }
          } catch (error: any) {
            statusEl.setText(`Verification failed: ${error?.message || error}`);
          }
        });
    });

    diagnosticsSetting.addButton((button) => {
      button
        .setButtonText('Repair directories')
        .setCta()
        .onClick(async () => {
          statusEl.setText('Repairing directories...');
          try {
            const success = await plugin.repairDirectoryStructure();
            statusEl.setText(success
              ? 'Directory structure repaired. Restart Obsidian to ensure changes apply.'
              : 'Repair did not complete. Check the console for details.');
          } catch (error: any) {
            statusEl.setText(`Repair failed: ${error?.message || error}`);
          }
        });
    });
}
