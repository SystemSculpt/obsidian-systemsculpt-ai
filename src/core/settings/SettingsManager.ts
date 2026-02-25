import { SystemSculptSettings, DEFAULT_SETTINGS, LogLevel, createDefaultWorkflowEngineSettings } from "../../types";
import { AGENT_CONFIG } from "../../constants/agent";
import SystemSculptPlugin from "../../main";
import { AutomaticBackupService } from "./AutomaticBackupService";
import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "./backupSanitizer";

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
    
    if (!Array.isArray(migratedSettings.favoriteModels)) {
      migratedSettings.favoriteModels = DEFAULT_SETTINGS.favoriteModels;
    }

    const defaultWorkflowEngine = createDefaultWorkflowEngineSettings();
    if (!migratedSettings.workflowEngine) {
      migratedSettings.workflowEngine = defaultWorkflowEngine;
    } else {
      const providedEngine = migratedSettings.workflowEngine;
      const providedTemplates = providedEngine.templates || {};
      const mergedTemplates: Record<string, any> = {};
      const templateKeys = new Set([
        ...Object.keys(defaultWorkflowEngine.templates || {}),
        ...Object.keys(providedTemplates),
      ]);

      templateKeys.forEach((templateId) => {
        const baseTemplate = defaultWorkflowEngine.templates?.[templateId] || {
          id: templateId,
          enabled: false,
        };
        const overrideTemplate = providedTemplates[templateId] || {};
        mergedTemplates[templateId] = {
          ...baseTemplate,
          ...overrideTemplate,
          id: templateId,
          enabled: !!overrideTemplate.enabled,
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
        templates: mergedTemplates,
      };
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
    
    // Ensure selectedModelProviders is properly initialized (migration for existing users)
    if (!Array.isArray(migratedSettings.selectedModelProviders)) {
      migratedSettings.selectedModelProviders = DEFAULT_SETTINGS.selectedModelProviders;
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

    if (typeof migratedSettings.studioTelemetryOptIn !== "boolean") {
      migratedSettings.studioTelemetryOptIn = DEFAULT_SETTINGS.studioTelemetryOptIn;
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

    if (typeof validatedSettings.videoRecordingsDirectory !== 'string') {
      validatedSettings.videoRecordingsDirectory = defaultSettings.videoRecordingsDirectory;
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

    if (typeof validatedSettings.benchmarksDirectory !== 'string') {
      validatedSettings.benchmarksDirectory = defaultSettings.benchmarksDirectory;
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

    if (typeof validatedSettings.showVideoRecordButtonInChat !== 'boolean') {
      validatedSettings.showVideoRecordButtonInChat = defaultSettings.showVideoRecordButtonInChat;
    }

    if (typeof validatedSettings.videoCaptureSystemAudio !== 'boolean') {
      const legacySystemAudio = (validatedSettings as any).recordSystemAudio;
      validatedSettings.videoCaptureSystemAudio = typeof legacySystemAudio === "boolean"
        ? legacySystemAudio
        : defaultSettings.videoCaptureSystemAudio;
    }

    if (typeof validatedSettings.videoCaptureMicrophoneAudio !== 'boolean') {
      validatedSettings.videoCaptureMicrophoneAudio = defaultSettings.videoCaptureMicrophoneAudio;
    }

    if (typeof validatedSettings.showVideoRecordingPermissionPopup !== 'boolean') {
      validatedSettings.showVideoRecordingPermissionPopup = defaultSettings.showVideoRecordingPermissionPopup ?? true;
    }

    if (typeof validatedSettings.skipEmptyNoteWarning !== 'boolean') {
      validatedSettings.skipEmptyNoteWarning = defaultSettings.skipEmptyNoteWarning;
    }


    if (typeof validatedSettings.enableTemplateHotkey !== 'boolean') {
      validatedSettings.enableTemplateHotkey = defaultSettings.enableTemplateHotkey;
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
      validatedSettings.selectedModelId = defaultSettings.selectedModelId;
    }
    // Ensure a sensible out-of-the-box default model in Standard mode
    if (!validatedSettings.selectedModelId || validatedSettings.selectedModelId.trim().length === 0) {
      validatedSettings.selectedModelId = AGENT_CONFIG.MODEL_ID;
    }

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

    if (typeof validatedSettings.systemPromptType !== 'string') {
      validatedSettings.systemPromptType = defaultSettings.systemPromptType;
    }

    // CRITICAL: Check if systemPromptType is "agent" - this is no longer valid as a default.
    // Agent Mode is now per-chat only, so force switch to general-use if user has this set.
    if (validatedSettings.systemPromptType === 'agent') {
      validatedSettings.systemPromptType = 'general-use';
      validatedSettings.systemPromptPath = ''; // Clear any associated path
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

    // Remove cachedEmbeddingStats if it exists (from old embeddings system)
    if ('cachedEmbeddingStats' in validatedSettings) {
      delete (validatedSettings as any).cachedEmbeddingStats;
    }

    // Ensure server URL is a string and properly matches development mode
    const currentServerUrl = validatedSettings.serverUrl;
    
    // Import development mode constants
    const { API_BASE_URL } = require('../../constants/api');
    const correctUrl = API_BASE_URL.replace('/api/v1', ''); // Remove the API path suffix
    
    if (typeof currentServerUrl !== 'string' || currentServerUrl.trim() === '') {
      validatedSettings.serverUrl = correctUrl;
    } 
    // Check for mode mismatches and auto-correct them
    else if (currentServerUrl.includes('localhost') && correctUrl.includes('api.systemsculpt.com')) {
      validatedSettings.serverUrl = correctUrl;
    }
    else if (currentServerUrl.includes('api.systemsculpt.com') && correctUrl.includes('localhost')) {
      validatedSettings.serverUrl = correctUrl;
    }
    else {
      // Server URL validation passed - silent success
    }

    const defaultWorkflowEngine = createDefaultWorkflowEngineSettings();
    const providedWorkflowEngine = validatedSettings.workflowEngine;
    if (!providedWorkflowEngine) {
      validatedSettings.workflowEngine = defaultWorkflowEngine;
    } else {
      const sanitizedTaskDestination =
        providedWorkflowEngine.taskDestination === "daily-note" ? "daily-note" : "central-note";
      const mergedTemplates: Record<string, any> = {};
      const providedTemplates = providedWorkflowEngine.templates || {};
      const templateIds = new Set([
        ...Object.keys(defaultWorkflowEngine.templates || {}),
        ...Object.keys(providedTemplates),
      ]);

      templateIds.forEach((templateId) => {
        const baseTemplate = defaultWorkflowEngine.templates?.[templateId] || {
          id: templateId,
          enabled: false,
          tasksDestination: "central-note",
        };
        const overrideTemplate = providedTemplates[templateId] || {};
        const tasksDestination =
          overrideTemplate.tasksDestination === "daily-note" ? "daily-note" : "central-note";
        mergedTemplates[templateId] = {
          ...baseTemplate,
          ...overrideTemplate,
          id: templateId,
          enabled: !!overrideTemplate.enabled,
          tasksDestination,
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
        taskDestination: sanitizedTaskDestination,
        taskNotePath:
          typeof providedWorkflowEngine.taskNotePath === "string"
            ? providedWorkflowEngine.taskNotePath
            : defaultWorkflowEngine.taskNotePath,
        autoTranscribeInboxNotes:
          typeof providedWorkflowEngine.autoTranscribeInboxNotes === "boolean"
            ? providedWorkflowEngine.autoTranscribeInboxNotes
            : defaultWorkflowEngine.autoTranscribeInboxNotes,
        inboxRoutingEnabled:
          typeof providedWorkflowEngine.inboxRoutingEnabled === "boolean"
            ? providedWorkflowEngine.inboxRoutingEnabled
            : defaultWorkflowEngine.inboxRoutingEnabled,
        templates: mergedTemplates,
      };
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
      // Use the plugin's internal settings (which is what gets updated by the UI) instead of this.settings
      this.settings = { ...this.plugin._internal_settings_systemsculpt_plugin };
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
    await this.updateSettings({ serverUrl: url });
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
