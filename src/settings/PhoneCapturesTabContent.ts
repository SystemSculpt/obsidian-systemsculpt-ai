import { Notice, Setting } from "obsidian";
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

  new Setting(containerEl)
    .setName("iOS captures")
    .setDesc("Notes and voice memos from the SystemSculpt iOS app arrive in this vault while you are signed in.")
    .setHeading();

  new Setting(containerEl)
    .setName("Save iOS captures")
    .setDesc("Check for new captures when Obsidian opens, when it regains focus and every few minutes.")
    .addToggle((toggle) => toggle
      .setValue(plugin.settings.phoneCapturesEnabled)
      .onChange(async (value) => {
        await settingsManager.updateSettings({ phoneCapturesEnabled: value });
        if (value) void plugin.syncPhoneCaptures();
      }));

  new Setting(containerEl)
    .setName("Ask before saving iOS captures")
    .setDesc("Show the waiting captures and save them only when you confirm.")
    .addToggle((toggle) => toggle
      .setValue(plugin.settings.phoneCapturesAskBeforeSaving)
      .onChange(async (value) => {
        await settingsManager.updateSettings({ phoneCapturesAskBeforeSaving: value });
      }));

  const folders = [
    {
      key: "phoneCapturesFolder" as const,
      name: "iOS captures folder",
      description: "Notes and transcripts become new notes here. Existing notes are never overwritten.",
      placeholder: DEFAULT_PHONE_CAPTURE_FOLDER,
    },
    {
      key: "phoneCapturesMeetingsFolder" as const,
      name: "iOS meetings folder",
      description: "Meeting briefs, action items and transcripts become new notes here.",
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
    new Setting(containerEl)
      .setName(folder.name)
      .setDesc(folder.description)
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
