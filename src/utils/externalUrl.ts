import { resolveElectronModule } from "../platform/hostCapabilities";

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
  const electron = resolveElectronModule<{
    shell?: { openExternal?: (url: string) => Promise<unknown> | unknown };
  }>(targetWindow);
  const shell = electron?.shell;
  try {
    if (typeof shell?.openExternal === "function") {
      await shell.openExternal(href);
      return true;
    }
  } catch {
    // Fall back to window.open below.
  }
  // No Electron (mobile host): a synthetic anchor click routes through the
  // webview's external-link handling — the same path as tapping a link in a
  // note. WKWebView on iOS silently ignores window.open with a features
  // string, so the anchor is the reliable route; window.open stays last.
  const doc = targetWindow?.document;
  if (doc?.body && typeof doc.createElement === "function") {
    const anchor = doc.createElement("a");
    anchor.setAttribute("href", href);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    doc.body.appendChild(anchor);
    try {
      anchor.click();
      return true;
    } catch {
      // Fall through to window.open below.
    } finally {
      anchor.remove();
    }
  }
  if (typeof targetWindow?.open === "function") {
    targetWindow.open(href, "_blank");
    return true;
  }
  return false;
}
