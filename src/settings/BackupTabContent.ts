import { App, Setting, Notice } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { showPopup } from "../core/ui";
import { BackupRestoreModal } from "../core/settings/BackupRestoreModal";


export function displayBackupTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains('systemsculpt-tab-content')) {
    containerEl.dataset.tab = "backup";
  }
  const { app, plugin } = tabInstance;

  containerEl.createEl('h3', { text: 'Settings backup' });

  new Setting(containerEl)
    .setName('Automatic backups')
    .setDesc('Create a backup every 24 hours. Backups include providers, favorites, and preferences.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.automaticBackupsEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ automaticBackupsEnabled: value });
          const backupService = plugin.getSettingsManager().getAutomaticBackupService();
          if (value) {
            backupService.start();
            new Notice('Automatic backups enabled');
          } else {
            backupService.stop();
            new Notice('Automatic backups disabled');
          }
        });
    });

  new Setting(containerEl)
    .setName('Manual backups')
    .setDesc('Create or restore backups on demand. Files live in .systemsculpt/settings-backups inside your vault.');

  const restoreSetting = new Setting(containerEl)
    .setName('Restore from backup')
    .setDesc('Replace your current settings with a saved backup.')
    .addButton((button) => {
      button
        .setButtonText('Select backup')
        .onClick(async () => {
          const backupModal = new BackupRestoreModal(app, plugin);
          const selectedBackupPath = await backupModal.open();
          if (!selectedBackupPath) return;

          const confirmRestore = async (details: string | null) => {
            const description = details
              ? `This will replace your current settings.

${details}

Continue?`
              : 'This will replace your current settings with the selected backup. Continue?';
            const confirmed = await showPopup(app, 'Restore settings from backup', {
              description,
              primaryButton: 'Restore',
              secondaryButton: 'Cancel',
            });
            if (confirmed?.confirmed) {
              const success = await backupModal.restoreFromBackup(selectedBackupPath);
              if (success) {
                tabInstance.display();
              }
            }
          };

          try {
            const backupData = await plugin.app.vault.adapter.read(selectedBackupPath);
            const backupSettings = JSON.parse(backupData);
            const customProviders = Array.isArray(backupSettings.customProviders) ? backupSettings.customProviders.length : 0;
            const favoriteModels = Array.isArray(backupSettings.favoriteModels) ? backupSettings.favoriteModels.length : 0;
            const selectedModel = backupSettings.selectedModelId ? String(backupSettings.selectedModelId).split(':').pop() : 'Default';
            const details = `This backup contains:
• ${customProviders} custom provider${customProviders === 1 ? '' : 's'}
• ${favoriteModels} favorite model${favoriteModels === 1 ? '' : 's'}
• Selected model: ${selectedModel}
• License status: ${backupSettings.licenseValid ? 'Active' : 'Inactive'}`;
            await confirmRestore(details);
          } catch (error) {
            await confirmRestore(null);
          }
        });
    });

  new Setting(containerEl)
    .setName('Backup folder')
    .setDesc('Open the folder where backups are stored.')
    .addButton((button) => {
      button
        .setButtonText('Open folder')
        .onClick(async () => {
          try {
            const backupDir = '.systemsculpt/settings-backups';
            try {
              await plugin.app.vault.createFolder(backupDir);
            } catch (_) {
              // folder already exists
            }
            if (typeof (plugin.app.vault.adapter as any).revealInFolder === 'function') {
              (plugin.app.vault.adapter as any).revealInFolder(backupDir);
            } else {
              new Notice(`Backups are stored in: ${backupDir}`);
            }
          } catch (error) {
            new Notice('Failed to open backup folder');
          }
        });
    });

  new Setting(containerEl)
    .setName('Tips')
    .setDesc('Automatic backups run in the background. Manual backups with custom names are useful before big changes. You can copy backup files to other devices to share configurations.');
}
