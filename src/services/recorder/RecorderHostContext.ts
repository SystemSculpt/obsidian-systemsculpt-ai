/**
 * The browser realm that owns one recording lifecycle.
 *
 * Obsidian popouts have distinct Window, Document, Navigator, media, timer,
 * and page-lifecycle objects. Resolve this once when recording starts, then
 * pass it through every recorder layer instead of consulting globals again.
 */
export interface RecorderHostContext {
  host: HTMLElement;
  hostDocument: Document;
  hostWindow: Window;
}

export function resolveRecorderHostContext(configuredHost?: HTMLElement | null): RecorderHostContext {
  const host = configuredHost ?? window.activeDocument?.body ?? document.body;
  const hostDocument = host.ownerDocument;
  const hostWindow = hostDocument.defaultView ?? window;
  return { host, hostDocument, hostWindow };
}
