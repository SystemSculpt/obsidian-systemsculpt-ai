import { requireApiVersion, type App } from "obsidian";

const DEVICE_KEY = "systemsculpt-studio-device";
const devices = new WeakMap<object, StudioDevice>();

/** `persistent` is false when the host keeps the identity for this session only. */
export type StudioDevice = Readonly<{ id: string; persistent: boolean }>;

/**
 * A stable, device-local identity for this vault: it names the device's clock
 * file, breaks stamp ties and says which machine executes a Codex run.
 * Vault-scoped local storage is not synchronized, unlike the plugin's
 * data.json; hosts without it use one identity per session.
 */
export function studioDevice(app: App): StudioDevice {
  const known = devices.get(app);
  if (known) return known;
  let id = "", persistent = false;
  // Vault-scoped local storage exists from Obsidian 1.8.7.
  try {
    if (requireApiVersion("1.8.7")) {
      const stored: unknown = app.loadLocalStorage(DEVICE_KEY);
      if (typeof stored === "string" && /^[0-9a-f]{12}$/.test(stored)) { id = stored; persistent = true; }
    }
  } catch { /* Unreadable storage: a new identity. */ }
  if (!id) {
    id = Array.from({length: 12}, () => Math.floor(Math.random() * 16).toString(16)).join("");
    try { if (requireApiVersion("1.8.7")) { app.saveLocalStorage(DEVICE_KEY, id); persistent = true; } } catch { /* A per-session identity still orders its own stamps. */ }
  }
  const device = { id, persistent };
  devices.set(app, device);
  return device;
}
