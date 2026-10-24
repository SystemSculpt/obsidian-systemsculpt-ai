import { Notice } from "obsidian";
import { createCatalogSetting } from "./SettingsCatalog";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { DEFAULT_PHONE_CAPTURE_FOLDER, DEFAULT_PHONE_MEETING_FOLDER } from "../features/phone-captures/PhoneCaptureInbox";

function validFolder(path: string): boolean {
  return !path.includes("..") && !path.startsWith("/") && !path.startsWith("\\");
}

export function displayPhoneCapturesTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  const { app, plugin } = tabInstance;
  // Nothing to configure until the account has used the iOS app.
  if (plugin.settings.phoneCapturesLinked !== true) return;
  const settingsManager = plugin.getSettingsManager();

  createCatalogSetting(containerEl, "workspace.phone-captures")
    .setHeading();

  createCatalogSetting(containerEl, "workspace.save-phone-captures")
    .addToggle((toggle) => toggle
      .setValue(plugin.settings.phoneCapturesEnabled)
      .onChange(async (value) => {
        await settingsManager.updateSettings({ phoneCapturesEnabled: value });
        if (value) void plugin.syncPhoneCaptures();
      }));

  createCatalogSetting(containerEl, "workspace.confirm-phone-captures")
    .addToggle((toggle) => toggle
      .setValue(plugin.settings.phoneCapturesAskBeforeSaving)
      .onChange(async (value) => {
        await settingsManager.updateSettings({ phoneCapturesAskBeforeSaving: value });
      }));

  const folders = [
    {
      key: "phoneCapturesFolder" as const,
      id: "workspace.phone-captures-folder" as const,
      placeholder: DEFAULT_PHONE_CAPTURE_FOLDER,
    },
    {
      key: "phoneCapturesMeetingsFolder" as const,
      id: "workspace.phone-meetings-folder" as const,
      placeholder: DEFAULT_PHONE_MEETING_FOLDER,
    },
  ];
  for (const folder of folders) {
    const saveFolder = async (value: string) => {
      if (!validFolder(value)) {
        new Notice("Use a vault-relative path without '..' or a leading slash.");
        return;
      }
      await settingsManager.updateSettings({ [folder.key]: value.trim() });
    };
    createCatalogSetting(containerEl, folder.id)
      .addText((text) => {
        text
          .setPlaceholder(folder.placeholder)
          .setValue(plugin.settings[folder.key])
          .onChange(saveFolder);
        attachFolderSuggester(
          text.inputEl,
          (selectedPath: string) => {
            text.setValue(selectedPath);
            void saveFolder(selectedPath);
          },
          app,
        );
        return text;
      });
  }
}
