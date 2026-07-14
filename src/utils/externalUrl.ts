/**
 * Open an external URL safely.
 *
 * - Only `http:`/`https:` schemes are honored — a `javascript:`/`data:` URL
 *   (e.g. an untrusted value that reached us via server metadata) is rejected.
 * - Prefers the system browser via Electron `shell.openExternal` on desktop.
 * - Falls back to `window.open(..., "_blank", "noopener,noreferrer")` to avoid
 *   reverse-tabnabbing / opener abuse.
 *
 * Returns `true` if the URL was safe and an open was attempted, `false` otherwise.
 */
export async function openExternalUrl(url: string, ownerWindow?: Window): Promise<boolean> {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const href = parsed.toString();

  const targetWindow = ownerWindow
    ?? (typeof window !== "undefined" ? window.activeWindow ?? window : undefined);
  const runtimeRequire = (targetWindow as any)?.require;
  const electron = typeof runtimeRequire === "function" ? runtimeRequire("electron") : null;
  const shell = electron?.shell;
  try {
    if (typeof shell?.openExternal === "function") {
      await shell.openExternal(href);
      return true;
    }
  } catch {
    // Fall back to window.open below.
  }
  if (typeof targetWindow?.open === "function") {
    targetWindow.open(href, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}
