import { Setting, Notice } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type SystemSculptPlugin from "../main";
import { EmbeddingsPendingFilesModal } from "../modals/EmbeddingsPendingFilesModal";
import { showConfirm } from "../core/ui/notifications";

export async function displayEmbeddingsTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "knowledge";
  }

  containerEl.createEl("h3", { text: "Embeddings" });
  containerEl.createEl("p", {
    text: "Enable semantic search to find similar notes by meaning instead of keywords.",
    cls: "setting-item-description",
  });

  const isEnabled = await renderCoreSettingsSection(containerEl, tabInstance);

  if (isEnabled) {
    const refreshStatus = await renderProcessingSection(containerEl, tabInstance);
    await refreshStatus();
  }

  await renderExclusionsSection(containerEl, tabInstance);
}

async function renderCoreSettingsSection(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab): Promise<boolean> {
  const { plugin } = tabInstance;
  new Setting(containerEl)
    .setName("Enable embeddings")
    .setDesc("Turn on semantic search for your vault.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.embeddingsEnabled || false)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ embeddingsEnabled: value });

          if (value) {
            new Notice("Embeddings enabled.");
            plugin.embeddingsStatusBar?.startMonitoring();
            try {
              plugin.getOrCreateEmbeddingsManager();
            } catch (error: any) {
              const message = error?.message || error || "Failed to initialize embeddings.";
              new Notice(typeof message === "string" ? message : "Failed to initialize embeddings.");
            }
          } else {
            new Notice("Embeddings disabled.");
            plugin.embeddingsStatusBar?.stopMonitoring();
          }

          tabInstance.display();
        });
    });

  const enabled = plugin.settings.embeddingsEnabled;
  if (!enabled) {
    return false;
  }

  if ((plugin.settings.embeddingsProvider || "systemsculpt") !== "systemsculpt") {
    plugin.settings.embeddingsProvider = "systemsculpt";
    await plugin.getSettingsManager().updateSettings({ embeddingsProvider: "systemsculpt" });
  }

  new Setting(containerEl)
    .setName("Embeddings execution")
    .setDesc(
      plugin.settings.licenseKey?.trim()
        ? "Embeddings always run through SystemSculpt across desktop and mobile."
        : "Embeddings run through SystemSculpt and require an active SystemSculpt license."
    );

  return true;
}

async function renderProcessingSection(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;

  const statusSetting = new Setting(containerEl).setName("Processing status");
  const statusText = statusSetting.descEl.createSpan();

  const refreshStatus = async () => {
    statusText.setText(await buildStatusSummary(plugin));
  };

  statusSetting.addExtraButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh status")
      .onClick(async () => {
        button.setDisabled(true);
        try {
          await refreshStatus();
        } finally {
          button.setDisabled(false);
        }
      });
  });

  statusSetting.addExtraButton((button) => {
    button
      .setIcon("list")
      .setTooltip("View remaining files")
      .onClick(async () => {
        button.setDisabled(true);
        try {
          const manager = plugin.getOrCreateEmbeddingsManager();
          await manager.awaitReady?.();
          new EmbeddingsPendingFilesModal(plugin.app, plugin).open();
        } catch (error: any) {
          const message = error?.message || error || "Unable to open remaining files.";
          new Notice(typeof message === "string" ? message : "Unable to open remaining files.");
        } finally {
          button.setDisabled(false);
        }
      });
  });

  new Setting(containerEl)
    .setName("Clear embeddings data")
    .setDesc("Remove stored embeddings to start over.")
    .addButton((button) => {
      button
        .setWarning()
        .setButtonText("Clear data")
        .onClick(async () => {
          const { confirmed } = await showConfirm(
            tabInstance.app,
            "Clear all embeddings data? This cannot be undone.",
            {
              title: "Clear Embeddings Data",
              primaryButton: "Clear Data",
              secondaryButton: "Cancel",
              icon: "alert-triangle",
            }
          );
          if (!confirmed) return;

          try {
            const manager = plugin.embeddingsManager;
            if (manager) {
              await manager.clearAll();
              new Notice("Embeddings data cleared.");
            } else {
              new Notice("No embeddings data to clear.");
            }
            await refreshStatus();
          } catch (error: any) {
            new Notice(`Failed to clear embeddings data: ${error?.message || error}`);
          }
        });
    });

  return refreshStatus;
}

async function renderExclusionsSection(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;
  const exclusions = getExclusionsWithDefaults(plugin);

  containerEl.createEl("h3", { text: "Exclusions" });
  containerEl.createEl("p", {
    text: "Decide which folders or files should be ignored during embeddings processing.",
    cls: "setting-item-description",
  });

  new Setting(containerEl)
    .setName("Exclude chat history")
    .setDesc("Skip chat transcripts when building embeddings.")
    .addToggle((toggle) => {
      toggle
        .setValue(exclusions.ignoreChatHistory)
        .onChange(async (value) => {
          await updateExclusionSetting(tabInstance, "ignoreChatHistory", value);
          tabInstance.display();
        });
    });

  new Setting(containerEl)
    .setName("Respect Obsidian exclusions")
    .setDesc("Reuse the ignored files configured in Settings → Files & Links.")
    .addToggle((toggle) => {
      toggle
        .setValue(exclusions.respectObsidianExclusions)
        .onChange(async (value) => {
          await updateExclusionSetting(tabInstance, "respectObsidianExclusions", value);
          tabInstance.display();
        });
    });

  const folderSetting = new Setting(containerEl)
    .setName("Excluded folders")
    .setDesc("Folders that should never be processed.");

  folderSetting.addText((text) => {
    text.setPlaceholder("Select folder...");
    attachFolderSuggester(text.inputEl, (value) => text.setValue(value), tabInstance.plugin.app);
  });

  folderSetting.addButton((button) => {
    button
      .setButtonText("Add folder")
      .onClick(async () => {
        const input = folderSetting.controlEl.querySelector("input");
        const value = input?.value.trim();
        if (!value) {
          new Notice("Select a folder first.");
          return;
        }
        await addExclusionItem(tabInstance, "folders", value);
        tabInstance.display();
      });
  });

  exclusions.folders.forEach((folder) => {
    const row = new Setting(containerEl).setName(folder).setDesc("");
    row.addExtraButton((button) => {
      button
        .setIcon("trash")
        .setTooltip("Remove folder")
        .onClick(async () => {
          await removeExclusion(tabInstance, "folders", folder);
          tabInstance.display();
        });
    });
  });

  const patternSetting = new Setting(containerEl)
    .setName("Excluded patterns")
    .setDesc("File name patterns (glob) to skip, e.g., *.png.");

  patternSetting.addText((text) => {
    text.setPlaceholder("pattern e.g. *.png");
  });

  patternSetting.addButton((button) => {
    button
      .setButtonText("Add pattern")
      .onClick(async () => {
        const input = patternSetting.controlEl.querySelector("input");
        const value = input?.value.trim();
        if (!value) {
          new Notice("Enter a pattern to add.");
          return;
        }
        await addExclusionItem(tabInstance, "patterns", value);
        tabInstance.display();
      });
  });

  exclusions.patterns.forEach((pattern) => {
    const row = new Setting(containerEl).setName(pattern).setDesc("");
    row.addExtraButton((button) => {
      button
        .setIcon("trash")
        .setTooltip("Remove pattern")
        .onClick(async () => {
          await removeExclusion(tabInstance, "patterns", pattern);
          tabInstance.display();
        });
    });
  });
}

function getExclusionsWithDefaults(plugin: SystemSculptPlugin) {
  return plugin.settings.embeddingsExclusions || {
    folders: [],
    patterns: [],
    ignoreChatHistory: true,
    respectObsidianExclusions: true,
  };
}

async function updateExclusionSetting(
  tabInstance: SystemSculptSettingTab,
  key: "ignoreChatHistory" | "respectObsidianExclusions",
  value: boolean
) {
  const current = getExclusionsWithDefaults(tabInstance.plugin);
  await tabInstance.plugin.getSettingsManager().updateSettings({
    embeddingsExclusions: {
      ...current,
      [key]: value,
    },
  });
}

async function addExclusionItem(
  tabInstance: SystemSculptSettingTab,
  type: "folders" | "patterns",
  item: string
) {
  const current = getExclusionsWithDefaults(tabInstance.plugin);
  const updatedList = Array.from(new Set([...(current[type] || []), item]));
  await tabInstance.plugin.getSettingsManager().updateSettings({
    embeddingsExclusions: {
      ...current,
      [type]: updatedList,
    },
  });
}

async function removeExclusion(
  tabInstance: SystemSculptSettingTab,
  type: "folders" | "patterns",
  item: string
) {
  const current = getExclusionsWithDefaults(tabInstance.plugin);
  const updatedList = (current[type] || []).filter((entry) => entry !== item);
  await tabInstance.plugin.getSettingsManager().updateSettings({
    embeddingsExclusions: {
      ...current,
      [type]: updatedList,
    },
  });
}

async function buildStatusSummary(plugin: SystemSculptPlugin): Promise<string> {
  if (!plugin.settings.embeddingsEnabled) {
    return "Embeddings disabled";
  }

  const manager = plugin.embeddingsManager;
  if (!manager) {
    return "Ready to process files";
  }

  try {
    const stats = manager.getStats();
    const sealed = Math.min(stats.processed, stats.total);
    const present = Math.min(stats.present, stats.total);
    if (manager.isCurrentlyProcessing()) {
      if (stats.total > 0 && present === stats.total && sealed < stats.total) {
        return `Finalizing existing embeddings… ${sealed}/${stats.total} sealed`;
      }
      return `Processing… ${present}/${stats.total} embedded`;
    }
    if (stats.total > 0 && sealed === stats.total) {
      return `Ready for search (${stats.total} file${stats.total === 1 ? "" : "s"} embedded)`;
    }
    if (stats.total > 0) {
      if (present > 0 && present === stats.total && sealed < stats.total) {
        return `Finalizing existing embeddings… ${sealed}/${stats.total} sealed`;
      }
      return `${present}/${stats.total} file${stats.total === 1 ? "" : "s"} embedded`;
    }
    return "Ready to process files";
  } catch (_error) {
    return "Status unavailable";
  }
}
