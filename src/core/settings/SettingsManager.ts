import { normalizePath } from "obsidian";
import { SystemSculptSettings, DEFAULT_SETTINGS, LogLevel, createDefaultWorkflowEngineSettings } from "../../types";
import SystemSculptPlugin from "../../main";
import { AutomaticBackupService } from "./AutomaticBackupService";
import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "./backupSanitizer";
import { canonicalizeSystemSculptServerUrlSetting } from "../../utils/urlHelpers";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import {
  CURRENT_SCHEMA_VERSION,
  migrateSettingsToCurrentSchema,
  readSchemaVersion,
} from "./migrations/SettingsMigrator";

type NodeFsModule = typeof import("node:fs");
type NodePathModule = typeof import("node:path");
type NodeFsWatcher = import("node:fs").FSWatcher;
type NodeFsStats = import("node:fs").Stats;

function loadNodeFs(): NodeFsModule {
  return require("node:fs") as NodeFsModule;
}

function loadNodePath(): NodePathModule {
  return require("node:path") as NodePathModule;
}

const PLUGIN_DATA_POLL_INTERVAL_MS = 1000;

/**
 * SettingsManager handles loading, saving, and updating plugin settings
 * using Obsidian's native data API exclusively.
 */
export class SettingsManager {
  private plugin: SystemSculptPlugin;
  settings: SystemSculptSettings;
  private isInitialized: boolean = false;
  private ongoingBackup: Promise<void> | null = null;
  private backupQueue: (() => Promise<void>)[] = [];
  private isProcessingBackupQueue: boolean = false;
  private automaticBackupService: AutomaticBackupService;
  private pluginDataWatcher: NodeFsWatcher | null = null;
  private pluginDataWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private pluginDataPollInterval: ReturnType<typeof setInterval> | null = null;
  private pluginDataWatcherCleanupRegistered = false;
  private pluginDataWatcherFilePath: string | null = null;
  private pluginDataLastObservedMtimeMs: number | null = null;
  private pluginDataPollInFlight = false;
  private recentInternalPluginDataWrites: Array<{
    snapshot: string;
    ignoreUntil: number;
    remainingBudget: number;
  }> = [];


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
    // Ensure settings mode exists; default to standard for a simpler UX
    if (!migratedSettings.settingsMode || (migratedSettings.settingsMode !== 'standard' && migratedSettings.settingsMode !== 'advanced')) {
      migratedSettings.settingsMode = DEFAULT_SETTINGS.settingsMode;
    }

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

    if (typeof migratedSettings.desktopAutomationBridgeEnabled !== "boolean") {
      migratedSettings.desktopAutomationBridgeEnabled = DEFAULT_SETTINGS.desktopAutomationBridgeEnabled;
    }

    if (typeof migratedSettings.embeddingsVectorFormatVersion !== "number" || !Number.isFinite(migratedSettings.embeddingsVectorFormatVersion)) {
      migratedSettings.embeddingsVectorFormatVersion = DEFAULT_SETTINGS.embeddingsVectorFormatVersion;
    }
    
    // Legacy/dead keys are pruned by the versioned migrator's v0→v1 step
    // (SettingsMigrator.LEGACY_KEYS_REMOVED_IN_V1) — no ad-hoc deletes here.

    // Ensure other nested objects are properly initialized
    if (!migratedSettings.favoritesFilterSettings) {
      migratedSettings.favoritesFilterSettings = DEFAULT_SETTINGS.favoritesFilterSettings;
    }
    
    if (!migratedSettings.modelFilterSettings) {
      migratedSettings.modelFilterSettings = DEFAULT_SETTINGS.modelFilterSettings;
    }
    
    if (!migratedSettings.activeProvider) {
      migratedSettings.activeProvider = DEFAULT_SETTINGS.activeProvider;
    }
    
    // Ensure arrays are initialized
    if (!Array.isArray(migratedSettings.customProviders)) {
      migratedSettings.customProviders = DEFAULT_SETTINGS.customProviders;
    }

    if (
      typeof migratedSettings.studioPiAuthMigrationVersion !== "number" ||
      !Number.isFinite(migratedSettings.studioPiAuthMigrationVersion) ||
      migratedSettings.studioPiAuthMigrationVersion < 0
    ) {
      migratedSettings.studioPiAuthMigrationVersion = DEFAULT_SETTINGS.studioPiAuthMigrationVersion;
    }
    
    if (!Array.isArray(migratedSettings.favoriteModels)) {
      migratedSettings.favoriteModels = DEFAULT_SETTINGS.favoriteModels;
    }

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
    
    if (!Array.isArray(migratedSettings.mcpServers)) {
      migratedSettings.mcpServers = DEFAULT_SETTINGS.mcpServers;
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
    // Validate settings mode
    if (validatedSettings.settingsMode !== 'standard' && validatedSettings.settingsMode !== 'advanced') {
      validatedSettings.settingsMode = DEFAULT_SETTINGS.settingsMode;
    }
    const defaultSettings = DEFAULT_SETTINGS;

    // Ensure critical arrays exist
    if (!Array.isArray(validatedSettings.customProviders)) {
      validatedSettings.customProviders = [];
    }

    if (
      typeof validatedSettings.studioPiAuthMigrationVersion !== "number" ||
      !Number.isFinite(validatedSettings.studioPiAuthMigrationVersion) ||
      validatedSettings.studioPiAuthMigrationVersion < 0
    ) {
      validatedSettings.studioPiAuthMigrationVersion = defaultSettings.studioPiAuthMigrationVersion;
    } else {
      validatedSettings.studioPiAuthMigrationVersion = Math.floor(validatedSettings.studioPiAuthMigrationVersion);
    }

    if (!Array.isArray(validatedSettings.favoriteModels)) {
      validatedSettings.favoriteModels = [];
    }

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

    const hasActiveLicense = !!validatedSettings.licenseKey?.trim() && validatedSettings.licenseValid === true;
    validatedSettings.enableSystemSculptProvider = hasActiveLicense;
    validatedSettings.useSystemSculptAsFallback = hasActiveLicense;

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

    // Validate embeddings provider selection (protect against manual edits / stale configs)
    const rawEmbeddingsProvider = (validatedSettings as any).embeddingsProvider;
    if (rawEmbeddingsProvider !== "systemsculpt" && rawEmbeddingsProvider !== "custom") {
      const hasCustomEndpoint =
        typeof validatedSettings.embeddingsCustomEndpoint === "string" &&
        validatedSettings.embeddingsCustomEndpoint.trim().length > 0;
      validatedSettings.embeddingsProvider = hasCustomEndpoint ? "custom" : defaultSettings.embeddingsProvider;
    }

    if (typeof validatedSettings.embeddingsCustomEndpoint !== "string") {
      validatedSettings.embeddingsCustomEndpoint = defaultSettings.embeddingsCustomEndpoint;
    }

    if (typeof validatedSettings.embeddingsCustomApiKey !== "string") {
      validatedSettings.embeddingsCustomApiKey = defaultSettings.embeddingsCustomApiKey;
    }

    if (typeof validatedSettings.embeddingsCustomModel !== "string") {
      validatedSettings.embeddingsCustomModel = defaultSettings.embeddingsCustomModel;
    }

    // Validate string settings that should never be null - using a simpler approach
    if (typeof validatedSettings.selectedModelId !== 'string') {
      validatedSettings.selectedModelId =
        typeof defaultSettings.selectedModelId === "string" ? defaultSettings.selectedModelId : "";
    }
    validatedSettings.selectedModelId = validatedSettings.selectedModelId.trim().length > 0
      ? validatedSettings.selectedModelId
      : "";

    if (typeof validatedSettings.titleGenerationModelId !== 'string') {
      validatedSettings.titleGenerationModelId = defaultSettings.titleGenerationModelId;
    }

    if (typeof validatedSettings.licenseKey !== 'string') {
      validatedSettings.licenseKey = defaultSettings.licenseKey;
    }

    // Keep openAiApiKey validation for backward compatibility
    // Users can still use OpenAI through custom providers
    if (!validatedSettings.openAiApiKey) {
      validatedSettings.openAiApiKey = '';
    }

    if (typeof validatedSettings.imageGenerationDefaultModelId !== "string") {
      validatedSettings.imageGenerationDefaultModelId = defaultSettings.imageGenerationDefaultModelId;
    }

    if (typeof validatedSettings.imageGenerationLastUsedModelId !== "string") {
      validatedSettings.imageGenerationLastUsedModelId = defaultSettings.imageGenerationLastUsedModelId;
    }

    if (typeof validatedSettings.imageGenerationLastUsedAspectRatio !== "string") {
      validatedSettings.imageGenerationLastUsedAspectRatio = defaultSettings.imageGenerationLastUsedAspectRatio;
    }

    const lastUsedCount = Number(validatedSettings.imageGenerationLastUsedCount);
    if (!Number.isFinite(lastUsedCount)) {
      validatedSettings.imageGenerationLastUsedCount = defaultSettings.imageGenerationLastUsedCount;
    } else {
      validatedSettings.imageGenerationLastUsedCount = Math.max(1, Math.min(4, Math.floor(lastUsedCount)));
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

    // Validate activeProvider
    if (!validatedSettings.activeProvider ||
        typeof validatedSettings.activeProvider !== 'object' ||
        !validatedSettings.activeProvider.id ||
        !validatedSettings.activeProvider.name ||
        !validatedSettings.activeProvider.type) {
      validatedSettings.activeProvider = { ...defaultSettings.activeProvider };
    }

    // Validate favoritesFilterSettings
    if (!validatedSettings.favoritesFilterSettings ||
        typeof validatedSettings.favoritesFilterSettings !== 'object') {
      validatedSettings.favoritesFilterSettings = { ...defaultSettings.favoritesFilterSettings };
    } else {
      // Validate individual properties of favoritesFilterSettings
      if (typeof validatedSettings.favoritesFilterSettings.showFavoritesOnly !== 'boolean') {
        validatedSettings.favoritesFilterSettings.showFavoritesOnly = defaultSettings.favoritesFilterSettings.showFavoritesOnly;
      }

      if (typeof validatedSettings.favoritesFilterSettings.favoritesFirst !== 'boolean') {
        validatedSettings.favoritesFilterSettings.favoritesFirst = defaultSettings.favoritesFilterSettings.favoritesFirst;
      }

      if (typeof validatedSettings.favoritesFilterSettings.modelSortOrder !== 'string') {
        validatedSettings.favoritesFilterSettings.modelSortOrder = defaultSettings.favoritesFilterSettings.modelSortOrder;
      }
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

    // Persist the canonical hosted API origin. Production builds always pin this to the
    // real SystemSculpt API, while development builds still normalize local overrides.
    validatedSettings.serverUrl = canonicalizeSystemSculptServerUrlSetting(
      typeof validatedSettings.serverUrl === "string" ? validatedSettings.serverUrl : ""
    );

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
    }
  }

  private getPluginDataFilePath(): string | null {
    const pluginDataVaultPath = normalizePath(
      `${this.plugin.app.vault.configDir || ".obsidian"}/plugins/${this.plugin.manifest.id}/data.json`
    );
    const absolutePath = resolveAbsoluteVaultPath(this.plugin.app.vault.adapter, pluginDataVaultPath);
    if (typeof absolutePath === "string" && absolutePath.trim().length > 0) {
      return absolutePath;
    }

    const adapter = this.plugin.app.vault.adapter as {
      getBasePath?: () => string;
      basePath?: string;
    };
    const basePath =
      typeof adapter?.getBasePath === "function"
        ? adapter.getBasePath()
        : typeof adapter?.basePath === "string"
          ? adapter.basePath
          : "";
    if (!basePath || typeof basePath !== "string" || basePath.trim().length === 0) {
      return null;
    }

    try {
      const nodePath = loadNodePath();
      return nodePath.join(basePath, ".obsidian", "plugins", this.plugin.manifest.id, "data.json");
    } catch {
      return null;
    }
  }

  private async readPluginDataMtimeMs(pluginDataFilePath: string): Promise<number | null> {
    try {
      const stats = (await loadNodeFs().promises.stat(pluginDataFilePath)) as NodeFsStats;
      return Number.isFinite(stats.mtimeMs) ? Number(stats.mtimeMs) : null;
    } catch {
      return null;
    }
  }

  private async refreshPluginDataMtimeSnapshot(
    pluginDataFilePath: string | null = this.pluginDataWatcherFilePath,
  ): Promise<void> {
    if (!pluginDataFilePath) {
      return;
    }

    const nextMtimeMs = await this.readPluginDataMtimeMs(pluginDataFilePath);
    if (nextMtimeMs !== null) {
      this.pluginDataLastObservedMtimeMs = nextMtimeMs;
    }
  }

  private startPluginDataPolling(pluginDataFilePath: string): void {
    if (this.pluginDataPollInterval) {
      return;
    }

    void this.refreshPluginDataMtimeSnapshot(pluginDataFilePath);

    this.pluginDataPollInterval = setInterval(() => {
      void this.pollPluginDataFile(pluginDataFilePath);
    }, PLUGIN_DATA_POLL_INTERVAL_MS);

    const interval = this.pluginDataPollInterval as { unref?: () => void } | null;
    if (typeof interval?.unref === "function") {
      interval.unref();
    }
  }

  private async pollPluginDataFile(
    pluginDataFilePath: string | null = this.pluginDataWatcherFilePath,
  ): Promise<void> {
    if (!pluginDataFilePath || this.pluginDataPollInFlight) {
      return;
    }

    this.pluginDataPollInFlight = true;
    try {
      const nextMtimeMs = await this.readPluginDataMtimeMs(pluginDataFilePath);
      if (nextMtimeMs === null) {
        return;
      }

      const previousMtimeMs = this.pluginDataLastObservedMtimeMs;
      this.pluginDataLastObservedMtimeMs = nextMtimeMs;

      if (previousMtimeMs === null || nextMtimeMs <= previousMtimeMs) {
        return;
      }

      this.schedulePluginDataReload();
    } finally {
      this.pluginDataPollInFlight = false;
    }
  }

  private schedulePluginDataReload(): void {
    if (this.pluginDataWatcherTimer) {
      clearTimeout(this.pluginDataWatcherTimer);
    }

    void this.refreshPluginDataMtimeSnapshot();

    this.pluginDataWatcherTimer = setTimeout(() => {
      this.pluginDataWatcherTimer = null;
      void this.reloadSettingsFromDisk().catch(() => {});
    }, 150);
  }

  private serializeSettingsForWatcher(settings: SystemSculptSettings): string {
    try {
      return JSON.stringify(settings);
    } catch {
      return "";
    }
  }

  private pruneRecentInternalPluginDataWrites(): void {
    const now = Date.now();
    this.recentInternalPluginDataWrites = this.recentInternalPluginDataWrites.filter(
      (entry) => entry.remainingBudget > 0 && now <= entry.ignoreUntil && entry.snapshot.length > 0,
    );
  }

  private markInternalPluginDataWrite(settings: SystemSculptSettings): void {
    const snapshot = this.serializeSettingsForWatcher(settings);
    if (!snapshot) {
      return;
    }

    this.pruneRecentInternalPluginDataWrites();
    const existingEntry = this.recentInternalPluginDataWrites.find((entry) => entry.snapshot === snapshot);
    if (existingEntry) {
      existingEntry.ignoreUntil = Date.now() + 5000;
      // Native saveData writes can surface multiple fs.watch events on macOS.
      existingEntry.remainingBudget = Math.max(existingEntry.remainingBudget, 10);
      return;
    }

    this.recentInternalPluginDataWrites.push({
      snapshot,
      ignoreUntil: Date.now() + 5000,
      remainingBudget: 10,
    });

    if (this.recentInternalPluginDataWrites.length > 8) {
      this.recentInternalPluginDataWrites.splice(
        0,
        this.recentInternalPluginDataWrites.length - 8,
      );
    }
  }

  private shouldIgnoreInternalPluginDataEcho(nextSettings: SystemSculptSettings): boolean {
    this.pruneRecentInternalPluginDataWrites();
    if (this.recentInternalPluginDataWrites.length === 0) {
      return false;
    }

    const snapshot = this.serializeSettingsForWatcher(nextSettings);
    if (!snapshot) {
      return false;
    }

    const matchingEntry = this.recentInternalPluginDataWrites.find((entry) => entry.snapshot === snapshot);
    if (!matchingEntry) {
      return false;
    }

    matchingEntry.remainingBudget -= 1;
    this.pruneRecentInternalPluginDataWrites();
    return true;
  }

  private ensurePluginDataWatcherCleanupRegistered(): void {
    if (this.pluginDataWatcherCleanupRegistered) {
      return;
    }

    this.plugin.register(() => {
      this.stopWatchingPluginDataFile();
    });
    this.pluginDataWatcherCleanupRegistered = true;
  }

  public startWatchingPluginDataFile(): void {
    const pluginDataFilePath = this.getPluginDataFilePath();
    if (!pluginDataFilePath) {
      return;
    }

    this.ensurePluginDataWatcherCleanupRegistered();

    if (this.pluginDataWatcher || this.pluginDataPollInterval) {
      return;
    }

    this.pluginDataWatcherFilePath = pluginDataFilePath;
    this.startPluginDataPolling(pluginDataFilePath);

    try {
      const nodeFs = loadNodeFs();
      const nodePath = loadNodePath();
      const pluginDir = nodePath.dirname(pluginDataFilePath);

      this.pluginDataWatcher = nodeFs.watch(pluginDir, { persistent: false }, (_eventType, filename) => {
        const changedFileName =
          typeof filename === "string"
            ? filename
            : filename && typeof (filename as any).toString === "function"
              ? (filename as any).toString("utf8")
              : "";
        if (changedFileName && changedFileName !== "data.json") {
          return;
        }
        this.schedulePluginDataReload();
      });

      this.pluginDataWatcher.on("error", () => {
        if (this.pluginDataWatcher) {
          this.pluginDataWatcher.close();
          this.pluginDataWatcher = null;
        }
      });
    } catch {
      if (this.pluginDataWatcher) {
        this.pluginDataWatcher.close();
        this.pluginDataWatcher = null;
      }
    }
  }

  public stopWatchingPluginDataFile(): void {
    if (this.pluginDataWatcherTimer) {
      clearTimeout(this.pluginDataWatcherTimer);
      this.pluginDataWatcherTimer = null;
    }

    if (this.pluginDataWatcher) {
      this.pluginDataWatcher.close();
      this.pluginDataWatcher = null;
    }

    if (this.pluginDataPollInterval) {
      clearInterval(this.pluginDataPollInterval);
      this.pluginDataPollInterval = null;
    }

    this.pluginDataWatcherFilePath = null;
    this.pluginDataLastObservedMtimeMs = null;
    this.pluginDataPollInFlight = false;
  }

  public async reloadSettingsFromDisk(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }

    const loadedData = await this.plugin.loadData();
    const raw =
      loadedData && typeof loadedData === "object" && !Array.isArray(loadedData)
        ? (loadedData as Record<string, unknown>)
        : {};
    // Route disk reloads through the SAME versioned migrate+validate+rollback
    // path as load/restore, so an externally-edited or synced OLD file is
    // migrated (deep-merge + legacy prune + schema stamp), not applied stale (#212).
    const nextSettings = await this.migrateValidateWithRollback(raw);

    if (JSON.stringify(this.settings) === JSON.stringify(nextSettings)) {
      if (this.shouldIgnoreInternalPluginDataEcho(nextSettings)) {
        return false;
      }

      this.plugin.app.workspace.trigger(
        "systemsculpt:settings-file-touched",
        this.plugin._internal_settings_systemsculpt_plugin
      );
      return false;
    }

    const oldSettings = { ...this.settings };
    this.settings = nextSettings;
    this.plugin._internal_settings_systemsculpt_plugin = { ...nextSettings };
    this.plugin.app.workspace.trigger(
      "systemsculpt:settings-updated",
      oldSettings,
      this.plugin._internal_settings_systemsculpt_plugin
    );
    await this.backupSettings();
    return true;
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
      this.markInternalPluginDataWrite(persistedSettings);
      await this.plugin.saveData(this.plugin._internal_settings_systemsculpt_plugin);
      this.plugin.app.workspace.trigger("systemsculpt:settings-updated", oldSettings, this.plugin._internal_settings_systemsculpt_plugin);
      await this.backupSettings();
    } catch (error) {
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
    const oldSettingsState = { ...this.settings }; 

    // Merge new settings into the manager's internal copy
    let updatedSettings = { ...this.settings, ...newSettings };
    
    // Validate the merged settings including phantom tool cleanup
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

  // ... other methods like getLicenseKey, setLicenseKey, validateLicenseKey, etc.
  // These should use this.updateSettings if they modify settings.

  public async validateLicenseKey(key: string): Promise<boolean> {
    const currentSettings = this.getSettings();
    // Simplified license validation logic for example
    const isValid = key === "valid-license"; // Replace with actual validation

    if (currentSettings.licenseKey !== key || currentSettings.licenseValid !== isValid) {
      await this.updateSettings({ licenseKey: key, licenseValid: isValid });
    }
    return isValid;
  }

  public getLicenseKey(): string {
    return this.getSettings().licenseKey;
  }

  public isLicenseValid(): boolean {
    return this.getSettings().licenseValid;
  }

  public async setLicenseKey(key: string): Promise<void> {
    await this.updateSettings({ licenseKey: key });
  }

  public getServerUrl(): string {
    return this.getSettings().serverUrl;
  }
  
  public async setServerUrl(url: string): Promise<void> {
    await this.updateSettings({ serverUrl: canonicalizeSystemSculptServerUrlSetting(url) });
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
    this.stopWatchingPluginDataFile();
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
