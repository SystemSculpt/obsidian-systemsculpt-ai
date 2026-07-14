import { Notice, Setting } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";

function validateDirectory(path: string): boolean {
    if (!path) return true;
    return (
        !path.includes("..") && !path.startsWith("/") && !path.startsWith("\\")
    );
}

async function handleDirectoryChange(
    tabInstance: SystemSculptSettingTab,
    value: string,
    settingKey:
        | "attachmentsDirectory"
        | "recordingsDirectory"
        | "chatsDirectory"
        | "extractionsDirectory"
        | "savedChatsDirectory",
    createFolder: boolean = false
) {
    const { plugin } = tabInstance;
    if (!validateDirectory(value)) {
        new Notice("Use a vault-relative path without '..' or a leading slash.");
        return;
    }

    await plugin.getSettingsManager().updateSettings({ [settingKey]: value });

    if (createFolder && plugin.directoryManager) {
        try {
            await plugin.directoryManager.handleDirectorySettingChange(settingKey, value);
        } catch {
            new Notice("Couldn’t create that directory.");
        }
    }
}

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
        | "savedChatsDirectory",
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
                        new Notice("Use a vault-relative path without '..' or a leading slash.");
                    }
                },
                app
            );
            return text;
        });
}

export function displayDirectoriesTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty();
    if (containerEl.classList.contains("systemsculpt-tab-content")) {
        containerEl.dataset.tab = "workspace";
    }
    const { plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Directories" });

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Chats directory",
        "Where chat history is stored.",
        "chatsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Chats)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Saved chats directory",
        "Where chats saved as notes are stored.",
        "savedChatsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Saved Chats)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Recordings directory",
        "Where recordings are stored.",
        "recordingsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Recordings)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Attachments directory",
        "Where saved images and attachments are stored.",
        "attachmentsDirectory",
        "Path relative to vault root (empty = Attachments)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        "Extractions directory",
        "Where extracted documents are stored.",
        "extractionsDirectory",
        "Path relative to vault root (empty = file's parent folder)"
    );

    containerEl.createEl("h3", { text: "Diagnostics" });

    const diagnosticsSetting = new Setting(containerEl)
      .setName("Directory health")
      .setDesc("Verify or repair SystemSculpt directories.");

    const statusEl = diagnosticsSetting.descEl.createDiv({ cls: "ss-inline-note" });

    diagnosticsSetting.addButton((button) => {
      button
        .setButtonText("Verify")
        .onClick(async () => {
          statusEl.setText("Checking directories…");
          try {
            const result = await plugin.checkDirectoryHealth();
            if (result.valid) {
              statusEl.setText("All directories are ready.");
            } else {
              const messages = result.issues?.length ? result.issues.join("\n• ") : "Issues detected.";
              statusEl.setText(`Issues found:\n• ${messages}`);
            }
          } catch (error: unknown) {
            statusEl.setText(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    });

    diagnosticsSetting.addButton((button) => {
      button
        .setButtonText("Repair")
        .setCta()
        .onClick(async () => {
          statusEl.setText("Repairing directories…");
          try {
            const success = await plugin.repairDirectoryStructure();
            statusEl.setText(success
              ? "Directories repaired. Restart Obsidian to apply the changes."
              : "Repair didn’t complete. Check the console for details.");
          } catch (error: unknown) {
            statusEl.setText(`Repair failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    });
}
