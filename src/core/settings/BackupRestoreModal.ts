import { App, setIcon, Notice, TextComponent } from "obsidian";
import { ListSelectionModal, ListItem } from "../ui/modals/standard/ListSelectionModal";
import SystemSculptPlugin from "../../main";

/**
 * Modal for displaying and restoring settings backups
 */
export class BackupRestoreModal {
    private plugin: SystemSculptPlugin;
    private app: App;

    constructor(app: App, plugin: SystemSculptPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * Opens the backup restore modal and returns the selected backup file path,
     * or null if cancelled
     */
    async open(): Promise<string | null> {
        try {
            // Get all backup files
            const backups = await this.getAvailableBackups();
            
            if (backups.length === 0) {
                // No backups found
                new Notice("No settings backups found", 3000);
                return null;
            }

            // Convert backups to list items with special handling for descriptions
            const items: ListItem[] = backups.map(backup => ({
                id: backup.path,
                title: backup.name,
                description: '', // We'll handle description specially
                icon: 'save',
                // Store details in a custom property
                _backupDetails: backup.details || backup.date
            }));

            // Open selection modal
            const modal = new ListSelectionModal(this.app, items, {
                title: "Restore Settings from Backup",
                description: "Select a backup to restore. This will replace your current settings.",
                placeholder: "Search backups...",
                emptyText: "No backups found",
                size: "medium",
                closeOnSelect: true,
                // Add custom content handler to display details properly and add create backup button
                customContent: (containerEl) => {
                    // Add a small style block for our custom formatting
                    const styleEl = document.createElement('style');
                    styleEl.textContent = `
                        .backup-details {
                            font-size: 12px;
                            color: var(--text-muted);
                            white-space: normal !important;
                            overflow: visible !important;
                            text-overflow: clip !important;
                            line-height: 1.5;
                            margin-top: 4px;
                        }
                        .backup-detail-item {
                            display: inline-block;
                            margin-right: 8px;
                            background: var(--background-secondary);
                            padding: 2px 6px;
                            border-radius: 4px;
                            margin-bottom: 4px;
                        }
                        .create-backup-button {
                            display: flex;
                            padding: 10px;
                            margin-bottom: 10px;
                            background: var(--background-secondary);
                            border-radius: 5px;
                            align-items: center;
                            cursor: pointer;
                            transition: background-color 0.2s;
                        }
                        .create-backup-button:hover {
                            background: var(--background-modifier-hover);
                        }
                        .create-backup-icon {
                            margin-right: 8px;
                            color: var(--text-accent);
                        }
                        .create-backup-text {
                            flex-grow: 1;
                        }
                        .create-backup-text-main {
                            font-weight: 500;
                            margin-bottom: 2px;
                        }
                        .create-backup-text-sub {
                            font-size: 12px;
                            color: var(--text-muted);
                        }
                        .manual-backup-container {
                            margin-bottom: 10px;
                            padding: 10px;
                            background: var(--background-secondary);
                            border-radius: 5px;
                        }
                    `;
                    containerEl.appendChild(styleEl);
                    
                    // Container for manual backup input and button
                    const manualBackupContainer = containerEl.createDiv({ cls: 'manual-backup-container' });
                    manualBackupContainer.style.marginBottom = '10px'; // Add some spacing
                    manualBackupContainer.style.padding = '10px';
                    manualBackupContainer.style.background = 'var(--background-secondary)';
                    manualBackupContainer.style.borderRadius = '5px';

                    const inputPromptEl = manualBackupContainer.createEl('p', { text: 'Enter a name for the new manual backup:'});
                    inputPromptEl.style.marginBottom = '5px';
                    
                    const backupNameInput = new TextComponent(manualBackupContainer)
                        .setPlaceholder(`Manual backup ${new Date().toLocaleString()}`)
                        .setValue(`Manual backup ${new Date().toLocaleString()}`); // Pre-fill with default
                    
                    backupNameInput.inputEl.style.width = '100%';
                    backupNameInput.inputEl.style.marginBottom = '8px';

                    // Create backup button
                    const createBackupButton = manualBackupContainer.createEl('button', {
                        text: 'Create Manual Backup',
                        cls: 'mod-cta' // Obsidian's call-to-action button style
                    });
                    // setIcon(createBackupButton, 'plus-circle'); // Add icon to button itself, if desired
                    createBackupButton.style.width = '100%';


                    createBackupButton.addEventListener('click', async () => {
                        const backupName = backupNameInput.getValue().trim();
                        if (!backupName) {
                            new Notice("Please enter a name for the backup.", 3000);
                            return;
                        }
                        
                        try {
                            await this.saveManualBackup(backupName);
                            new Notice("Manual backup created successfully.", 3000);
                            // Refresh the list after creating a backup
                            modal.close();
                            this.open(); 
                        } catch (error) {
                            // saveManualBackup handles its own errors and notices
                        }
                    });

                    // Add it before the list
                    if (containerEl.firstChild) {
                        containerEl.insertBefore(manualBackupContainer, containerEl.firstChild);
                    } else {
                        containerEl.appendChild(manualBackupContainer);
                    }

                    
                    // Override the createListItem method to add our custom details display
                    const originalCreateListItem = modal.createListItem.bind(modal);
                    // @ts-ignore - Temporarily override the method
                    modal.createListItem = (itemData: ListItem & { _backupDetails?: string }, index: number) => {
                        const itemEl = originalCreateListItem(itemData, index);
                        
                        // Replace the standard description with our custom formatted one
                        if (itemData._backupDetails) {
                            // Remove the default description element
                            const defaultDesc = itemEl.querySelector('.ss-modal__item-description');
                            if (defaultDesc) {
                                defaultDesc.remove();
                            }
                            
                            // Add our custom details element
                            const content = itemEl.querySelector('.ss-modal__item-content');
                            if (content) {
                                const detailsEl = content.createDiv({ cls: 'backup-details' });
                                
                                // Format details as nice badges
                                const details = itemData._backupDetails;
                                if (details.includes('\n')) {
                                    const detailItems = details.split('\n');
                                    detailItems.forEach(item => {
                                        detailsEl.createSpan({
                                            text: item,
                                            cls: 'backup-detail-item'
                                        });
                                    });
                                } else {
                                    detailsEl.setText(details);
                                }
                            }
                        }
                        
                        return itemEl;
                    };
                }
            });

            const selectedItems = await modal.openAndGetSelection();
            
            if (selectedItems.length === 0) {
                return null;
            }

            return selectedItems[0].id;
        } catch (error) {
            new Notice("Error loading backups: " + error, 3000);
            return null;
        }
    }

    /**
     * Save a manual backup with the given name
     */
    private async saveManualBackup(backupName: string): Promise<void> {
        try {
            // Normalize the name for file safety
            const safeNamePart = backupName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
            const timestamp = Date.now();
            const fileName = `settings-manual-${safeNamePart}-${timestamp}.json`;
            
            // Get vault root directory
            const backupDir = ".systemsculpt/settings-backups";
            
            // Ensure backup directory exists
            try {
                await this.plugin.app.vault.createFolder(backupDir);
            } catch (e) {
                // Directory might already exist, which is fine
                // @ts-ignore - Check error message if available
                if (!e.message || !e.message.includes("already exists")) {
                    throw e;
                }
            }
            
            // Get current settings
            const currentSettings = this.plugin.getSettingsManager().getSettings();
            
            // Add metadata to identify this as a manual backup
            const backupData = {
                ...currentSettings,
                _backupMeta: {
                    type: 'manual',
                    name: backupName,
                    timestamp: timestamp,
                    createdAt: new Date().toISOString()
                }
            };
            
            // Save to file
            const backupPath = `.systemsculpt/settings-backups/${fileName}`;
            await this.plugin.app.vault.adapter.write(
                backupPath,
                JSON.stringify(backupData, null, 2)
            );
            
            new Notice(`Manual backup "${backupName}" created successfully`, 3000);
        } catch (error) {
            new Notice("Error saving backup: " + error, 3000);
            throw error;
        }
    }

    /**
     * Get all available backup files
     */
    private async getAvailableBackups(): Promise<{ path: string; name: string; date: string; details?: string }[]> {
        try {
            // Get vault root directory
            const backupDir = ".systemsculpt/settings-backups";
            
            // Check if backup directory exists
            const exists = await this.plugin.app.vault.adapter.exists(backupDir);
            if (!exists) {
                return [];
            }

            // List all files in backup directory
            const files = await this.plugin.app.vault.adapter.list(backupDir);
            
            // Filter and sort backup files (latest first)
            const backupFiles = files.files
                .filter(f => f.includes('settings-') && f.endsWith('.json'))
                .sort((a, b) => {
                    // Extract timestamps/dates for proper sorting
                    const aMatch = a.match(/(\d{4}-\d{2}-\d{2})|(\d+)/);
                    const bMatch = b.match(/(\d{4}-\d{2}-\d{2})|(\d+)/);
                    
                    if (aMatch && bMatch) {
                        // If both have timestamps, sort by them
                        if (aMatch[2] && bMatch[2]) {
                            return parseInt(bMatch[2]) - parseInt(aMatch[2]); // Newest first
                        }
                        // If both have dates, sort by them
                        if (aMatch[1] && bMatch[1]) {
                            return bMatch[1].localeCompare(aMatch[1]); // Newest first
                        }
                    }
                    
                    // Fallback to filename sort (newest first)
                    return b.localeCompare(a);
                });

            // Process each backup file
            const backupsPromises = backupFiles.map(async filePath => {
                let name = filePath.split('/').pop() || '';
                let date = 'Unknown date';
                let details = '';
                let backupSettings: any = null;

                try {
                    // Read the backup file to extract key information
                    const backupData = await this.plugin.app.vault.adapter.read(filePath);
                    backupSettings = JSON.parse(backupData);
                    
                    // Extract key information
                    if (backupSettings) {
                        const customProviders = Array.isArray(backupSettings.customProviders) ? backupSettings.customProviders.length : 0;
                        const favoriteModels = Array.isArray(backupSettings.favoriteModels) ? backupSettings.favoriteModels.length : 0;
                        const selectedModel = backupSettings.selectedModelId || 'None';
                        const hasLicense = backupSettings.licenseValid === true ? 'Yes' : 'No';
                        
                        details = `👤 ${customProviders} provider${customProviders !== 1 ? 's' : ''}\n` +
                                  `⭐ ${favoriteModels} favorite${favoriteModels !== 1 ? 's' : ''}\n` +
                                  `🤖 ${selectedModel.split(':').pop()}\n` +
                                  `🔑 License: ${hasLicense}`;
            
                        // Removed development mode badge details
                        // if (backupSettings.developmentMode) {
                        //     details += `\n🛠️ Dev Mode`;
                        // }
                    }
                } catch (error) {
                    details = 'Could not read backup contents';
                }

                // Check for manual backups first (they have special metadata)
                if (backupSettings && backupSettings._backupMeta && backupSettings._backupMeta.type === 'manual') {
                    const meta = backupSettings._backupMeta;
                    const backupDate = new Date(meta.timestamp);
                    
                    return {
                        path: filePath,
                        name: `📝 ${meta.name}`,
                        date: backupDate.toLocaleString(),
                        details
                    };
                }

                // Handle "latest" backup
                if (name === 'settings-backup-latest.json') {
                    return {
                        path: filePath,
                        name: 'Latest Automatic Backup',
                        date: 'Most recent save',
                        details
                    };
                }

                // Handle daily backups
                const dateMatch = name.match(/settings-backup-(\d{4}-\d{2}-\d{2})\.json/);
                if (dateMatch) {
                    const [, dateStr] = dateMatch;
                    // Format as readable date
                    const dateObj = new Date(dateStr);
                    date = dateObj.toLocaleDateString(undefined, { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric' 
                    });
                    
                    return {
                        path: filePath,
                        name: `Backup from ${date}`,
                        date: dateStr,
                        details
                    };
                }

                // Handle emergency backups
                const emergencyMatch = name.match(/settings-emergency-(\d+)\.json/);
                if (emergencyMatch) {
                    const [, timestamp] = emergencyMatch;
                    const dateObj = new Date(parseInt(timestamp));
                    date = dateObj.toLocaleString();
                    
                    return {
                        path: filePath,
                        name: `Emergency Backup`,
                        date: date,
                        details
                    };
                }

                // Manual backups (old format without metadata)
                const manualMatch = name.match(/settings-manual-(.*)-(\d+)\.json/);
                if (manualMatch) {
                    const [, safeName, timestamp] = manualMatch;
                    const dateObj = new Date(parseInt(timestamp));
                    const readableName = safeName.replace(/-/g, ' ');
                    
                    return {
                        path: filePath,
                        name: `📝 ${readableName}`,
                        date: dateObj.toLocaleString(),
                        details
                    };
                }

                // Other backup formats
                return {
                    path: filePath,
                    name,
                    date,
                    details
                };
            });

            // Wait for all backups to be processed and sort by creation time (newest first)
            const processedBackups = await Promise.all(backupsPromises);
            
            // Sort the final results by actual creation time (newest first)
            return processedBackups.sort((a, b) => {
                // Handle special cases - put "latest" first
                if (a.name.includes('Latest')) return -1;
                if (b.name.includes('Latest')) return 1;
                
                // Extract actual creation dates from different backup types
                let dateA: number = 0;
                let dateB: number = 0;
                
                // For manual backups, extract timestamp from filename
                const aManualMatch = a.path.match(/settings-manual-.*-(\d+)\.json/);
                if (aManualMatch) {
                    dateA = parseInt(aManualMatch[1]); // Timestamp in milliseconds
                }
                
                const bManualMatch = b.path.match(/settings-manual-.*-(\d+)\.json/);
                if (bManualMatch) {
                    dateB = parseInt(bManualMatch[1]); // Timestamp in milliseconds
                }
                
                // For automatic backups, extract date and convert to timestamp
                const aAutoMatch = a.path.match(/settings-backup-(\d{4}-\d{2}-\d{2})\.json/);
                if (aAutoMatch && !aManualMatch) {
                    dateA = new Date(aAutoMatch[1]).getTime(); // Convert date to timestamp
                }
                
                const bAutoMatch = b.path.match(/settings-backup-(\d{4}-\d{2}-\d{2})\.json/);
                if (bAutoMatch && !bManualMatch) {
                    dateB = new Date(bAutoMatch[1]).getTime(); // Convert date to timestamp
                }
                
                // Compare actual creation times (newer first)
                if (dateA && dateB) {
                    return dateB - dateA; // Newest first
                }
                
                // If one has a date and other doesn't, prioritize the one with a date
                if (dateA && !dateB) return -1;
                if (!dateA && dateB) return 1;
                
                // Fallback to path comparison (newest first)
                return b.path.localeCompare(a.path);
            });
        } catch (error) {
            return [];
        }
    }

    /**
     * Restore settings from the selected backup
     * @param backupPath The path to the backup file
     */
    async restoreFromBackup(backupPath: string): Promise<boolean> {
        try {
            // Check if file exists
            const exists = await this.plugin.app.vault.adapter.exists(backupPath);
            if (!exists) {
                new Notice("Backup file not found", 3000);
                return false;
            }

            // Read backup file
            const backupData = await this.plugin.app.vault.adapter.read(backupPath);
            const backupSettings = JSON.parse(backupData);

            // Validate backup data
            if (!backupSettings || typeof backupSettings !== 'object') {
                new Notice("Invalid backup file format", 3000);
                return false;
            }

            // Apply settings
            await this.plugin.getSettingsManager().updateSettings(backupSettings);
            new Notice("Settings restored successfully", 3000);
            
            return true;
        } catch (error) {
            new Notice("Error restoring settings: " + error, 3000);
            return false;
        }
    }
} 