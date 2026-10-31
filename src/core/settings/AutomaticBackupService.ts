import SystemSculptPlugin from "../../main";
import { Notice } from "obsidian";
import { redactSettingsForBackup } from "./backupSanitizer";

/**
 * Service for handling automatic periodic backups of settings
 */
export class AutomaticBackupService {
    private plugin: SystemSculptPlugin;
    private backupTimer: number | null = null;
    private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

    constructor(plugin: SystemSculptPlugin) {
        this.plugin = plugin;
    }

    /**
     * Arm the hourly check while automatic backups are enabled and clear it
     * while they are off. Safe to call again after any settings change.
     */
    public start(): void {
        let enabled = false;
        try {
            enabled = this.plugin.isPluginUnloading?.() !== true
                && this.plugin.getSettingsManager().getSettings().automaticBackupsEnabled === true;
        } catch {
            // Unreadable settings arm nothing; the next load or toggle retries.
        }
        if (!enabled) {
            this.stop();
            return;
        }
        if (this.backupTimer !== null) return;

        // registerInterval also lets Obsidian clear the timer on plugin
        // unload, so a teardown path that never reaches stop() cannot leak it.
        this.backupTimer = this.plugin.registerInterval(window.setInterval(() => {
            void this.checkAndCreateBackup();
        }, this.CHECK_INTERVAL_MS));

        // Also check immediately on start
        void this.checkAndCreateBackup();
    }

    /**
     * Stop the automatic backup service
     */
    public stop(): void {
        if (this.backupTimer !== null) {
            window.clearInterval(this.backupTimer);
            this.backupTimer = null;
        }
    }

    /**
     * Check if a backup is needed and create one if so
     */
    private async checkAndCreateBackup(): Promise<void> {
        try {
            const settings = this.plugin.getSettingsManager().getSettings();
            
            // Skip if automatic backups are disabled
            if (!settings.automaticBackupsEnabled) {
                return;
            }

            const timer = this.backupTimer;
            const lastBackup = await this.getLastAutomaticBackupTime();

            // A settings toggle or teardown may have happened during the scan.
            const current = this.plugin.getSettingsManager().getSettings();
            if (timer === null || this.backupTimer !== timer || this.plugin.isPluginUnloading?.() === true
                || !current.automaticBackupsEnabled) return;
            const intervalMs = current.automaticBackupInterval * 60 * 60 * 1000;
            if (Date.now() - lastBackup >= intervalMs) {
                await this.createAutomaticBackup();
            }
        } catch {
            // Scheduled backups retry at the next interval.
        }
    }

    /**
     * Use dated automatic backups as the clock, including after a restart.
     * The latest-save snapshot changes on every settings save and must not
     * postpone automatic backup history. Manual and emergency copies do not
     * count toward the automatic interval either.
     */
    private async getLastAutomaticBackupTime(): Promise<number> {
        const adapter = this.plugin.app.vault.adapter;
        const backupDir = ".systemsculpt/settings-backups";
        if (!await adapter.exists(backupDir)) return 0;
        // Enumeration errors are not proof of absence. Let the scheduled check
        // retry later rather than overwrite a recent dated snapshot.
        const files = await adapter.list(backupDir);
        const times = await Promise.all(files.files.filter(path => this.isAutomaticBackup(path)).map(async path => {
            try {
                const stats = await adapter.stat(path);
                // Synced files can carry another device's incorrect clock.
                return stats && Number.isFinite(stats.mtime) && stats.mtime <= Date.now()
                    ? stats.mtime : 0;
            } catch {
                return null;
            }
        }));
        let lastBackup = 0;
        for (const time of times) {
            // An unknown age is not proof that overwriting today's snapshot is
            // safe. Missing files return null from stat and map to zero above.
            if (time === null) throw new Error("Cannot determine automatic backup age");
            lastBackup = Math.max(lastBackup, time);
        }
        return lastBackup;
    }

    private isAutomaticBackup(filePath: string): boolean {
        return filePath.includes('settings-backup-')
            && filePath.endsWith('.json')
            && !filePath.includes('latest')
            && !filePath.includes('manual')
            && !filePath.includes('emergency')
            && /settings-backup-\d{4}-\d{2}-\d{2}\.json$/.test(filePath);
    }

    /**
     * Force create an automatic backup now
     */
    public async createAutomaticBackup(): Promise<boolean> {
        try {
            const settings = this.plugin.getSettingsManager().getSettings();
            const redactedSettings = redactSettingsForBackup(settings as unknown as Record<string, unknown>);
            
            // Create backup data with metadata
            const backupData = {
                ...redactedSettings,
                _backupMeta: {
                    type: 'automatic',
                    timestamp: Date.now(),
                    createdAt: new Date().toISOString(),
                    version: '1.1',
                    redactedSecrets: true,
                }
            };

            // Generate backup filename with current date
            const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            const fileName = `settings-backup-${dateStr}.json`;
            
            await this.saveBackup(fileName, backupData);
            
            // Clean up old backups
            await this.cleanupOldBackups();

            return true;
        } catch {
            new Notice("Failed to create automatic settings backup", 3000);
            return false;
        }
    }

    /**
     * Save the backup to .systemsculpt/settings-backups, the folder the
     * backup settings open and restore from
     */
    private async saveBackup(fileName: string, backupData: object): Promise<void> {
        const backupDir = ".systemsculpt/settings-backups";
        try {
            await this.plugin.app.vault.createFolder(backupDir);
        } catch {
            // The write below determines whether the folder is usable.
        }
        await this.plugin.app.vault.adapter.write(
            `${backupDir}/${fileName}`, JSON.stringify(backupData, null, 2),
        );
    }

    /**
     * Clean up old automatic backups based on retention settings
     */
    private async cleanupOldBackups(): Promise<void> {
        try {
            const settings = this.plugin.getSettingsManager().getSettings();
            const retentionMs = settings.automaticBackupRetentionDays * 24 * 60 * 60 * 1000; // Convert days to milliseconds
            const cutoffTime = Date.now() - retentionMs;

            // Clean up from vault root directory
            await this.cleanupVaultRootBackups(cutoffTime);

            // Prune the copies older versions also wrote to the hidden folder
            await this.cleanupVaultStorageBackups(cutoffTime);

        } catch {
            // Cleanup is best-effort and runs again after the next backup.
        }
    }

    /**
     * Clean up old backups from vault root directory
     */
    private async cleanupVaultRootBackups(cutoffTime: number): Promise<void> {
        try {
            const backupDir = ".systemsculpt/settings-backups";
            
            // Check if backup directory exists
            const exists = await this.plugin.app.vault.adapter.exists(backupDir);
            if (!exists) {
                return;
            }

            // List all files in backup directory
            const files = await this.plugin.app.vault.adapter.list(backupDir);
            
            // Filter for automatic backup files (date-based pattern)
            const automaticBackupFiles = files.files.filter(filePath => this.isAutomaticBackup(filePath));

            for (const filePath of automaticBackupFiles) {
                try {
                    // Get file stats to check creation time
                    const stats = await this.plugin.app.vault.adapter.stat(filePath);
                    if (stats && stats.mtime < cutoffTime) {
                        await this.plugin.app.vault.adapter.remove(filePath);
                    }
                } catch {
                    // Continue cleaning the remaining backups.
                }
            }
        } catch {
            // A missing backup directory requires no cleanup.
        }
    }

    /**
     * Clean up old copies in the hidden .systemsculpt/settings/backups folder.
     * Nothing writes there any more; settings load still restores from these
     * copies, and they age out under the same retention.
     */
    private async cleanupVaultStorageBackups(cutoffTime: number): Promise<void> {
        try {
            if (!this.plugin.storage) {
                return;
            }

            // List backup files
            const backupFiles = await this.plugin.storage.listFiles('settings', 'backups');
            
            // Filter for automatic backup files
            const automaticBackupFiles = backupFiles.filter(f => 
                f.startsWith('settings-backup-') && 
                f.endsWith('.json') && 
                !f.includes('latest') && 
                !f.includes('manual') && 
                !f.includes('emergency')
            );

            for (const fileName of automaticBackupFiles) {
                try {
                    // Extract date from filename to check age
                    const dateMatch = fileName.match(/settings-backup-(\d{4}-\d{2}-\d{2})\.json/);
                    if (dateMatch) {
                        const backupDate = new Date(dateMatch[1]).getTime();
                        if (backupDate < cutoffTime) {
                            await this.plugin.storage.deleteFile('settings', `backups/${fileName}`);
                        }
                    }
                } catch {
                    // Continue cleaning the remaining backups.
                }
            }
        } catch {
            // A missing backup directory requires no cleanup.
        }
    }

}
