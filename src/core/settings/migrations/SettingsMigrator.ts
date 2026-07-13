import { SystemSculptSettings } from "../../../types";
import { CURRENT_SCHEMA_VERSION } from "./schemaVersion";

export { CURRENT_SCHEMA_VERSION };

/**
 * Top-level keys that existed in pre-versioning (v0) settings and have since
 * been removed from the schema. The v0→v1 migration prunes them so dead data
 * does not linger across an update. Previously these were `delete`d ad-hoc on
 * every load/save inside SettingsManager; the versioned chain is their single
 * canonical home now.
 */
export const LEGACY_KEYS_REMOVED_IN_V1: readonly string[] = [
  "cachedEmbeddingStats",
  "defaultTemplateModelId",
  "studioTelemetryOptIn",
  "selectedProvider",
  "selectedModelProviders",
  "systemPrompt",
  "systemPromptType",
  "systemPromptPath",
  "useLatestSystemPromptForNewChats",
  "canvasFlowEnabled",
  "toolingAutoApproveReadOnly",
  "excludedFolders",
  "excludedFiles",
  "autoUpdateSimilarNotes",
  "hideSimilarNotesAlreadyInContext",
  "backgroundEmbeddingUpdates",
  "recordSystemAudio",
  "templateHotkey",
  "enableTemplateHotkey",
  "videoRecordingsDirectory",
  "videoCaptureSystemAudio",
  "videoCaptureMicrophoneAudio",
  "showVideoRecordButtonInChat",
  "showVideoRecordingPermissionPopup",
];

export const LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3: readonly string[] = [
  "embeddingsModel",
  "embeddingsProvider",
  "embeddingsCustomEndpoint",
  "embeddingsCustomApiKey",
  "embeddingsCustomModel",
  "embeddingsBatchSize",
  "embeddingsRateLimitPerMinute",
  "embeddingsQuietPeriodMs",
  "embeddingsRebuildRetryAt",
];

/**
 * Client-owned text-model routing was retired in schema v4. These values can
 * contain provider credentials, so migration deletes the complete legacy
 * surface instead of carrying inert secrets into managed-only settings.
 */
export const LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4: readonly string[] = [
  "serverUrl",
  "settingsMode",
  "selectedModelId",
  "useLatestModelEverywhere",
  "showModelTooltips",
  "showVisionModelsOnly",
  "showTopPicksOnly",
  "customProviders",
  "studioPiAuthMigrationVersion",
  "modelFilterSettings",
  "favoriteModels",
  "favoritesFilterSettings",
  "activeProvider",
  "lastUsedModel",
  "enableSystemSculptProvider",
  "useSystemSculptAsFallback",
  "contextWindowPercentage",
  "openAiApiKey",
  "runtimeToolIncompatibleModels",
  "runtimeImageIncompatibleModels",
  "piAuth",
  "piAuthStorage",
  "piModels",
  "localPiModelId",
  "defaultModelId",
  "transcriptionProvider",
  "customTranscriptionEndpoint",
  "customTranscriptionApiKey",
  "customTranscriptionModel",
  "imageGenerationDefaultModelId",
  "imageGenerationLastUsedModelId",
  "imageGenerationModelCatalogCache",
  "imageGenerationLastUsedCount",
  "imageGenerationLastUsedAspectRatio",
  "imageGenerationPollIntervalMs",
  "imageGenerationOutputDir",
  "imageGenerationSaveMetadataSidecar",
  "readwiseEnabled",
  "readwiseApiToken",
  "readwiseDestinationFolder",
  "readwiseOrganization",
  "readwiseTweetOrganization",
  "readwiseSyncMode",
  "readwiseSyncIntervalMinutes",
  "readwiseLastSyncTimestamp",
  "readwiseLastSyncCursor",
  "readwiseImportOptions",
  "mcpServers",
] as const;

export const LEGACY_CHAT_KEYS_REMOVED_IN_V5: readonly string[] = [
  "systemPromptsDirectory",
  "lastUsedPromptPath",
  "agentModeEnabled",
  "hideSystemMessagesInChat",
  "preserveReasoningVerbatim",
] as const;

export const LEGACY_DIRECTORY_KEYS_REMOVED_IN_V5: readonly string[] = [
  "webResearchDirectory",
  "verifiedDirectories",
] as const;

export interface SettingsMigrationStep {
  /** The schema version this step upgrades the settings TO (from `to - 1`). */
  readonly to: number;
  readonly describe: string;
  readonly migrate: (settings: Record<string, unknown>) => Record<string, unknown>;
}

export interface SettingsMigrationResult {
  readonly settings: Record<string, unknown>;
  /** Schema version read from the persisted data (0 = pre-versioning/garbage). */
  readonly fromVersion: number;
  /** Schema version stamped onto the result. */
  readonly toVersion: number;
  /** Human-readable descriptions of the steps that ran, in order. */
  readonly appliedSteps: string[];
  /** True when persisted data is from a NEWER schema than this build understands. */
  readonly future: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pruneLegacyKeysV1(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  for (const key of LEGACY_KEYS_REMOVED_IN_V1) {
    delete next[key];
  }
  return next;
}

/**
 * Ordered registry of schema migrations. Each step upgrades settings from
 * version `to - 1` to `to`. Add new steps here (never ad-hoc field deletes
 * scattered through load/validate) and bump CURRENT_SCHEMA_VERSION to match.
 */
export const SETTINGS_MIGRATIONS: readonly SettingsMigrationStep[] = [
  {
    to: 1,
    describe: "Prune legacy keys removed before schema versioning was introduced",
    migrate: pruneLegacyKeysV1,
  },
  {
    to: 2,
    describe: "Remove retired managed disclosure acceptance",
    migrate: (settings) => {
      const next = { ...settings };
      delete next.managedDisclosureAcceptance;
      return next;
    },
  },
  {
    to: 3,
    describe: "Remove legacy configurable embeddings provider and retry controls",
    migrate: (settings) => {
      const next = { ...settings };
      for (const key of LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3) {
        delete next[key];
      }
      return next;
    },
  },
  {
    to: 4,
    describe: "Remove retired client-side provider, model, Pi auth, and BYOK settings",
    migrate: (settings) => {
      const next = { ...settings };
      for (const key of LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4) {
        delete next[key];
      }
      return next;
    },
  },
  {
    to: 5,
    describe: "Remove retired client-owned chat prompt, mode, and directory settings",
    migrate: (settings) => {
      const next = { ...settings };
      for (const key of LEGACY_CHAT_KEYS_REMOVED_IN_V5) delete next[key];
      for (const key of LEGACY_DIRECTORY_KEYS_REMOVED_IN_V5) delete next[key];
      return next;
    },
  },
];

/** Read a non-negative integer schema version from raw data; 0 if absent/garbage. */
export function readSchemaVersion(raw: unknown): number {
  if (!isPlainObject(raw)) return 0;
  const value = raw.schemaVersion;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDefault);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneDefault(value[key]);
    return out;
  }
  return value;
}

/**
 * Recursively back-fill keys present in `defaults` but missing from `raw`,
 * WITHOUT overwriting values the user has set. Nested plain objects are merged
 * key-by-key; arrays and primitives are taken from `raw` when present. A nested
 * field that defaults to a plain object but is corrupt (non-object) in `raw` is
 * reset to the default. Keys present in `raw` but absent from `defaults` are
 * preserved — unknown/forward-compatible keys are never dropped here.
 *
 * This closes the "update wiped my nested setting" class (#112, #100): when a
 * release adds a sub-key to a nested settings object, old data gains it instead
 * of having the whole object replaced by a shallow `{ ...DEFAULT, ...raw }`.
 */
export function deepMergeDefaults(
  defaults: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const key of Object.keys(defaults)) {
    const defaultValue = defaults[key];
    const rawValue = raw[key];
    if (!(key in raw) || rawValue === undefined) {
      out[key] = cloneDefault(defaultValue);
    } else if (isPlainObject(defaultValue)) {
      out[key] = isPlainObject(rawValue)
        ? deepMergeDefaults(defaultValue, rawValue)
        : cloneDefault(defaultValue);
    } else {
      out[key] = rawValue;
    }
  }
  return out;
}

/**
 * Migrate raw persisted settings to the current schema:
 *  1. read the persisted schema version (absent/garbage → 0),
 *  2. deep-merge defaults to back-fill new/nested keys,
 *  3. run each ordered migration step from the persisted version up to current,
 *  4. stamp the resulting `schemaVersion`.
 *
 * Newer-than-current data (a downgrade scenario) is never mutated by steps and
 * keeps its own future version — we only back-fill missing keys, never
 * downgrade or prune data a future build may rely on.
 *
 * This function is PURE: it does not read or write disk and does not mutate its
 * inputs, so it is trivially testable and safe to run inside a try/rollback.
 */
export function migrateSettingsToCurrentSchema(
  raw: Record<string, unknown>,
  defaults: SystemSculptSettings,
): SettingsMigrationResult {
  const fromVersion = readSchemaVersion(raw);
  let merged = deepMergeDefaults(defaults as unknown as Record<string, unknown>, raw);
  const appliedSteps: string[] = [];

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    merged.schemaVersion = fromVersion;
    return { settings: merged, fromVersion, toVersion: fromVersion, appliedSteps, future: true };
  }

  for (const step of [...SETTINGS_MIGRATIONS].sort((a, b) => a.to - b.to)) {
    if (step.to > fromVersion && step.to <= CURRENT_SCHEMA_VERSION) {
      merged = step.migrate(merged);
      appliedSteps.push(step.describe);
    }
  }

  merged.schemaVersion = CURRENT_SCHEMA_VERSION;
  return { settings: merged, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, appliedSteps, future: false };
}

/**
 * Schema versions in [1, current] that have NO migration step. A non-empty
 * result means the chain has a gap: a bump to `current` would stamp data as
 * fully migrated while silently skipping the missing step. Guarded permanently
 * by SettingsMigrator.test.ts so a future schema bump that forgets a step fails
 * CI instead of shipping (#212).
 */
export function findMissingMigrationVersions(
  migrations: readonly SettingsMigrationStep[] = SETTINGS_MIGRATIONS,
  current: number = CURRENT_SCHEMA_VERSION,
): number[] {
  const targets = new Set(migrations.map((step) => step.to));
  const missing: number[] = [];
  for (let version = 1; version <= current; version++) {
    if (!targets.has(version)) missing.push(version);
  }
  return missing;
}
