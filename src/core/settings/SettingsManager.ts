import { Notice } from "obsidian";
import {
  SystemSculptSettings,
  DEFAULT_SETTINGS,
  LogLevel,
  createDefaultWorkflowEngineSettings,
  type PendingAudioProcessorUpload,
  type PendingRecorderCapture,
  type WorkflowEngineSettings,
  type WorkflowSkipEntry,
} from "../../types";
import SystemSculptPlugin from "../../main";
import { AutomaticBackupService } from "./AutomaticBackupService";
import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "./backupSanitizer";
import {
  CURRENT_SCHEMA_VERSION,
  migrateSettingsToCurrentSchema,
  readSchemaVersion,
} from "./migrations/SettingsMigrator";
import {
  getCurrentRecorderPreferenceHost,
  normalizePreferredMicrophoneId,
  seedCurrentHostPreferredMicrophoneId,
} from "../../services/recorder/RecorderPreferenceStore";

const DEVICE_LOCAL_RECORDER_PREFERENCE_SCHEMA_VERSION = 10;
const AUDIO_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizeWorkflowEngineSettings(value: unknown): WorkflowEngineSettings {
  const defaults = createDefaultWorkflowEngineSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;

  const candidate = value as Record<string, unknown>;
  const skippedFiles: Record<string, WorkflowSkipEntry> = {};
  if (candidate.skippedFiles && typeof candidate.skippedFiles === "object" && !Array.isArray(candidate.skippedFiles)) {
    for (const [key, rawEntry] of Object.entries(candidate.skippedFiles)) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Record<string, unknown>;
      if (
        entry.type !== "transcription"
        || typeof entry.path !== "string"
        || typeof entry.skippedAt !== "string"
      ) continue;
      skippedFiles[key] = {
        path: entry.path,
        type: "transcription",
        skippedAt: entry.skippedAt,
        ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      };
    }
  }

  const normalized = {
    ...candidate,
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaults.enabled,
    inboxRoutingEnabled: typeof candidate.inboxRoutingEnabled === "boolean"
      ? candidate.inboxRoutingEnabled
      : defaults.inboxRoutingEnabled,
    inboxFolder: typeof candidate.inboxFolder === "string" && candidate.inboxFolder.trim()
      ? candidate.inboxFolder
      : defaults.inboxFolder,
    processedNotesFolder: typeof candidate.processedNotesFolder === "string"
      ? candidate.processedNotesFolder
      : defaults.processedNotesFolder,
    autoTranscribeInboxNotes: typeof candidate.autoTranscribeInboxNotes === "boolean"
      ? candidate.autoTranscribeInboxNotes
      : defaults.autoTranscribeInboxNotes,
    skippedFiles,
  } as Record<string, unknown>;
  delete normalized.automations;
  delete normalized.templates;
  delete normalized.managedTextOperations;
  return normalized as unknown as WorkflowEngineSettings;
}

function normalizePendingAudioProcessorUpload(value: unknown): PendingAudioProcessorUpload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.jobId !== "string"
    || !AUDIO_JOB_ID_PATTERN.test(entry.jobId)
    || typeof entry.filename !== "string"
    || entry.filename.length === 0
    || entry.filename.length > 512
    || typeof entry.contentType !== "string"
    || entry.contentType.length === 0
    || entry.contentType.length > 128
    || !Number.isInteger(entry.sizeBytes)
    || (entry.sizeBytes as number) <= 0
    || !Number.isInteger(entry.partSizeBytes)
    || (entry.partSizeBytes as number) <= 0
    || !Number.isInteger(entry.totalParts)
    || (entry.totalParts as number) <= 0
    || !Number.isFinite(entry.updatedAt)
    || (entry.updatedAt as number) <= 0
    || !Array.isArray(entry.uploadedParts)
  ) return null;

  const rawSource = entry.source && typeof entry.source === "object" && !Array.isArray(entry.source)
    ? entry.source as Record<string, unknown>
    : null;
  const source = rawSource?.kind === "staged"
    && typeof rawSource.stagingId === "string"
    && SHA256_PATTERN.test(rawSource.stagingId)
    && typeof rawSource.manifestSha256 === "string"
    && SHA256_PATTERN.test(rawSource.manifestSha256)
    ? {
      kind: "staged" as const,
      stagingId: rawSource.stagingId,
      manifestSha256: rawSource.manifestSha256,
    }
    : rawSource?.kind === "vault"
      && typeof rawSource.filePath === "string"
      && rawSource.filePath.length > 0
      && rawSource.filePath.length <= 1024
      && Number.isFinite(rawSource.modifiedAt)
      && (rawSource.modifiedAt as number) > 0
      ? {
        kind: "vault" as const,
        filePath: rawSource.filePath,
        modifiedAt: rawSource.modifiedAt as number,
      }
      : typeof entry.filePath === "string"
        && entry.filePath.length > 0
        && entry.filePath.length <= 1024
        && Number.isFinite(entry.modifiedAt)
        && (entry.modifiedAt as number) > 0
        ? {
          kind: "vault" as const,
          filePath: entry.filePath,
          modifiedAt: entry.modifiedAt as number,
        }
        : null;
  if (!source) return null;

  const uploadedPartMap = new Map<number, { partNumber: number; etag: string }>();
  for (const valuePart of entry.uploadedParts) {
    if (!valuePart || typeof valuePart !== "object" || Array.isArray(valuePart)) return null;
    const part = valuePart as Record<string, unknown>;
    if (
      !Number.isInteger(part.partNumber)
      || (part.partNumber as number) <= 0
      || (part.partNumber as number) > (entry.totalParts as number)
      || typeof part.etag !== "string"
      || part.etag.trim().length === 0
      || part.etag.length > 512
    ) return null;
    uploadedPartMap.set(part.partNumber as number, {
      partNumber: part.partNumber as number,
      etag: part.etag.trim(),
    });
  }

  return {
    jobId: entry.jobId,
    filename: entry.filename,
    contentType: entry.contentType,
    sizeBytes: entry.sizeBytes as number,
    source,
    partSizeBytes: entry.partSizeBytes as number,
    totalParts: entry.totalParts as number,
    uploadedParts: [...uploadedPartMap.values()].sort(
      (left, right) => left.partNumber - right.partNumber,
    ),
    updatedAt: entry.updatedAt as number,
  };
}

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
        const globalCrypto: any = (window as any).crypto;
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

    if (typeof migratedSettings.lastAnnouncedPluginRelease !== "string") {
      migratedSettings.lastAnnouncedPluginRelease = DEFAULT_SETTINGS.lastAnnouncedPluginRelease;
    }
    if (typeof migratedSettings.lastLoadedPluginVersion !== "string") {
      migratedSettings.lastLoadedPluginVersion = DEFAULT_SETTINGS.lastLoadedPluginVersion;
    }

    // Legacy/dead keys are pruned by the versioned migrator's v0→v1 step
    // (SettingsMigrator.LEGACY_KEYS_REMOVED_IN_V1) — no ad-hoc deletes here.

    migratedSettings.workflowEngine = normalizeWorkflowEngineSettings(migratedSettings.workflowEngine);
    
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
      // Capture the retired synced value before schema v10 prunes it. The
      // device-local write happens only after the remaining migration validates.
      const legacyRecorderPreference = this.readLegacyRecorderPreference(raw, fromVersion);
      const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);
      // Back up BEFORE applying a real schema upgrade so a migration bug found
      // later is always recoverable from the pre-migration snapshot.
      if (!result.future && result.fromVersion < CURRENT_SCHEMA_VERSION && this.hasMeaningfulData(raw)) {
        await this.writePreMigrationBackup(raw, fromVersion);
      }
      const migrated = await this.validateSettingsAsync(this.migrateSettings(result.settings));
      if (!result.future) {
        this.seedLegacyRecorderPreference(legacyRecorderPreference, migrated);
      }
      return migrated;
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

  private readLegacyRecorderPreference(
    raw: Record<string, unknown>,
    fromVersion: number,
  ): string {
    if (fromVersion >= DEVICE_LOCAL_RECORDER_PREFERENCE_SCHEMA_VERSION) return "";

    const host = getCurrentRecorderPreferenceHost();
    const byHost = raw.preferredMicrophoneIdsByHost;
    let hostPreference: unknown;
    if (byHost && typeof byHost === "object" && !Array.isArray(byHost)) {
      const values = byHost as Record<string, unknown>;
      if (host === "desktop") {
        hostPreference = values.desktop ?? values.Desktop;
      } else if (host === "mobile") {
        hostPreference = values.mobile ?? values.Mobile;
      }
    }

    return normalizePreferredMicrophoneId(hostPreference)
      || normalizePreferredMicrophoneId(raw.preferredMicrophoneId);
  }

  private seedLegacyRecorderPreference(
    preferredMicrophoneId: string,
    migrated: SystemSculptSettings,
  ): void {
    if (!preferredMicrophoneId || typeof window === "undefined") return;

    const globalWindow = window as Window & { activeWindow?: Window };
    const ownerWindow = globalWindow.activeWindow ?? globalWindow;
    const vaultName = typeof this.plugin.app.vault.getName === "function"
      ? this.plugin.app.vault.getName()
      : "";
    const vaultIdentity = migrated.vaultInstanceId?.trim() || vaultName;
    seedCurrentHostPreferredMicrophoneId(
      ownerWindow,
      vaultIdentity,
      preferredMicrophoneId,
    );
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

    if (!Array.isArray(validatedSettings.pendingRecorderCaptures)) {
      validatedSettings.pendingRecorderCaptures = [];
    } else {
      const validPendingCaptures: PendingRecorderCapture[] = validatedSettings.pendingRecorderCaptures
        .filter((entry) => {
          if (!entry || typeof entry !== "object") return false;
          return typeof entry.filePath === "string"
            && entry.filePath.length > 0
            && entry.filePath.length <= 1024
            && Number.isFinite(entry.startedAt)
            && entry.startedAt >= 0
            && Number.isFinite(entry.durationMs)
            && entry.durationMs >= 0
            && Number.isFinite(entry.sizeBytes)
            && entry.sizeBytes > 0
            && ["manual", "background-hidden", "background-pagehide", "interrupted", "size-limit"].includes(entry.stopReason)
            && ["note", "chat"].includes(entry.destination)
            && (entry.transcriptionIntent === undefined
              || ["automatic", "manual"].includes(entry.transcriptionIntent))
            && (entry.operationId === undefined
              || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.operationId))
            && (entry.recoveryBlocked === undefined
              || entry.recoveryBlocked === "conflicting-operation-ids");
        })
        .slice(-20)
        .map((entry): PendingRecorderCapture => ({
          filePath: entry.filePath,
          startedAt: entry.startedAt,
          durationMs: entry.durationMs,
          sizeBytes: entry.sizeBytes,
          stopReason: entry.stopReason,
          destination: entry.destination,
          ...(entry.transcriptionIntent
            ? { transcriptionIntent: entry.transcriptionIntent }
            : {}),
          ...(entry.operationId ? { operationId: entry.operationId } : {}),
          ...(entry.recoveryBlocked === "conflicting-operation-ids"
            ? { recoveryBlocked: entry.recoveryBlocked }
            : {}),
        }));
      const pendingByPath = new Map<string, PendingRecorderCapture>();
      for (const entry of validPendingCaptures) {
        const current = pendingByPath.get(entry.filePath);
        if (!current) {
          pendingByPath.set(entry.filePath, entry);
          continue;
        }
        const currentOperationId = current.operationId;
        const nextOperationId = entry.operationId;
        if (
          current.recoveryBlocked === "conflicting-operation-ids"
          || (currentOperationId && nextOperationId && currentOperationId !== nextOperationId)
        ) {
          const { operationId: _discarded, ...newest } = entry;
          pendingByPath.set(entry.filePath, {
            ...newest,
            ...(current.transcriptionIntent === "manual"
              ? { transcriptionIntent: "manual" }
              : {}),
            recoveryBlocked: "conflicting-operation-ids",
          });
          continue;
        }
        pendingByPath.set(entry.filePath, {
          ...entry,
          ...(current.transcriptionIntent === "manual"
            || entry.transcriptionIntent === "manual"
            ? { transcriptionIntent: "manual" }
            : entry.transcriptionIntent || current.transcriptionIntent
              ? { transcriptionIntent: entry.transcriptionIntent ?? current.transcriptionIntent }
              : {}),
          ...(nextOperationId || currentOperationId
            ? { operationId: nextOperationId ?? currentOperationId }
            : {}),
        });
      }
      validatedSettings.pendingRecorderCaptures = [...pendingByPath.values()];
    }

    if (!Array.isArray(validatedSettings.pendingAudioProcessorUploads)) {
      validatedSettings.pendingAudioProcessorUploads = [];
    } else {
      const validUploads: PendingAudioProcessorUpload[] = validatedSettings.pendingAudioProcessorUploads
        .map((entry) => normalizePendingAudioProcessorUpload(entry))
        .filter((entry): entry is PendingAudioProcessorUpload => entry !== null)
        .slice(-10);
      const newestByJobId = new Map<string, PendingAudioProcessorUpload>();
      for (const entry of validUploads) newestByJobId.set(entry.jobId, entry);
      validatedSettings.pendingAudioProcessorUploads = [...newestByJobId.values()];
    }

    if (typeof validatedSettings.postProcessingEnabled !== 'boolean') {
      validatedSettings.postProcessingEnabled = defaultSettings.postProcessingEnabled;
    }

    if (typeof validatedSettings.postProcessingPrompt !== "string") {
      validatedSettings.postProcessingPrompt = defaultSettings.postProcessingPrompt;
    }

    if (typeof validatedSettings.cleanTranscriptionOutput !== 'boolean') {
      validatedSettings.cleanTranscriptionOutput = defaultSettings.cleanTranscriptionOutput;
    }

    if (typeof validatedSettings.autoSubmitAfterTranscription !== "boolean") {
      validatedSettings.autoSubmitAfterTranscription = defaultSettings.autoSubmitAfterTranscription;
    }

    if (validatedSettings.transcriptionOutputFormat !== "markdown" && validatedSettings.transcriptionOutputFormat !== "srt") {
      validatedSettings.transcriptionOutputFormat = defaultSettings.transcriptionOutputFormat;
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

    validatedSettings.workflowEngine = normalizeWorkflowEngineSettings(validatedSettings.workflowEngine);

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
