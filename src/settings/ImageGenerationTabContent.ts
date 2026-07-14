import { Notice, Setting } from "obsidian";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";

export function displayImageGenerationTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
): void {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "studio";
  }

  const { plugin } = tabInstance;
  containerEl.createEl("h3", { text: "Studio" });

  new Setting(containerEl)
    .setName("Open Studio")
    .addButton((button) => {
      button
        .setButtonText("Open Studio")
        .onClick(async () => {
          try {
            await plugin.getViewManager().activateSystemSculptStudioView();
          } catch (error) {
            new Notice(`Unable to open Studio: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    });

  new Setting(containerEl)
    .setName("Projects folder")
    .setDesc("Default vault folder for new Studio projects.")
    .addText((text) => {
      text
        .setPlaceholder("SystemSculpt/Studio")
        .setValue(plugin.settings.studioDefaultProjectsFolder || "SystemSculpt/Studio")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({
            studioDefaultProjectsFolder: value.trim() || "SystemSculpt/Studio",
          });
        });
      attachFolderSuggester(text.inputEl, (value) => text.setValue(value), tabInstance.app);
    });

  new Setting(containerEl)
    .setName("Run retention")
    .setDesc("Maximum completed runs kept per project.")
    .addText((text) => {
      text
        .setPlaceholder("100")
        .setValue(String(plugin.settings.studioRunRetentionMaxRuns ?? 100))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          await plugin.getSettingsManager().updateSettings({
            studioRunRetentionMaxRuns: Math.max(1, Math.min(5000, parsed)),
          });
        });
      text.inputEl.inputMode = "numeric";
    });

  new Setting(containerEl)
    .setName("Artifact retention (mb)")
    .setDesc("Target artifact storage per project before oldest run assets are pruned.")
    .addText((text) => {
      text
        .setPlaceholder("1024")
        .setValue(String(plugin.settings.studioRunRetentionMaxArtifactsMb ?? 1024))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          await plugin.getSettingsManager().updateSettings({
            studioRunRetentionMaxArtifactsMb: Math.max(1, Math.min(200_000, parsed)),
          });
        });
      text.inputEl.inputMode = "numeric";
    });
}
