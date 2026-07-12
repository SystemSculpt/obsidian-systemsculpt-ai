import { Notice } from "obsidian";
import { SystemSculptSettings, DEFAULT_SETTINGS, LogLevel, createDefaultWorkflowEngineSettings } from "../../types";
import SystemSculptPlugin from "../../main";
import { AutomaticBackupService } from "./AutomaticBackupService";
import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "./backupSanitizer";
import {
  CURRENT_SCHEMA_VERSION,
  migrateSettingsToCurrentSchema,
  readSchemaVersion,
} from "./migrations/SettingsMigrator";

/**
 * SettingsManager handles loading, saving, and updating plugin settings
 * using Obsidian's native data API exclusively.
 */
export class SettingsManager {
  private plugin: SystemSculptPlugin;
  settings: SystemSculptSettings;
  private isInitialized: boolean = false;
  private automaticBackupService: AutomaticBackupService;
  // De-duplicate the user-facing save-failure Notice so a sync-lock storm (many
  // failing saves in quick succession) shows one Notice, not one per keystroke.
  private lastSaveFailureNoticeAt = 0;
  private static readonly SAVE_FAILURE_NOTICE_DEDUPE_MS = 5000;


  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_SETTINGS;
    this.automaticBackupService = new AutomaticBackupService(plugin);
  }

  // Migrate settings to ensure all fields are properly initialized
  private migrateSettings(settingsToMigrate: any): SystemSculptSettings {
    // Settings migration - silent process
    // Deep merge with defaults to ensure nested objects are properly initialized
    const migratedSettings = { ...settingsToMigrate };
    const generateVaultInstanceId = (): string => {
      try {
        const globalCrypto: any = (globalThis as any).crypto;
        if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
      } catch {}
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };

    if (typeof migratedSettings.vaultInstanceId !== "string" || migratedSettings.vaultInstanceId.trim().length === 0) {
      migratedSettings.vaultInstanceId = generateVaultInstanceId();
    }

    if (typeof migratedSettings.embeddingsVectorFormatVersion !== "number" || !Number.isFinite(migratedSettings.embeddingsVectorFormatVersion)) {
      migratedSettings.embeddingsVectorFormatVersion = DEFAULT_SETTINGS.embeddingsVectorFormatVersion;
    }

    // Legacy/dead keys are pruned by the versioned migrator's v0→v1 step
    // (SettingsMigrator.LEGACY_KEYS_REMOVED_IN_V1) — no ad-hoc deletes here.

    const defaultWorkflowEngine = createDefaultWorkflowEngineSettings();
    if (!migratedSettings.workflowEngine) {
      migratedSettings.workflowEngine = defaultWorkflowEngine;
    } else {
      const providedEngine = migratedSettings.workflowEngine;
      const providedAutomations =
        (providedEngine.automations && typeof providedEngine.automations === "object" && !Array.isArray(providedEngine.automations)
          ? providedEngine.automations
          : null) ||
        (providedEngine.templates && typeof providedEngine.templates === "object" && !Array.isArray(providedEngine.templates)
          ? providedEngine.templates
          : {}) ||
        {};
      const mergedAutomations: Record<string, any> = {};
      const automationKeys = new Set([
        ...Object.keys(defaultWorkflowEngine.automations || {}),
        ...Object.keys(providedAutomations),
      ]);

      automationKeys.forEach((automationId) => {
        const baseAutomation = defaultWorkflowEngine.automations?.[automationId] || {
          id: automationId,
          enabled: false,
        };
        const overrideAutomation = providedAutomations[automationId] || {};
        mergedAutomations[automationId] = {
          ...baseAutomation,
          ...overrideAutomation,
          id: automationId,
          enabled: !!overrideAutomation.enabled,
        };
      });

      migratedSettings.workflowEngine = {
        ...defaultWorkflowEngine,
        ...providedEngine,
        skippedFiles:
          providedEngine.skippedFiles &&
          typeof providedEngine.skippedFiles === "object" &&
          !Array.isArray(providedEngine.skippedFiles)
            ? providedEngine.skippedFiles
            : defaultWorkflowEngine.skippedFiles,
        automations: mergedAutomations,
      };
      delete (migratedSettings.workflowEngine as any).templates;
    }
    
    if (typeof migratedSettings.debugMode !== "boolean") {
      migratedSettings.debugMode = DEFAULT_SETTINGS.debugMode;
    }

    if (typeof migratedSettings.logLevel !== "number") {
      migratedSettings.logLevel = DEFAULT_SETTINGS.logLevel;
    } else if (!migratedSettings.debugMode && migratedSettings.logLevel > LogLevel.WARNING) {
      migratedSettings.logLevel = LogLevel.WARNING;
    }

    if (!Array.isArray(migratedSettings.favoriteChats)) {
      migratedSettings.favoriteChats = DEFAULT_SETTINGS.favoriteChats;
    }

    if (!Array.isArray(migratedSettings.favoriteStudioSessions)) {
      migratedSettings.favoriteStudioSessions = DEFAULT_SETTINGS.favoriteStudioSessions;
    }
    
    // Ensure automatic backup settings are properly initialized (migration for existing users)
    if (typeof migratedSettings.automaticBackupsEnabled !== 'boolean') {
      migratedSettings.automaticBackupsEnabled = DEFAULT_SETTINGS.automaticBackupsEnabled;
    }
    if (typeof migratedSettings.automaticBackupInterval !== 'number') {
      migratedSettings.automaticBackupInterval = DEFAULT_SETTINGS.automaticBackupInterval;
    }
    if (typeof migratedSettings.automaticBackupRetentionDays !== 'number') {
      migratedSettings.automaticBackupRetentionDays = DEFAULT_SETTINGS.automaticBackupRetentionDays;
    }
    if (typeof migratedSettings.lastAutomaticBackup !== 'number') {
      migratedSettings.lastAutomaticBackup = DEFAULT_SETTINGS.lastAutomaticBackup;
    }
    
    // Ensure preserveReasoningVerbatim is properly initialized (migration for existing users)
    if (typeof migratedSettings.preserveReasoningVerbatim !== 'boolean') {
      migratedSettings.preserveReasoningVerbatim = DEFAULT_SETTINGS.preserveReasoningVerbatim;
    }

    // Ensure respectReducedMotion is properly initialized (migration for existing users)
    if (typeof migratedSettings.respectReducedMotion !== "boolean") {
      migratedSettings.respectReducedMotion = DEFAULT_SETTINGS.respectReducedMotion;
    }

    if (typeof migratedSettings.defaultChatTag !== "string") {
      migratedSettings.defaultChatTag = DEFAULT_SETTINGS.defaultChatTag;
    }

    if (typeof migratedSettings.hideSystemMessagesInChat !== "boolean") {
      migratedSettings.hideSystemMessagesInChat = DEFAULT_SETTINGS.hideSystemMessagesInChat;
    }

    if (typeof migratedSettings.agentModeEnabled !== "boolean") {
      migratedSettings.agentModeEnabled = DEFAULT_SETTINGS.agentModeEnabled;
    }

    if (typeof migratedSettings.lastUsedPromptPath !== "string") {
      migratedSettings.lastUsedPromptPath = DEFAULT_SETTINGS.lastUsedPromptPath;
    }

    if (typeof migratedSettings.studioDefaultProjectsFolder !== "string" || !migratedSettings.studioDefaultProjectsFolder.trim()) {
      migratedSettings.studioDefaultProjectsFolder = DEFAULT_SETTINGS.studioDefaultProjectsFolder;
    }

    if (typeof migratedSettings.studioRunRetentionMaxRuns !== "number" || !Number.isFinite(migratedSettings.studioRunRetentionMaxRuns)) {
      migratedSettings.studioRunRetentionMaxRuns = DEFAULT_SETTINGS.studioRunRetentionMaxRuns;
    }

    if (typeof migratedSettings.studioRunRetentionMaxArtifactsMb !== "number" || !Number.isFinite(migratedSettings.studioRunRetentionMaxArtifactsMb)) {
      migratedSettings.studioRunRetentionMaxArtifactsMb = DEFAULT_SETTINGS.studioRunRetentionMaxArtifactsMb;
    }

    if (
      migratedSettings.studioJsonEditorDefaultMode !== "composer" &&
      migratedSettings.studioJsonEditorDefaultMode !== "raw"
    ) {
      migratedSettings.studioJsonEditorDefaultMode = DEFAULT_SETTINGS.studioJsonEditorDefaultMode;
    }
    
    return migratedSettings as SystemSculptSettings;
  }

  /**
   * Load settings from Obsidian's data storage
   * Implements robust error handling to prevent settings loss
   */

  /**
   * Attempt to restore settings from the latest backup
   * Checks both the new vault-based location and the old plugin directory location
   * @returns The restored settings or null if restoration failed
   */
  private async restoreFromBackup(): Promise<any | null> {
    try {
      const hydrateBackup = (candidate: unknown): Record<string, unknown> | null => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          return null;
        }
        return applyCurrentSecretsToBackup(
          candidate as Record<string, unknown>,
          this.settings as unknown as Record<string, unknown>,
        );
      };

      // First try to restore from the new vault-based location if storage manager is available
      if (this.plugin.storage) {
        try {
          // Try to get the latest backup from the vault storage
          const latestBackup = await this.plugin.storage.readFile('settings', 'backups/settings-backup-latest.json', true);
          const hydratedLatestBackup = hydrateBackup(latestBackup);
          if (hydratedLatestBackup) {
            return hydratedLatestBackup;
          }

          // If no latest backup, try to find the most recent daily backup
          const backupFiles = await this.plugin.storage.listFiles('settings', 'backups');
          const dailyBackups = backupFiles
            .filter(f => f.match(/settings-backup-\d{4}-\d{2}-\d{2}\.json$/))
            .sort()
            .reverse();

          if (dailyBackups.length > 0) {
            const newestBackup = await this.plugin.storage.readFile('settings', `backups/${dailyBackups[0]}`, true);
            const hydratedNewestBackup = hydrateBackup(newestBackup);
            if (hydratedNewestBackup) {
              return hydratedNewestBackup;
            }
          }
        } catch (e) {
        }
      }

      // If we get here, try the vault root location as fallback
      const backupDir = ".systemsculpt/settings-backups";
      const latestBackupPath = ".systemsculpt/settings-backups/settings-backup-latest.json";

      // Check if the latest backup exists
      const exists = await this.plugin.app.vault.adapter.exists(latestBackupPath);
      if (exists) {
        // Read the latest backup file
        const backupData = await this.plugin.app.vault.adapter.read(latestBackupPath);
        const backupSettings = JSON.parse(backupData);
        const hydratedBackup = hydrateBackup(backupSettings);
        if (hydratedBackup) {
          return hydratedBackup;
        }
      }

      // If no latest backup, try to find the most recent daily backup
      try {
        const files = await this.plugin.app.vault.adapter.list(backupDir);
        const backupFiles = files.files
          .filter(f => f.match(/settings-backup-\d{4}-\d{2}-\d{2}\.json$/))
          .sort()
          .reverse();

        if (backupFiles.length > 0) {
          const newestBackup = backupFiles[0];
          const backupData = await this.plugin.app.vault.adapter.read(newestBackup);
          const backupSettings = JSON.parse(backupData);
          const hydratedBackup = hydrateBackup(backupSettings);
          if (hydratedBackup) {
            return hydratedBackup;
          }
        }
      } catch (e) {
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  async loadSettings(): Promise<void> {
    let raw: Record<string, unknown> = {};
    try {
      const loadedData = await this.plugin.loadData();
      raw = this.asSettingsRecord(loadedData);
    } catch (loadError) {
      const backupSettings = await this.restoreFromBackup();
      raw = this.asSettingsRecord(backupSettings);
    }

    this.settings = await this.migrateValidateWithRollback(raw);
    this.plugin._internal_settings_systemsculpt_plugin = { ...this.settings };
    this.isInitialized = true;
    await this.saveSettings();

    this.plugin.app.workspace.trigger("systemsculpt:settings-loaded", this.settings);

    // Start automatic backup service after settings are loaded
    this.automaticBackupService.start();
  }

  private asSettingsRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /**
   * Run the versioned schema migration (back-fill defaults, prune legacy keys,
   * stamp the schema version) followed by normalization/validation. If any step
   * throws, ROLL BACK: snapshot the user's raw data to a pre-migration backup
   * and load the safest shape we can, so an update can never leave the plugin
   * dead or wipe settings (#212; #183/#112/#100).
   */
  private async migrateValidateWithRollback(
    raw: Record<string, unknown>,
  ): Promise<SystemSculptSettings> {
    const fromVersion = readSchemaVersion(raw);
    try {
      const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);
      // Back up BEFORE applying a real schema upgrade so a migration bug found
      // later is always recoverable from the pre-migration snapshot.
      if (!result.future && result.fromVersion < CURRENT_SCHEMA_VERSION && this.hasMeaningfulData(raw)) {
        await this.writePreMigrationBackup(raw, fromVersion);
      }
      return await this.validateSettingsAsync(this.migrateSettings(result.settings));
    } catch (migrationError) {
      await this.writePreMigrationBackup(raw, fromVersion).catch(() => {});
      try {
        // Safe fallback = pre-versioning behavior (defaults + raw, normalized).
        // The user's original data is preserved both here (raw wins) and in the
        // pre-migration backup written above.
        return await this.validateSettingsAsync(this.migrateSettings({ ...DEFAULT_SETTINGS, ...raw }));
      } catch (fallbackError) {
        // Last resort: pure defaults. Data is safe in the pre-migration backup.
        return { ...DEFAULT_SETTINGS };
      }
    }
  }

  private hasMeaningfulData(raw: Record<string, unknown>): boolean {
    return Object.keys(raw).length > 0;
  }

  /**
   * Best-effort snapshot of the raw persisted settings (secrets redacted) to a
   * dedicated pre-migration backup file, so a schema upgrade is always
   * reversible. Never throws — backup must not block plugin load.
   */
  private async writePreMigrationBackup(raw: Record<string, unknown>, fromVersion: number): Promise<void> {
    try {
      const redacted = redactSettingsForBackup(raw);
      const payload = {
        ...redacted,
        _backupMeta: {
          type: "pre-migration",
          fromSchemaVersion: fromVersion,
          toSchemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: new Date().toISOString(),
          version: "1.1",
          redactedSecrets: true,
        },
      };
      const fileName = `settings-backup-premigration-v${fromVersion}.json`;
      const dir = ".systemsculpt/settings-backups";
      try {
        await this.plugin.app.vault.createFolder(dir);
      } catch {
        // directory already exists
      }
      await this.plugin.app.vault.adapter.write(`${dir}/${fileName}`, JSON.stringify(payload, null, 2));
      if (this.plugin.storage) {
        try {
          await this.plugin.storage.writeFile("settings", `backups/${fileName}`, payload);
        } catch {
          // vault storage optional
        }
      }
    } catch {
      // best-effort only
    }
  }

  /**
   * Validate settings to ensure critical fields are present and properly formatted
   * @param settings The settings object to validate
   * @returns The validated settings object
   */
  private validateSettings(settings: SystemSculptSettings): SystemSculptSettings {
    // Create a copy to avoid modifying the original
    const validatedSettings = { ...settings };
    const defaultSettings = DEFAULT_SETTINGS;

    // Validate directories - these are critical for proper functioning
    // Using a simpler approach to avoid TypeScript errors
    if (typeof validatedSettings.chatsDirectory !== 'string') {
      validatedSettings.chatsDirectory = defaultSettings.chatsDirectory;
    }

    if (typeof validatedSettings.recordingsDirectory !== 'string') {
      validatedSettings.recordingsDirectory = defaultSettings.recordingsDirectory;
    }

    if (typeof validatedSettings.attachmentsDirectory !== 'string') {
      validatedSettings.attachmentsDirectory = defaultSettings.attachmentsDirectory;
    }

    if (typeof validatedSettings.extractionsDirectory !== 'string') {
      validatedSettings.extractionsDirectory = defaultSettings.extractionsDirectory;
    }

    if (typeof validatedSettings.systemPromptsDirectory !== 'string') {
      validatedSettings.systemPromptsDirectory = defaultSettings.systemPromptsDirectory;
    }


    // Validate saved chats directory
    if (typeof validatedSettings.savedChatsDirectory !== 'string') {
      validatedSettings.savedChatsDirectory = defaultSettings.savedChatsDirectory;
    }
    // Validate boolean settings - using a simpler approach to avoid TypeScript errors
    if (typeof validatedSettings.licenseValid !== 'boolean') {
      validatedSettings.licenseValid = defaultSettings.licenseValid;
    }

    if (typeof validatedSettings.autoTranscribeRecordings !== 'boolean') {
      validatedSettings.autoTranscribeRecordings = defaultSettings.autoTranscribeRecordings;
    }

    if (typeof validatedSettings.autoPasteTranscription !== 'boolean') {
      validatedSettings.autoPasteTranscription = defaultSettings.autoPasteTranscription;
    }

    if (typeof validatedSettings.keepRecordingsAfterTranscription !== 'boolean') {
      validatedSettings.keepRecordingsAfterTranscription = defaultSettings.keepRecordingsAfterTranscription;
    }

    if (typeof validatedSettings.postProcessingEnabled !== 'boolean') {
      validatedSettings.postProcessingEnabled = defaultSettings.postProcessingEnabled;
    }

    if (typeof validatedSettings.cleanTranscriptionOutput !== 'boolean') {
      validatedSettings.cleanTranscriptionOutput = defaultSettings.cleanTranscriptionOutput;
    }

    if (validatedSettings.transcriptionOutputFormat !== "markdown" && validatedSettings.transcriptionOutputFormat !== "srt") {
      validatedSettings.transcriptionOutputFormat = defaultSettings.transcriptionOutputFormat;
    }

    if (typeof validatedSettings.showTranscriptionFormatChooserInModal !== "boolean") {
      validatedSettings.showTranscriptionFormatChooserInModal = defaultSettings.showTranscriptionFormatChooserInModal;
    }

    if (typeof validatedSettings.skipEmptyNoteWarning !== 'boolean') {
      validatedSettings.skipEmptyNoteWarning = defaultSettings.skipEmptyNoteWarning;
    }


    // Legacy/dead keys are pruned by the versioned migrator (v0→v1) on load,
    // not re-deleted on every validate pass.

    if (typeof validatedSettings.embeddingsEnabled !== 'boolean') {
      validatedSettings.embeddingsEnabled = defaultSettings.embeddingsEnabled;
    }

    if (typeof validatedSettings.licenseKey !== 'string') {
      validatedSettings.licenseKey = defaultSettings.licenseKey;
    }

    if (typeof validatedSettings.defaultChatTag !== "string") {
      validatedSettings.defaultChatTag = defaultSettings.defaultChatTag;
    }

    if (typeof validatedSettings.hideSystemMessagesInChat !== "boolean") {
      validatedSettings.hideSystemMessagesInChat = defaultSettings.hideSystemMessagesInChat;
    }

    if (typeof validatedSettings.agentModeEnabled !== "boolean") {
      validatedSettings.agentModeEnabled = defaultSettings.agentModeEnabled;
    }

    if (typeof validatedSettings.lastUsedPromptPath !== "string") {
      validatedSettings.lastUsedPromptPath = defaultSettings.lastUsedPromptPath;
    }

    if (
      validatedSettings.studioJsonEditorDefaultMode !== "composer" &&
      validatedSettings.studioJsonEditorDefaultMode !== "raw"
    ) {
      validatedSettings.studioJsonEditorDefaultMode = defaultSettings.studioJsonEditorDefaultMode;
    }

    if (!Array.isArray(validatedSettings.favoriteChats)) {
      validatedSettings.favoriteChats = defaultSettings.favoriteChats;
    }

    if (!Array.isArray(validatedSettings.favoriteStudioSessions)) {
      validatedSettings.favoriteStudioSessions = defaultSettings.favoriteStudioSessions;
    }

    // Legacy/dead keys (cachedEmbeddingStats, selectedProvider, systemPrompt*, …)
    // are pruned once by the versioned migrator's v0→v1 step, not on every
    // validate pass. See SettingsMigrator.LEGACY_KEYS_REMOVED_IN_V1.

    const defaultWorkflowEngine = createDefaultWorkflowEngineSettings();
    const providedWorkflowEngine = validatedSettings.workflowEngine;
    if (!providedWorkflowEngine) {
      validatedSettings.workflowEngine = defaultWorkflowEngine;
    } else {
      const legacyWorkflowEngine = providedWorkflowEngine as typeof providedWorkflowEngine & {
        templates?: Record<string, unknown>;
      };
      const mergedAutomations: Record<string, any> = {};
      const providedAutomations: Record<string, any> =
        (providedWorkflowEngine.automations &&
          typeof providedWorkflowEngine.automations === "object" &&
          !Array.isArray(providedWorkflowEngine.automations)
          ? providedWorkflowEngine.automations
          : null) ||
        (legacyWorkflowEngine.templates &&
          typeof legacyWorkflowEngine.templates === "object" &&
          !Array.isArray(legacyWorkflowEngine.templates)
          ? legacyWorkflowEngine.templates
          : {}) ||
        {};
      const automationIds = new Set([
        ...Object.keys(defaultWorkflowEngine.automations || {}),
        ...Object.keys(providedAutomations),
      ]);

      automationIds.forEach((automationId) => {
        const baseAutomation = defaultWorkflowEngine.automations?.[automationId] || {
          id: automationId,
          enabled: false,
        };
        const overrideAutomation = providedAutomations[automationId] || {};
        mergedAutomations[automationId] = {
          ...baseAutomation,
          ...overrideAutomation,
          id: automationId,
          enabled: !!overrideAutomation.enabled,
        };
      });

      validatedSettings.workflowEngine = {
        ...defaultWorkflowEngine,
        ...providedWorkflowEngine,
        skippedFiles:
          providedWorkflowEngine.skippedFiles &&
          typeof providedWorkflowEngine.skippedFiles === "object" &&
          !Array.isArray(providedWorkflowEngine.skippedFiles)
            ? providedWorkflowEngine.skippedFiles
            : defaultWorkflowEngine.skippedFiles,
        inboxFolder:
          typeof providedWorkflowEngine.inboxFolder === "string" && providedWorkflowEngine.inboxFolder.trim()
            ? providedWorkflowEngine.inboxFolder
            : defaultWorkflowEngine.inboxFolder,
        processedNotesFolder:
          typeof providedWorkflowEngine.processedNotesFolder === "string"
            ? providedWorkflowEngine.processedNotesFolder
            : "",
        autoTranscribeInboxNotes:
          typeof providedWorkflowEngine.autoTranscribeInboxNotes === "boolean"
            ? providedWorkflowEngine.autoTranscribeInboxNotes
            : defaultWorkflowEngine.autoTranscribeInboxNotes,
        inboxRoutingEnabled:
          typeof providedWorkflowEngine.inboxRoutingEnabled === "boolean"
            ? providedWorkflowEngine.inboxRoutingEnabled
            : defaultWorkflowEngine.inboxRoutingEnabled,
        automations: mergedAutomations,
      };
      delete (validatedSettings.workflowEngine as any).templates;
    }

    return validatedSettings;
  }

  /**
   * Create a backup of the current settings
   * This provides a safety net in case the main settings file becomes corrupted
   * Uses the vault-based .systemsculpt directory for backups
   */
  private async backupSettings(): Promise<void> {
    if (!this.isInitialized || !this.settings) return;
    try {
      const redactedSettings = redactSettingsForBackup(this.settings as unknown as Record<string, unknown>);
      const backupData = JSON.stringify(redactedSettings, null, 2);
      
      // Use explicit relative paths to prevent path resolution issues
      const backupDir = ".systemsculpt/settings-backups";
      const backupPath = ".systemsculpt/settings-backups/settings-backup-latest.json";
      
      // Ensure the backup directory exists before writing
      const dirExists = await this.plugin.app.vault.adapter.exists(backupDir);
      if (!dirExists) {
        await this.plugin.app.vault.createFolder(backupDir);
      }
      
      await this.plugin.app.vault.adapter.write(backupPath, backupData);
    } catch (error) {
      // Backups are a best-effort safety net: log for diagnostics but do not
      // rethrow or block saveSettings — a failed backup must not look like a
      // failed save, and the primary saveData write has already succeeded.
      try {
        this.plugin.getLogger().error("Failed to write SystemSculpt settings backup", error, {
          source: "SettingsManager",
          method: "backupSettings",
        });
      } catch {
        // Logger must never mask the (already non-fatal) backup failure.
      }
    }
  }


  /**
   * Surface a settings-persistence failure instead of swallowing it. The failure
   * is always logged via the plugin logger (for diagnostics), and a single
   * de-duplicated Notice is shown so the user knows their last change may not have
   * persisted — without spamming one Notice per keystroke during a sync-lock
   * storm. We log + notify rather than rethrow: `saveSettings` is invoked from the
   * load path and from ~100 fire-and-forget `updateSettings(...)` callers, so
   * rethrowing would convert disk-full/permission errors into uncaught rejections
   * and could break plugin load. Observability is the fix here; serializing writes
   * is tracked separately (BUG-09).
   */
  private surfaceSaveFailure(error: unknown): void {
    try {
      this.plugin.getLogger().error("Failed to save SystemSculpt settings", error, {
        source: "SettingsManager",
        method: "saveSettings",
      });
    } catch {
      // Logger must never mask the original failure.
    }

    const now = Date.now();
    if (now - this.lastSaveFailureNoticeAt < SettingsManager.SAVE_FAILURE_NOTICE_DEDUPE_MS) {
      return;
    }
    this.lastSaveFailureNoticeAt = now;
    try {
      new Notice(
        "Failed to save SystemSculpt settings — your last change may not persist.",
        8000,
      );
    } catch {
      // Notice is best-effort UI; never let it throw out of the catch.
    }
  }

  /**
   * Save settings using Obsidian's native data API
   * This ensures settings are properly saved with fallback options
   */
  async saveSettings(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      const oldSettings = { ...(this.plugin._internal_settings_systemsculpt_plugin || DEFAULT_SETTINGS) }; 
      // Re-validate before persisting so stale legacy keys do not survive direct internal mutations.
      const persistedSettings = await this.validateSettingsAsync({
        ...this.plugin._internal_settings_systemsculpt_plugin,
      } as SystemSculptSettings);
      this.settings = persistedSettings;
      this.plugin._internal_settings_systemsculpt_plugin = { ...persistedSettings };
      await this.plugin.saveData(this.plugin._internal_settings_systemsculpt_plugin);
      this.plugin.app.workspace.trigger("systemsculpt:settings-updated", oldSettings, this.plugin._internal_settings_systemsculpt_plugin);
      await this.backupSettings();
    } catch (error) {
      // Persistence failed (disk full, permissions, sync lock, …). Do NOT
      // swallow it: log + show a de-duplicated Notice so the loss is visible.
      this.surfaceSaveFailure(error);
    }
  }

  /**
   * Get the current settings
   */
  getSettings(): SystemSculptSettings {
    if (!this.isInitialized) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...this.settings }; // Return a copy
  }

  /**
   * Update settings with partial changes
   */
  async updateSettings(newSettings: Partial<SystemSculptSettings>): Promise<void> {
    if (!this.isInitialized) {
      await this.loadSettings(); // Ensure settings are loaded before update
    }
    // Merge new settings into the manager's internal copy
    const updatedSettings = { ...this.settings, ...newSettings };
    
    // Validate the merged settings before persistence.
    this.settings = await this.validateSettingsAsync(updatedSettings);

    // Synchronize the plugin's internal settings representation BEFORE persisting.
    // This ensures that saveSettings() – which relies on `_internal_settings_systemsculpt_plugin`
    // – persists the latest in-memory changes rather than stale data.
    this.plugin._internal_settings_systemsculpt_plugin = { ...this.settings };

    // Call saveSettings to persist, update plugin._settings, and dispatch event
    await this.saveSettings();
    // Settings updated and saved - silent operation
  }

  /**
   * Apply externally-sourced settings (a restored backup or an import) by first
   * running them through the SAME versioned migrator the load path uses, then
   * persisting via updateSettings. Without this, restoring an OLD backup would
   * write a stale schema back to disk and could resurrect the lost-settings /
   * dead-plugin class this versioning exists to prevent (#212).
   */
  async restoreFromExternalSettings(raw: unknown): Promise<void> {
    const migrated = await this.migrateValidateWithRollback(this.asSettingsRecord(raw));
    await this.updateSettings(migrated);
  }

  /**
   * Perform async validation.
   */
  private async validateSettingsAsync(settings: SystemSculptSettings): Promise<SystemSculptSettings> {
    return this.validateSettings(settings);
  }

  /**
   * Clean up resources when the plugin is unloaded
   */
  public destroy(): void {
    if (this.automaticBackupService) {
      this.automaticBackupService.stop();
    }
  }

  /**
   * Get the automatic backup service instance for external access
   */
  public getAutomaticBackupService(): AutomaticBackupService {
    return this.automaticBackupService;
  }
}
