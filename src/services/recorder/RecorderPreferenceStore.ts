import { getHostDeviceType } from "../../platform/hostCapabilities";

export type RecorderPreferenceHost = "desktop" | "mobile" | "unknown";

const STORAGE_PREFIX = "systemsculpt-ai:recorder-microphone";
const memoryPreferences = new Map<string, string>();

export function normalizePreferredMicrophoneId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized !== "default" ? normalized : "";
}

export function getCurrentRecorderPreferenceHost(): RecorderPreferenceHost {
  switch (getHostDeviceType()) {
    case "Desktop":
      return "desktop";
    case "Mobile":
      return "mobile";
    default:
      return "unknown";
  }
}

export function getCurrentHostPreferredMicrophoneId(
  ownerWindow: Window,
  vaultIdentity: string,
): string {
  const host = getCurrentRecorderPreferenceHost();
  if (host === "unknown") return "";
  const key = recorderPreferenceKey(vaultIdentity, host);
  try {
    const stored = ownerWindow.localStorage.getItem(key);
    if (stored !== null) return normalizePreferredMicrophoneId(stored);
  } catch {
    // Use the in-process copy below when device-local storage is unavailable.
  }
  return normalizePreferredMicrophoneId(memoryPreferences.get(key));
}

export function setCurrentHostPreferredMicrophoneId(
  ownerWindow: Window,
  vaultIdentity: string,
  preferredMicrophoneId: unknown,
): void {
  const host = getCurrentRecorderPreferenceHost();
  if (host === "unknown") return;
  const key = recorderPreferenceKey(vaultIdentity, host);
  const value = normalizePreferredMicrophoneId(preferredMicrophoneId);
  memoryPreferences.set(key, value);
  try {
    ownerWindow.localStorage.setItem(key, value);
  } catch {
    // The in-process copy still keeps the selection stable for this session.
  }
}

/**
 * Seeds a migrated synced preference only when this device has never stored a
 * choice for the current host. An explicitly stored empty string means the
 * user selected Default microphone and must not be replaced by migration.
 */
export function seedCurrentHostPreferredMicrophoneId(
  ownerWindow: Window,
  vaultIdentity: string,
  preferredMicrophoneId: unknown,
): boolean {
  const host = getCurrentRecorderPreferenceHost();
  const value = normalizePreferredMicrophoneId(preferredMicrophoneId);
  if (host === "unknown" || !value) return false;

  const key = recorderPreferenceKey(vaultIdentity, host);
  try {
    if (ownerWindow.localStorage.getItem(key) !== null) return false;
  } catch {
    // Fall through to the in-process presence check when storage is unreadable.
  }
  if (memoryPreferences.has(key)) return false;

  memoryPreferences.set(key, value);
  try {
    ownerWindow.localStorage.setItem(key, value);
  } catch {
    // The in-process copy preserves the migrated choice for this session.
  }
  return true;
}

function recorderPreferenceKey(
  vaultIdentity: string,
  host: Exclude<RecorderPreferenceHost, "unknown">,
): string {
  const vault = encodeURIComponent(vaultIdentity.trim() || "default-vault");
  return `${STORAGE_PREFIX}:${vault}:${host}`;
}
