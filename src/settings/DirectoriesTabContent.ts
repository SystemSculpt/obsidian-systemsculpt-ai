import { DEFAULT_DIRS } from "../core/settings/defaultDirectories";
import { Notice } from "obsidian";
import { createCatalogSetting } from "./SettingsCatalog";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { beginTextSettings } from "./TextSettings";

const DIRECTORY_SETTING_IDS = {
    recordingsDirectory: "workspace.recordings-directory",
    chatsDirectory: "workspace.chats-directory",
    extractionsDirectory: "workspace.extractions-directory",
} as const;

function validateDirectory(path: string): boolean {
    if (!path) return true;
    return (
        !path.includes("..") && !path.startsWith("/") && !path.startsWith("\\")
    );
}

async function handleDirectoryChange(
    tabInstance: SystemSculptSettingTab,
    value: string,
    settingKey: keyof typeof DIRECTORY_SETTING_IDS,
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
    settingKey: keyof typeof DIRECTORY_SETTING_IDS,
    placeholder: string
) {
    const { app, plugin } = tabInstance;
    createCatalogSetting(containerEl, DIRECTORY_SETTING_IDS[settingKey])
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
        "chatsDirectory",
        `Path relative to vault root (empty = ${DEFAULT_DIRS.chatsDirectory})`
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
        "recordingsDirectory",
        `Path relative to vault root (empty = ${DEFAULT_DIRS.recordingsDirectory})`
    );

    createDirectorySetting(
        containerEl,
        tabInstance,
        bindTextSetting,
        "extractionsDirectory",
        "Path relative to vault root (empty = file's parent folder)"
    );

    containerEl.createEl("h3", { text: "Diagnostics" });

    const diagnosticsSetting = createCatalogSetting(containerEl, "workspace.directory-health");

    const statusEl = diagnosticsSetting.descEl.createDiv({
      cls: "ss-inline-note",
      attr: { role: "status", "aria-live": "polite" },
    });

    const setStatus = (text: string) => {
      statusEl.setText(text);
      tabInstance.invalidateSearchIndex();
    };

    diagnosticsSetting.addButton((button) => {
      button
        .setButtonText("Verify")
        .onClick(async () => {
          setStatus("Checking directories…");
          try {
            const result = await plugin.checkDirectoryHealth();
            if (result.valid) {
              setStatus("All directories are ready.");
            } else {
              const messages = result.issues?.length ? result.issues.join("\n• ") : "Issues detected.";
              setStatus(`Issues found:\n• ${messages}`);
            }
          } catch (error: unknown) {
            setStatus(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    });

    diagnosticsSetting.addButton((button) => {
      button
        .setButtonText("Repair")
        .setCta()
        .onClick(async () => {
          setStatus("Repairing directories…");
          try {
            const success = await plugin.repairDirectoryStructure();
            setStatus(success
              ? "No directory repair is needed. Output folders are created when files are saved."
              : "An output path is blocked or inaccessible. Resolve the conflict or choose another directory.");
          } catch (error: unknown) {
            setStatus(`Repair failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    });
}
