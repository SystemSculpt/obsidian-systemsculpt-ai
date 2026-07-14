import {
  LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4,
  LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3,
  LEGACY_FEATURE_KEYS_REMOVED_IN_V6,
  LEGACY_KEYS_REMOVED_IN_V1,
  LEGACY_UPDATE_KEYS_REMOVED_IN_V8,
} from "./migrations/SettingsMigrator";

const CURRENT_SECRET_KEYS = ["licenseKey"] as const;

/**
 * Backups never carry retired provider credentials or configuration. This is
 * intentionally repeated on restore so an old or hand-edited backup cannot
 * reintroduce a removed secret before schema migration runs.
 */
function removeRetiredSettings(settings: Record<string, unknown>): void {
  delete settings.managedDisclosureAcceptance;
  for (const key of [
    ...LEGACY_KEYS_REMOVED_IN_V1,
    ...LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3,
    ...LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4,
    ...LEGACY_FEATURE_KEYS_REMOVED_IN_V6,
    ...LEGACY_UPDATE_KEYS_REMOVED_IN_V8,
  ]) {
    delete settings[key];
  }
}

export function redactSettingsForBackup<T extends Record<string, unknown>>(settings: T): T {
  const redacted: Record<string, unknown> = { ...settings };
  for (const key of CURRENT_SECRET_KEYS) redacted[key] = "";
  removeRetiredSettings(redacted);
  return redacted as T;
}

export function applyCurrentSecretsToBackup<T extends Record<string, unknown>>(
  backup: T,
  currentSettings: Record<string, unknown>,
): T {
  const merged: Record<string, unknown> = { ...backup };
  for (const key of CURRENT_SECRET_KEYS) {
    merged[key] = typeof currentSettings[key] === "string" ? currentSettings[key] : "";
  }
  removeRetiredSettings(merged);
  return merged as T;
}
