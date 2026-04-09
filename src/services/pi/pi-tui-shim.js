/**
 * Lightweight stub for @mariozechner/pi-tui.
 *
 * The Pi SDK's core modules import TUI rendering functions and classes at the
 * top level, and some (bash, write, edit, etc.) extend them. In Obsidian we
 * never render TUI output — we use our own chat UI. This shim provides no-op
 * stubs so the SDK loads without crashing in Electron.
 *
 * IMPORTANT: Component exports MUST be real classes (not arrow functions)
 * because the SDK uses `class X extends Container` etc.
 *
 * Uses ESM exports so esbuild can resolve named imports from the SDK.
 */

const noop = () => {};

// Real class so the SDK's `class X extends Container` works.
class BaseComponent {
  constructor() {
    this.children = [];
  }
  render() {}
  toString() { return ""; }
  add() { return this; }
  remove() { return this; }
  clear() { return this; }
}

export class Container extends BaseComponent {}
export class Text extends BaseComponent {}
export class Box extends BaseComponent {}
export class Spacer extends BaseComponent {}
export class Loader extends BaseComponent {}
export class Markdown extends BaseComponent {}
export class TruncatedText extends BaseComponent {}
export class Image extends BaseComponent {}
export class Input extends BaseComponent {
  getValue() { return ""; }
  setValue() {}
}
export class Editor extends BaseComponent {
  getValue() { return ""; }
  setValue() {}
}
export class SelectList extends BaseComponent {
  getSelectedItem() { return null; }
}
export class SettingsList extends BaseComponent {}
export class CancellableLoader extends BaseComponent {}

export const truncateToWidth = (str) => String(str || "");
export const visibleWidth = (str) => String(str || "").length;
export const fuzzyFilter = (items) => items || [];
export const fuzzyMatch = () => null;
export const getCapabilities = () => ({ sixel: false, iterm: false, kitty: false });
export const getImageDimensions = () => ({ width: 0, height: 0 });
export const imageFallback = () => "";
export const matchesKey = () => false;
export const setKeybindings = noop;
export const getKeybindings = () => ({});

export const Key = {};
export const TUI_KEYBINDINGS = {};

export class KeybindingsManager {
  constructor() { this.keybindings = {}; }
  get() { return undefined; }
  set() {}
  getAll() { return {}; }
  load() {}
  save() {}
}

// Not used in Obsidian but imported by the SDK's interactive-mode.
export class TUI { constructor() {} start() {} stop() {} render() {} }
export class ProcessTerminal { constructor() {} }
export class CombinedAutocompleteProvider { constructor() {} }
