import { SystemSculptSettings, DEFAULT_SETTINGS, LogLevel, createDefaultWorkflowEngineSettings } from "../../types";
import SystemSculptPlugin from "../../main";
import { AutomaticBackupService } from "./AutomaticBackupService";
import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "./backupSanitizer";
import { canonicalizeSystemSculptServerUrlSetting } from "../../utils/urlHelpers";

// Current settings version - increment when making breaking changes to settings structure
const CURRENT_SETTINGS_VERSION = "1.0";

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

    if (typeof migratedSettings.embeddingsVectorFormatVersion !== "number" || !Number.isFinite(migratedSettings.embeddingsVectorFormatVersion)) {
      migratedSettings.embeddingsVectorFormatVersion = DEFAULT_SETTINGS.embeddingsVectorFormatVersion;
    }
    
    // Remove old embeddings stats if they exist (from old system)
    if ('cachedEmbeddingStats' in migratedSettings) {
      delete (migratedSettings as any).cachedEmbeddingStats;
    }

    delete (migratedSettings as any).defaultTemplateModelId;
    delete (migratedSettings as any).studioTelemetryOptIn;
    delete (migratedSettings as any).selectedProvider;
    delete (migratedSettings as any).selectedModelProviders;
    delete (migratedSettings as any).systemPrompt;
    delete (migratedSettings as any).systemPromptType;
    delete (migratedSettings as any).systemPromptPath;
    delete (migratedSettings as any).useLatestSystemPromptForNewChats;
    
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
    
    if ("toolingAutoApproveReadOnly" in migratedSettings) {
      delete (migratedSettings as any).toolingAutoApproveReadOnly;
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

    // Remove old embeddings exclusion properties if they exist
    if ('excludedFolders' in migratedSettings) {
      delete (migratedSettings as any).excludedFolders;
    }
    
    if ('excludedFiles' in migratedSettings) {
      delete (migratedSettings as any).excludedFiles;
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
    try {
      const loadedData = await this.plugin.loadData();
      const raw =
        loadedData && typeof loadedData === "object" && !Array.isArray(loadedData)
          ? (loadedData as Record<string, unknown>)
          : {};

      const mergedSettings = this.migrateSettings({ ...DEFAULT_SETTINGS, ...raw });
      this.settings = await this.validateSettingsAsync(mergedSettings);
      this.plugin._internal_settings_systemsculpt_plugin = { ...this.settings };
      this.isInitialized = true;
      await this.saveSettings();
    } catch (loadError) {
      const backupSettings = await this.restoreFromBackup();
      const raw =
        backupSettings && typeof backupSettings === "object" && !Array.isArray(backupSettings)
          ? (backupSettings as Record<string, unknown>)
          : {};

      const restored = this.migrateSettings({ ...DEFAULT_SETTINGS, ...raw });
      this.settings = await this.validateSettingsAsync(restored);
      this.plugin._internal_settings_systemsculpt_plugin = { ...this.settings };
      this.isInitialized = true;
      await this.saveSettings();
    }
    this.plugin.app.workspace.trigger("systemsculpt:settings-loaded", this.settings);
    
    // Start automatic backup service after settings are loaded
    this.automaticBackupService.start();
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


    // Remove old embeddings properties if they exist
    if ('autoUpdateSimilarNotes' in validatedSettings) {
      delete (validatedSettings as any).autoUpdateSimilarNotes;
    }

    if ('hideSimilarNotesAlreadyInContext' in validatedSettings) {
      delete (validatedSettings as any).hideSimilarNotesAlreadyInContext;
    }

    if ('backgroundEmbeddingUpdates' in validatedSettings) {
      delete (validatedSettings as any).backgroundEmbeddingUpdates;
    }

    delete (validatedSettings as any).recordSystemAudio;
    delete (validatedSettings as any).defaultTemplateModelId;
    delete (validatedSettings as any).templateHotkey;
    delete (validatedSettings as any).enableTemplateHotkey;
    delete (validatedSettings as any).videoRecordingsDirectory;
    delete (validatedSettings as any).videoCaptureSystemAudio;
    delete (validatedSettings as any).videoCaptureMicrophoneAudio;
    delete (validatedSettings as any).showVideoRecordButtonInChat;
    delete (validatedSettings as any).showVideoRecordingPermissionPopup;
    delete (validatedSettings as any).studioTelemetryOptIn;

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

    // Remove cachedEmbeddingStats if it exists (from old embeddings system)
    if ('cachedEmbeddingStats' in validatedSettings) {
      delete (validatedSettings as any).cachedEmbeddingStats;
    }
    delete (validatedSettings as any).selectedProvider;
    delete (validatedSettings as any).selectedModelProviders;
    delete (validatedSettings as any).systemPrompt;
    delete (validatedSettings as any).systemPromptType;
    delete (validatedSettings as any).systemPromptPath;
    delete (validatedSettings as any).useLatestSystemPromptForNewChats;

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
