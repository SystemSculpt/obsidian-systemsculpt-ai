import { Setting, Notice, TextComponent, ButtonComponent } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import type { ReadwiseOrganization, ReadwiseSyncInterval, ReadwiseSyncMode, ReadwiseTweetOrganization } from "../types/readwise";
import { READWISE_SYNC_INTERVAL_OPTIONS } from "../types/readwise";

export function displayDataTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab
) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "data";
  }
  const { plugin } = tabInstance;

  // Header
  containerEl.createEl("h3", { text: "Data Imports" });
  containerEl.createEl("p", {
    text: "Import and sync data from external services into your vault.",
    cls: "setting-item-description",
  });

  // ============================================================================
  // Readwise Section
  // ============================================================================

  containerEl.createEl("h4", { text: "Readwise" });

  // Enable toggle
  new Setting(containerEl)
    .setName("Enable Readwise integration")
    .setDesc("Import highlights, books, articles, and annotations from Readwise.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.readwiseEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ readwiseEnabled: value });

          // Start or stop scheduled sync
          const service = plugin.getReadwiseService();
          if (value && plugin.settings.readwiseSyncMode === "interval") {
            service.startScheduledSync();
          } else {
            service.stopScheduledSync();
          }

          tabInstance.display();
        });
    });

  // Only show remaining settings if enabled
  if (!plugin.settings.readwiseEnabled) {
    return;
  }

  // API Token
  renderApiTokenSetting(containerEl, tabInstance);

  // Destination folder
  new Setting(containerEl)
    .setName("Destination folder")
    .setDesc("Where to save imported Readwise content in your vault.")
    .addText((text) => {
      text
        .setPlaceholder("Readwise")
        .setValue(plugin.settings.readwiseDestinationFolder || "Readwise")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({
            readwiseDestinationFolder: value || "Readwise",
          });
        });
    });

  // Organization
  new Setting(containerEl)
    .setName("Organization")
    .setDesc("How to organize imported content into folders.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("by-category", "By category (Books/, Articles/, etc.)")
        .addOption("flat", "Flat (all in one folder)")
        .addOption("by-source", "By source (Kindle/, Instapaper/, etc.)")
        .setValue(plugin.settings.readwiseOrganization || "by-category")
        .onChange(async (value: ReadwiseOrganization) => {
          await plugin.getSettingsManager().updateSettings({
            readwiseOrganization: value,
          });
        });
    });

  // Tweet organization
  new Setting(containerEl)
    .setName("Tweet organization")
    .setDesc("How to organize saved tweets.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("standalone", "One file per tweet")
        .addOption("grouped", "Grouped by Twitter user")
        .setValue(plugin.settings.readwiseTweetOrganization || "standalone")
        .onChange(async (value: ReadwiseTweetOrganization) => {
          await plugin.getSettingsManager().updateSettings({
            readwiseTweetOrganization: value,
          });
        });
    });

  // Import Options
  containerEl.createEl("h5", { text: "Import options", cls: "setting-item-heading" });

  const importOptions = plugin.settings.readwiseImportOptions;

  new Setting(containerEl)
    .setName("Include highlights")
    .setDesc("Import highlighted text passages.")
    .addToggle((toggle) => {
      toggle.setValue(importOptions.highlights).onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          readwiseImportOptions: { ...importOptions, highlights: value },
        });
      });
    });

  new Setting(containerEl)
    .setName("Include document notes")
    .setDesc("Import notes attached to the entire book/article.")
    .addToggle((toggle) => {
      toggle.setValue(importOptions.bookNotes).onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          readwiseImportOptions: { ...importOptions, bookNotes: value },
        });
      });
    });

  new Setting(containerEl)
    .setName("Include tags")
    .setDesc("Import tags from Readwise as Obsidian tags.")
    .addToggle((toggle) => {
      toggle.setValue(importOptions.tags).onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          readwiseImportOptions: { ...importOptions, tags: value },
        });
      });
    });

  new Setting(containerEl)
    .setName("Include highlight notes")
    .setDesc("Import notes attached to individual highlights.")
    .addToggle((toggle) => {
      toggle.setValue(importOptions.includeHighlightNotes).onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          readwiseImportOptions: { ...importOptions, includeHighlightNotes: value },
        });
      });
    });

  new Setting(containerEl)
    .setName("Include source link")
    .setDesc("Add a link to the original source document (article URL, book page, etc.).")
    .addToggle((toggle) => {
      toggle.setValue(importOptions.fullDocument).onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          readwiseImportOptions: { ...importOptions, fullDocument: value },
        });
      });
    });

  new Setting(containerEl)
    .setName("Include saved date")
    .setDesc("Add the date when the item was saved/highlighted to frontmatter.")
    .addToggle((toggle) => {
      toggle.setValue(importOptions.includeSavedDate).onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          readwiseImportOptions: { ...importOptions, includeSavedDate: value },
        });
      });
    });

  // Sync Settings
  containerEl.createEl("h5", { text: "Sync settings", cls: "setting-item-heading" });

  new Setting(containerEl)
    .setName("Sync mode")
    .setDesc("When to automatically sync with Readwise.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("manual", "Manual only")
        .addOption("on-load", "When Obsidian starts")
        .addOption("interval", "On a schedule")
        .setValue(plugin.settings.readwiseSyncMode || "interval")
        .onChange(async (value: ReadwiseSyncMode) => {
          await plugin.getSettingsManager().updateSettings({
            readwiseSyncMode: value,
          });

          // Update scheduled sync
          const service = plugin.getReadwiseService();
          if (value === "interval") {
            service.startScheduledSync();
          } else {
            service.stopScheduledSync();
          }

          tabInstance.display();
        });
    });

  // Interval setting (only show if interval mode)
  if (plugin.settings.readwiseSyncMode === "interval") {
    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("How often to sync with Readwise.")
      .addDropdown((dropdown) => {
        for (const option of READWISE_SYNC_INTERVAL_OPTIONS) {
          dropdown.addOption(String(option.value), option.label);
        }
        dropdown.setValue(String(plugin.settings.readwiseSyncIntervalMinutes || 1440));
        dropdown.onChange(async (value) => {
          const minutes = parseInt(value, 10) as ReadwiseSyncInterval;
          await plugin.getSettingsManager().updateSettings({
            readwiseSyncIntervalMinutes: minutes,
          });
          // Restart scheduled sync with new interval
          const service = plugin.getReadwiseService();
          service.startScheduledSync();
        });
      });
  }

  // Sync Status
  renderSyncStatus(containerEl, tabInstance);

  // Sync Actions
  renderSyncActions(containerEl, tabInstance);
}

function renderApiTokenSetting(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab
) {
  const { plugin } = tabInstance;
  let tokenInput: TextComponent;
  let validateBtn: ButtonComponent;
  let statusEl: HTMLSpanElement;

  const tokenSetting = new Setting(containerEl)
    .setName("API token")
    .setDesc("Your Readwise access token. ")
    .addText((text) => {
      tokenInput = text;
      text
        .setPlaceholder("Enter your token...")
        .setValue(plugin.settings.readwiseApiToken || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({
            readwiseApiToken: value,
          });
          // Reset button if token changes
          validateBtn.setButtonText("Validate");
          validateBtn.buttonEl.classList.remove("mod-success");
          statusEl.setText("");
          statusEl.className = "readwise-status";
        });
      text.inputEl.type = "password";
      text.inputEl.style.width = "250px";
    })
    .addButton((button) => {
      validateBtn = button;
      button.setButtonText("Validate").onClick(async () => {
        const token = tokenInput.getValue();
        if (!token) {
          statusEl.setText("Enter a token first");
          statusEl.className = "readwise-status mod-warning";
          return;
        }

        button.setDisabled(true);
        button.setButtonText("Validating...");
        statusEl.setText("");
        statusEl.className = "readwise-status";

        try {
          const service = plugin.getReadwiseService();
          const valid = await service.validateApiToken(token);
          if (valid) {
            button.setButtonText("Validated");
            button.buttonEl.classList.add("mod-success");
          } else {
            button.setButtonText("Validate");
            statusEl.setText("Invalid token");
            statusEl.className = "readwise-status mod-error";
          }
        } catch (error) {
          button.setButtonText("Validate");
          statusEl.setText("Validation failed");
          statusEl.className = "readwise-status mod-error";
        } finally {
          button.setDisabled(false);
        }
      });
    });

  // Add status element (for errors only now)
  statusEl = tokenSetting.controlEl.createSpan({ cls: "readwise-status" });

  // Add help link
  const helpLink = tokenSetting.descEl.createEl("a", {
    text: "Get your token",
    href: "https://readwise.io/access_token",
  });
  helpLink.setAttr("target", "_blank");
  tokenSetting.descEl.createSpan({ text: " from Readwise." });
}

function renderSyncStatus(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab
) {
  const { plugin } = tabInstance;
  const service = plugin.getReadwiseService();
  const syncState = service.getSyncState();
  const lastSync = plugin.settings.readwiseLastSyncTimestamp;

  containerEl.createEl("h5", { text: "Sync status", cls: "setting-item-heading" });

  const statusContainer = containerEl.createDiv({ cls: "readwise-sync-status-container" });

  // Last sync time
  if (lastSync && lastSync > 0) {
    const lastSyncDate = new Date(lastSync);
    const formattedDate = lastSyncDate.toLocaleString();
    statusContainer.createDiv({
      text: `Last sync: ${formattedDate}`,
      cls: "readwise-sync-info",
    });
  } else {
    statusContainer.createDiv({
      text: "Never synced",
      cls: "readwise-sync-info",
    });
  }

  // Total imported
  if (syncState.totalImported > 0) {
    statusContainer.createDiv({
      text: `Total imported: ${syncState.totalImported} items`,
      cls: "readwise-sync-info",
    });
  }

  // Next scheduled sync
  if (plugin.settings.readwiseSyncMode === "interval" && lastSync) {
    const intervalMs = (plugin.settings.readwiseSyncIntervalMinutes || 1440) * 60 * 1000;
    const nextSync = new Date(lastSync + intervalMs);
    if (nextSync > new Date()) {
      statusContainer.createDiv({
        text: `Next sync: ${nextSync.toLocaleString()}`,
        cls: "readwise-sync-info",
      });
    }
  }

  // Error message
  if (syncState.lastError) {
    statusContainer.createDiv({
      text: `Last error: ${syncState.lastError}`,
      cls: "readwise-sync-error",
    });
  }
}

function renderSyncActions(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab
) {
  const { plugin } = tabInstance;
  const service = plugin.getReadwiseService();

  const actionsContainer = containerEl.createDiv({ cls: "readwise-sync-actions" });

  // Sync Now button
  let syncButton: ButtonComponent;
  let progressEl: HTMLDivElement | null = null;

  new Setting(actionsContainer)
    .setName("Sync now")
    .setDesc("Import new and updated highlights from Readwise.")
    .addButton((button) => {
      syncButton = button;
      button
        .setButtonText("Sync Now")
        .setCta()
        .onClick(async () => {
          if (!plugin.settings.readwiseApiToken) {
            new Notice("Please enter your Readwise API token first");
            return;
          }

          if (service.isCurrentlySyncing()) {
            service.cancelSync();
            button.setButtonText("Sync Now");
            if (progressEl) {
              progressEl.remove();
              progressEl = null;
            }
            return;
          }

          button.setButtonText("Cancel");

          // Add progress element
          progressEl = actionsContainer.createDiv({ cls: "readwise-progress" });
          progressEl.createDiv({ cls: "readwise-progress-bar" });
          const progressText = progressEl.createDiv({ cls: "readwise-progress-text" });
          progressText.setText("Starting sync...");

          // Listen for progress events
          const unsubProgress = service.on("sync:progress", ({ current, total, currentItem }) => {
            progressText.setText(`Syncing: ${current}/${total} - ${currentItem || ""}`);
            const progressBar = progressEl?.querySelector(".readwise-progress-bar") as HTMLElement;
            if (progressBar && total > 0) {
              progressBar.style.width = `${(current / total) * 100}%`;
            }
          });

          const unsubComplete = service.on("sync:completed", (result) => {
            unsubProgress();
            unsubComplete();
            button.setButtonText("Sync Now");
            if (progressEl) {
              progressEl.remove();
              progressEl = null;
            }
            tabInstance.display(); // Refresh to show updated status
          });

          const unsubError = service.on("sync:error", () => {
            unsubProgress();
            unsubComplete();
            unsubError();
            button.setButtonText("Sync Now");
            if (progressEl) {
              progressEl.remove();
              progressEl = null;
            }
            tabInstance.display();
          });

          await service.syncIncremental();
        });
    });

  // Full Re-sync button
  new Setting(actionsContainer)
    .setName("Full re-sync")
    .setDesc("Re-import all highlights from Readwise, ignoring previous sync state.")
    .addButton((button) => {
      button.setButtonText("Full Re-sync").onClick(async () => {
        if (!plugin.settings.readwiseApiToken) {
          new Notice("Please enter your Readwise API token first");
          return;
        }

        if (service.isCurrentlySyncing()) {
          new Notice("A sync is already in progress");
          return;
        }

        button.setDisabled(true);
        button.setButtonText("Syncing...");

        try {
          await service.syncAll();
          tabInstance.display();
        } finally {
          button.setDisabled(false);
          button.setButtonText("Full Re-sync");
        }
      });
    });
}
