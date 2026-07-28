// Minimal Obsidian surface for running the managed chat client stack under
// Node in the live smoke. Only what the imported module graph touches.
export function normalizePath(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isMobile: false,
  isIosApp: false,
  isAndroidApp: false,
};
export class Notice {
  constructor(_message?: unknown, _timeout?: number) {}
  setMessage(): this { return this; }
  hide(): void {}
}
export function requestUrl(): never {
  throw new Error("The live smoke must not fall back to Obsidian requestUrl.");
}
export function parseYaml(): never {
  throw new Error("parseYaml is not available in the live smoke.");
}
export function setIcon(): void {}
export class TFile {}
export class ItemView {}
export class Component {}
export class App {}
export class SearchComponent {}
