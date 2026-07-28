// Node prelude: the managed client stack expects a browser-like global
// surface (window.crypto). Imported first by the smoke entry.
const globalTarget = globalThis as Record<string, unknown>;
if (typeof globalTarget.window === "undefined") {
  globalTarget.window = globalThis;
}
export {};
