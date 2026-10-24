import { Notice, Setting } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { beginTextSettings } from "./TextSettings";

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
) {
    const { plugin } = tabInstance;
    const saved = await plugin.getSettingsManager().updateSettings({ [settingKey]: value });
    if (saved === false) return false;

    if (plugin.directoryManager) {
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
    bindTextSetting: ReturnType<typeof beginTextSettings>,
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
                .setValue(plugin.settings[settingKey]);

            const commitDirectory = bindTextSetting(settingKey, text.inputEl, async (value) => {
                if (!validateDirectory(value)) {
                    new Notice("Use a vault-relative path without '..' or a leading slash.");
                    return;
                }
                return handleDirectoryChange(tabInstance, value, settingKey);
            }, { commitOn: "blur", errorMessage: "Couldn’t save that directory." });

            attachFolderSuggester(
                text.inputEl,
                (selectedPath: string) => {
                    text.setValue(selectedPath);
                    commitDirectory();
                },
                app
            );
            return text;
        });
}

export function displayDirectoriesTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    const bindTextSetting = beginTextSettings(containerEl, tabInstance);
    containerEl.empty();
    if (containerEl.classList.contains("systemsculpt-tab-content")) {
        containerEl.dataset.tab = "workspace";
    }
    const { plugin } = tabInstance;

    containerEl.createEl("h3", { text: "Directories" });

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
        "Chats directory",
        "Where new chats are saved. Existing chats stay in the folder they were saved in.",
        "chatsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Chats)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
        "Saved chats directory",
        "Where chats saved as notes are stored.",
        "savedChatsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Saved Chats)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
        "Recordings directory",
        "Where recordings are stored.",
        "recordingsDirectory",
        "Path relative to vault root (empty = SystemSculpt/Recordings)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
        "Attachments directory",
        "Where saved images and attachments are stored.",
        "attachmentsDirectory",
        "Path relative to vault root (empty = Attachments)"
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
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
