import { Notice } from "obsidian";
import { createCatalogSetting } from "./SettingsCatalog";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { DEFAULT_STUDIO_PROJECTS_DIR } from "../studio/paths";
import { STUDIO_DISPLAY_NAME } from "../studio/types";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { beginTextSettings } from "./TextSettings";

export function displayImageGenerationTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
): void {
  const bindTextSetting = beginTextSettings(containerEl, tabInstance);
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "studio";
  }

  const { plugin } = tabInstance;
  containerEl.createEl("h3", { text: "Studio" });

  createCatalogSetting(containerEl, "studio.open")
    .addButton((button) => {
      button
        .setButtonText(`Open ${STUDIO_DISPLAY_NAME}`)
        .onClick(async () => {
          try {
            await plugin.getViewManager().activateSystemSculptStudioView();
          } catch (error) {
            new Notice(`Unable to open Studio: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    });

  createCatalogSetting(containerEl, "studio.projects-folder")
    .addText((text) => {
      text
        .setPlaceholder(DEFAULT_STUDIO_PROJECTS_DIR)
        .setValue(plugin.settings.studioDefaultProjectsFolder || DEFAULT_STUDIO_PROJECTS_DIR);
      const commitFolder = bindTextSetting("studioDefaultProjectsFolder", text.inputEl, async (value) => {
        return plugin.getSettingsManager().updateSettings({
          studioDefaultProjectsFolder: value.trim() || DEFAULT_STUDIO_PROJECTS_DIR,
        });
      });
      attachFolderSuggester(text.inputEl, (value) => {
        text.setValue(value);
        commitFolder();
      }, tabInstance.app);
    });

  createCatalogSetting(containerEl, "studio.run-retention")
    .addText((text) => {
      text
        .setPlaceholder("100")
        .setValue(String(plugin.settings.studioRunRetentionMaxRuns ?? 100));
      bindTextSetting("studioRunRetentionMaxRuns", text.inputEl, async (value) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return;
        return plugin.getSettingsManager().updateSettings({
          studioRunRetentionMaxRuns: Math.max(1, Math.min(5000, parsed)),
        });
      });
      text.inputEl.inputMode = "numeric";
    });

  createCatalogSetting(containerEl, "studio.artifact-retention")
    .addText((text) => {
      text
        .setPlaceholder("1024")
        .setValue(String(plugin.settings.studioRunRetentionMaxArtifactsMb ?? 1024));
      bindTextSetting("studioRunRetentionMaxArtifactsMb", text.inputEl, async (value) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return;
        return plugin.getSettingsManager().updateSettings({
          studioRunRetentionMaxArtifactsMb: Math.max(1, Math.min(200_000, parsed)),
        });
      });
      text.inputEl.inputMode = "numeric";
    });
}
