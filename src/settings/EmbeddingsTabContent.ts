import { Setting, Notice } from "obsidian";
import { createCatalogSetting } from "./SettingsCatalog";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type SystemSculptPlugin from "../main";
import { EmbeddingsPendingFilesModal } from "../modals/EmbeddingsPendingFilesModal";
import { confirmSimilarNotesRebuild } from "../modals/SimilarNotesRebuildConfirmation";

export async function displayEmbeddingsTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "knowledge";
  }

  containerEl.createEl("h3", { text: "Semantic search" });
  containerEl.createEl("p", {
    text: "Find related notes by meaning.",
    cls: "setting-item-description",
  });

  const core = containerEl.createDiv();
  const processing = containerEl.createDiv();
  const exclusions = containerEl.createDiv();
  const refreshProcessing = () => {
    processing.empty();
    tabInstance.invalidateSearchIndex();
    if (tabInstance.plugin.settings.embeddingsEnabled) {
      const refreshStatus = renderProcessingSection(processing, tabInstance);
      void refreshStatus();
    }
  };
  renderCoreSettingsSection(core, tabInstance, refreshProcessing);
  refreshProcessing();
  renderExclusionsSection(exclusions, tabInstance);
}

function renderCoreSettingsSection(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab, refreshProcessing: () => void): void {
  const { plugin } = tabInstance;
  createCatalogSetting(containerEl, "knowledge.similar-notes")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.embeddingsEnabled || false)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ embeddingsEnabled: value });

          if (value) {
            try {
              const manager = plugin.getOrCreateEmbeddingsManager();
              plugin.embeddingsStatusBar?.startMonitoring(manager);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : "Failed to initialize embeddings.";
              new Notice(message);
            }
          } else {
            plugin.embeddingsStatusBar?.stopMonitoring();
          }

          refreshProcessing();
        });
    });
}

function renderProcessingSection(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;

  const statusSetting = createCatalogSetting(containerEl, "knowledge.index-status").setDesc("");
  const statusText = statusSetting.descEl.createSpan();

  const refreshStatus = async () => {
    statusText.setText(await buildStatusSummary(plugin));
    tabInstance.invalidateSearchIndex();
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
          await manager.awaitReady();
          new EmbeddingsPendingFilesModal(plugin.app, plugin).open();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unable to open remaining files.";
          new Notice(message);
        } finally {
          button.setDisabled(false);
        }
      });
  });

  createCatalogSetting(containerEl, "knowledge.rebuild-index")
    .addButton((button) => {
      button
        .setWarning()
        .setButtonText("Rebuild")
        .onClick(async () => {
          if (!await confirmSimilarNotesRebuild(tabInstance.app)) return;

          button.setDisabled(true).setButtonText("Rebuilding…");
          try {
            const manager = plugin.getOrCreateEmbeddingsManager();
            await manager.forceRefreshCurrentNamespace();
            await refreshStatus();
          } catch (error: unknown) {
            new Notice(`Failed to rebuild the semantic index: ${error instanceof Error ? error.message : "Unknown error"}`);
          } finally {
            button.setDisabled(false).setButtonText("Rebuild");
          }
        });
    });

  return refreshStatus;
}

function renderExclusionsSection(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  tabInstance.invalidateSearchIndex();
  const { plugin } = tabInstance;
  const exclusions = getExclusionsWithDefaults(plugin);

  containerEl.createEl("h3", { text: "Skip from index" });
  containerEl.createEl("p", {
    text: "Choose vault content similar notes should ignore.",
    cls: "setting-item-description",
  });

  createCatalogSetting(containerEl, "knowledge.exclude-chat-history")
    .addToggle((toggle) => {
      toggle
        .setValue(exclusions.ignoreChatHistory)
        .onChange(async (value) => {
          await updateExclusionSetting(tabInstance, "ignoreChatHistory", value);
          renderExclusionsSection(containerEl, tabInstance);
        });
    });

  createCatalogSetting(containerEl, "knowledge.respect-exclusions")
    .addToggle((toggle) => {
      toggle
        .setValue(exclusions.respectObsidianExclusions)
        .onChange(async (value) => {
          await updateExclusionSetting(tabInstance, "respectObsidianExclusions", value);
          renderExclusionsSection(containerEl, tabInstance);
        });
    });

  const folderSetting = createCatalogSetting(containerEl, "knowledge.excluded-folders");

  folderSetting.addText((text) => {
    text.setPlaceholder("Select folder...");
    attachFolderSuggester(text.inputEl, (value) => {
      text.setValue(value);
    }, tabInstance.plugin.app);
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
        renderExclusionsSection(containerEl, tabInstance);
      });
  });

  exclusions.folders.forEach((folder, index) => {
    const row = new Setting(containerEl).setName(folder).setDesc("");
    row.settingEl.dataset.ssSetting = `knowledge.folders.${index}`;
    row.addExtraButton((button) => {
      button
        .setIcon("trash")
        .setTooltip("Remove folder")
        .onClick(async () => {
          await removeExclusion(tabInstance, "folders", folder);
          renderExclusionsSection(containerEl, tabInstance);
        });
    });
  });

  const patternSetting = createCatalogSetting(containerEl, "knowledge.excluded-patterns");

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
        renderExclusionsSection(containerEl, tabInstance);
      });
  });

  exclusions.patterns.forEach((pattern, index) => {
    const row = new Setting(containerEl).setName(pattern).setDesc("");
    row.settingEl.dataset.ssSetting = `knowledge.patterns.${index}`;
    row.addExtraButton((button) => {
      button
        .setIcon("trash")
        .setTooltip("Remove pattern")
        .onClick(async () => {
          await removeExclusion(tabInstance, "patterns", pattern);
          renderExclusionsSection(containerEl, tabInstance);
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
    return "Off";
  }

  const manager = plugin.embeddingsManager;
  if (!manager) {
    return "Starting…";
  }

  try {
    const snapshot = manager.getLifecycleSnapshot();
    // An index that could not open reports its error instead of "Starting".
    if (snapshot.phase === "initializing" || (!snapshot.ready && snapshot.phase !== "error")) return "Starting…";
    if (snapshot.phase === "paused") return snapshot.pending > 0
      ? `Paused · ${snapshot.pending} remaining`
      : "Paused";
    if (snapshot.phase === "error" || snapshot.failed > 0) return snapshot.failed > 0
      ? `${snapshot.failed} ${snapshot.failed === 1 ? "note needs" : "notes need"} attention`
      : "Needs attention";
    if (snapshot.phase === "reconciling" || snapshot.pending > 0) {
      const total = Math.max(snapshot.total, snapshot.completed + snapshot.pending);
      return total > 0
        ? `Indexing ${Math.min(snapshot.completed, total)} of ${total}`
        : "Updating…";
    }
    return snapshot.total > 0
      ? `${snapshot.completed} ${snapshot.completed === 1 ? "note" : "notes"} indexed`
      : "Ready";
  } catch {
    return "Status unavailable";
  }
}
