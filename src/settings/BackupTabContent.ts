import { FileSystemAdapter, Notice } from "obsidian";
import { createCatalogSetting } from "./SettingsCatalog";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showPrompt } from "../core/ui/modals/PromptModal";
import { BackupRestoreModal } from "../core/settings/BackupRestoreModal";
import { hasHostCapability, openLocalFolder } from "../platform/hostCapabilities";


export function displayBackupTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains('systemsculpt-tab-content')) {
    containerEl.dataset.tab = "workspace";
  }
  const { app, plugin } = tabInstance;

  containerEl.createEl('h3', { text: 'Settings backup' });

  createCatalogSetting(containerEl, "workspace.automatic-backups")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.automaticBackupsEnabled)
        .onChange(async (value) => {
          // The settings manager arms or clears the backup timer on this change.
          await plugin.getSettingsManager().updateSettings({ automaticBackupsEnabled: value });
        });
    });

  createCatalogSetting(containerEl, "workspace.manual-backups");

  createCatalogSetting(containerEl, "workspace.restore-backup")
    .addButton((button) => {
      button
        .setButtonText('Select backup')
        .onClick(async () => {
          const backupModal = new BackupRestoreModal(app, plugin);
          const selectedBackupPath = await backupModal.open();
          if (!selectedBackupPath) return;

          const confirmRestore = async (details: string | null) => {
            const description = details
              ? `Replace your current settings with this backup?

${details}`
              : 'Replace your current settings with the selected backup?';
            const confirmed = await showPrompt(app, 'Restore settings from backup', {
              description,
              primaryButton: 'Restore',
              secondaryButton: 'Cancel',
            });
            if (confirmed?.confirmed) {
              const success = await backupModal.restoreFromBackup(selectedBackupPath);
              if (success) {
                tabInstance.refreshSettings();
              }
            }
          };

          try {
            const backupData = await plugin.app.vault.adapter.read(selectedBackupPath);
            const backupSettings = JSON.parse(backupData);
            const details = `This backup contains:
• Chat display defaults and client-side workspace preferences
• Embeddings and audio settings
• License status: ${backupSettings.licenseValid ? 'Active' : 'Inactive'}`;
            await confirmRestore(details);
          } catch {
            await confirmRestore(null);
          }
        });
    });

  const backupFolderSetting = createCatalogSetting(containerEl, "workspace.backup-folder");
  if (hasHostCapability("file-manager-reveal", containerEl)) {
    backupFolderSetting.addButton((button) => {
      button
        .setButtonText('Open folder')
        .onClick(async () => {
          try {
            const backupDir = '.systemsculpt/settings-backups';
            try {
              await plugin.app.vault.createFolder(backupDir);
            } catch {
              // folder already exists
            }
            const adapter = plugin.app.vault.adapter;
            const opened = adapter instanceof FileSystemAdapter
              ? await openLocalFolder(adapter.getFullPath(backupDir), containerEl)
              : false;
            if (!opened) {
              new Notice(`Backups are stored in: ${backupDir}`);
            }
          } catch {
            new Notice('Failed to open backup folder');
          }
        });
    });
  }

  createCatalogSetting(containerEl, "workspace.backup-tips");
}
