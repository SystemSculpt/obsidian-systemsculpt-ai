import { SystemSculptSettings } from "../../types";
import SystemSculptPlugin from "../../main";
import { Notice } from "obsidian";

/**
 * Service for handling automatic periodic backups of settings
 */
export class AutomaticBackupService {
    private plugin: SystemSculptPlugin;
    private backupTimer: NodeJS.Timeout | null = null;
    private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

    constructor(plugin: SystemSculptPlugin) {
        this.plugin = plugin;
    }

    /**
     * Start the automatic backup service
     */
    public start(): void {
        this.stop(); // Clean up any existing timer
        
        // Start the periodic check
        this.backupTimer = setInterval(() => {
            this.checkAndCreateBackup();
        }, this.CHECK_INTERVAL_MS);

        // Also check immediately on start
        this.checkAndCreateBackup();
    }

    /**
     * Stop the automatic backup service
     */
    public stop(): void {
        if (this.backupTimer) {
            clearInterval(this.backupTimer);
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

            const now = Date.now();
            const intervalMs = settings.automaticBackupInterval * 60 * 60 * 1000; // Convert hours to milliseconds
            const lastBackup = settings.lastAutomaticBackup;

            // Check if it's time for a backup
            if (now - lastBackup >= intervalMs) {
                await this.createAutomaticBackup();
            }
        } catch (error) {
        }
    }

    /**
     * Force create an automatic backup now
     */
    public async createAutomaticBackup(): Promise<boolean> {
        try {
            const settings = this.plugin.getSettingsManager().getSettings();
            
            // Create backup data with metadata
            const backupData = {
                ...settings,
                _backupMeta: {
                    type: 'automatic',
                    timestamp: Date.now(),
                    createdAt: new Date().toISOString(),
                    version: '1.0'
                }
            };

            // Generate backup filename with current date
            const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            const fileName = `settings-backup-${dateStr}.json`;
            
            // Create backup in multiple locations for redundancy
            await this.saveBackupToMultipleLocations(fileName, backupData);
            
            // Update the last backup timestamp
            await this.plugin.getSettingsManager().updateSettings({
                lastAutomaticBackup: Date.now()
            });

            // Clean up old backups
            await this.cleanupOldBackups();

            return true;
        } catch (error) {
            new Notice("Failed to create automatic settings backup", 3000);
            return false;
        }
    }

    /**
     * Save backup to multiple locations for redundancy
     */
    private async saveBackupToMultipleLocations(fileName: string, backupData: any): Promise<void> {
        const backupJson = JSON.stringify(backupData, null, 2);
        const errors: string[] = [];

        // Location 1: Vault root .systemsculpt directory  
        try {
            const backupDir = ".systemsculpt/settings-backups";
            
            // Ensure backup directory exists
            try {
                await this.plugin.app.vault.createFolder(backupDir);
            } catch (e) {
                // Directory might already exist, which is fine
            }
            
            const backupPath = `.systemsculpt/settings-backups/${fileName}`;
            await this.plugin.app.vault.adapter.write(backupPath, backupJson);
        } catch (error) {
            errors.push(`Vault backup directory: ${error}`);
        }

        // Location 2: Vault storage (if available)
        try {
            if (this.plugin.storage) {
                await this.plugin.storage.writeFile('settings', `backups/${fileName}`, backupData);
            }
        } catch (error) {
            errors.push(`Vault storage: ${error}`);
        }

        // If all locations failed, throw error
        if (errors.length === 2) {
            throw new Error(`Failed to save backup to any location: ${errors.join(', ')}`);
        }
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

            // Clean up from vault storage
            await this.cleanupVaultStorageBackups(cutoffTime);

        } catch (error) {
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
            const automaticBackupFiles = files.files.filter(f => 
                f.includes('settings-backup-') && 
                f.endsWith('.json') && 
                !f.includes('latest') && 
                !f.includes('manual') && 
                !f.includes('emergency') &&
                f.match(/settings-backup-\d{4}-\d{2}-\d{2}\.json$/) // Only date-based automatic backups
            );

            for (const filePath of automaticBackupFiles) {
                try {
                    // Get file stats to check creation time
                    const stats = await this.plugin.app.vault.adapter.stat(filePath);
                    if (stats && stats.mtime < cutoffTime) {
                        await this.plugin.app.vault.adapter.remove(filePath);
                    }
                } catch (error) {
                }
            }
        } catch (error) {
        }
    }

    /**
     * Clean up old backups from vault storage
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
                } catch (error) {
                }
            }
        } catch (error) {
        }
    }

    /**
     * Get the status of the automatic backup system
     */
    public getBackupStatus(): {
        enabled: boolean;
        lastBackup: number;
        nextBackup: number;
        intervalHours: number;
        retentionDays: number;
    } {
        const settings = this.plugin.getSettingsManager().getSettings();
        const nextBackup = settings.lastAutomaticBackup + (settings.automaticBackupInterval * 60 * 60 * 1000);

        return {
            enabled: settings.automaticBackupsEnabled,
            lastBackup: settings.lastAutomaticBackup,
            nextBackup: nextBackup,
            intervalHours: settings.automaticBackupInterval,
            retentionDays: settings.automaticBackupRetentionDays
        };
    }
}