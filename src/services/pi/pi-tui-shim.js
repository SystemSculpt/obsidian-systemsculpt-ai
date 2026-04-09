/**
 * Lightweight stub for @mariozechner/pi-tui.
 *
 * The Pi SDK's core modules import TUI rendering functions (Text, Container,
 * etc.) at the top level. In Obsidian we never render TUI output — we use
 * our own chat UI. This shim provides no-op stubs so the SDK loads without
 * crashing in Electron.
 */

const noop = () => {};
const noopComponent = () => ({ render: noop, toString: () => "" });

module.exports = {
  // TUI components used by tool renderers (bash, edit, read, write, find, grep, ls)
  Text: noopComponent,
  Container: noopComponent,
  Spacer: noopComponent,
  Loader: noopComponent,
  Markdown: noopComponent,
  TruncatedText: noopComponent,

  // Utility functions
  truncateToWidth: (str) => String(str || ""),
  visibleWidth: (str) => String(str || "").length,
  fuzzyFilter: (items) => items || [],
  getCapabilities: () => ({ sixel: false, iterm: false, kitty: false }),
  getImageDimensions: () => ({ width: 0, height: 0 }),
  imageFallback: () => "",
  matchesKey: () => false,
  setKeybindings: noop,

  // Keybindings
  TUI_KEYBINDINGS: {},
  KeybindingsManager: class KeybindingsManager {
    constructor() { this.keybindings = {}; }
    get() { return undefined; }
    set() {}
    getAll() { return {}; }
    load() {}
    save() {}
  },

  // TUI classes (not used in Obsidian but imported by interactive-mode)
  TUI: class TUI { constructor() {} start() {} stop() {} render() {} },
  ProcessTerminal: class ProcessTerminal { constructor() {} },
  CombinedAutocompleteProvider: class CombinedAutocompleteProvider { constructor() {} },
};
