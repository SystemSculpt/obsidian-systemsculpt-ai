/**
 * Shared Obsidian mock for non-embeddings tests
 */

const defaultStat = () => ({
  ctime: Date.now(),
  mtime: Date.now(),
  size: 0,
});

class TFile {
  constructor({ path, name, extension, stat } = {}) {
    this.path = path ?? "";
    this.name = name ?? (path ? path.split("/").pop() ?? "" : "");
    this.extension = extension ?? (this.name.split(".").pop() ?? "");
    const baseName = this.name.includes(".") ? this.name.slice(0, this.name.lastIndexOf(".")) : this.name;
    this.basename = baseName;
    this.stat = { ...defaultStat(), ...(stat ?? {}) };
  }
}

class TFolder {
  constructor({ path, children } = {}) {
    this.path = path ?? "";
    this.name = path ? path.split("/").pop() ?? "" : "";
    this.children = Array.isArray(children) ? children : [];
  }
}

class MarkdownView {}

class Component {
  constructor() {
    this.children = [];
    this._eventRefs = [];
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    this.children.forEach((child) => child.load?.());
  }

  unload() {
    if (!this._loaded) return;
    // Mark as unloaded before invoking hooks so calling super.unload() inside
    // onunload() is a no-op (mirrors Obsidian behavior and avoids recursion).
    this._loaded = false;
    this.onunload();
    // Unregister any events/cleanup callbacks registered on this component
    try {
      this._eventRefs.forEach((ref) => {
        try {
          if (typeof ref === "function") {
            ref();
          } else if (ref && typeof ref.unload === "function") {
            ref.unload();
          }
        } catch (_) {
          // ignore cleanup failures
        }
      });
    } catch (_) {
      // ignore cleanup failures
    }
    this._eventRefs = [];
    // Unload children
    try {
      this.children.forEach((child) => child.unload?.());
    } catch (_) {
      // ignore
    }
    this.children = [];
  }

  onload() {}
  onunload() {}

  register(callback) {
    if (typeof callback === "function") {
      this._eventRefs.push(callback);
    }
    return callback;
  }

  registerDomEvent(el, type, callback) {
    if (!el || !type || typeof callback !== "function") return;
    el.addEventListener(type, callback);
    this.register(() => {
      try {
        el.removeEventListener(type, callback);
      } catch (_) {
        // ignore
      }
    });
  }

  registerEvent(ref) {
    this._eventRefs.push(ref);
    return ref;
  }

  addChild(child) {
    this.children.push(child);
    if (this._loaded && typeof child.load === "function") {
      child.load();
    }
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
}

class Modal extends Component {
  constructor(app) {
    super();
    this.app = app;
    this.modalEl = document.createElement("div");
    this.titleEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
  }

  open() {}

  open() {
    try {
      if (this.modalEl && !this.modalEl.parentNode) {
        document.body.appendChild(this.modalEl);
      }
    } catch (_) {}
    try {
      if (typeof this.onOpen === "function") {
        this.onOpen();
      }
    } catch (_) {}
  }

  close() {
    try {
      if (this.modalEl && this.modalEl.parentNode) {
        this.modalEl.parentNode.removeChild(this.modalEl);
      }
    } catch (_) {}
    try {
      if (typeof this.onClose === "function") {
        this.onClose();
      }
    } catch (_) {}
  }
}

class SuggestModal extends Modal {
  constructor(app) {
    super(app);
    this.app = app;
  }

  setPlaceholder() {}

  setInstructions() {}

  onOpen() {}

  onClose() {}

  selectSuggestion() {}
}

class AbstractInputSuggest extends Component {
  constructor(app, inputEl) {
    super();
    this.app = app;
    this.inputEl = inputEl;
  }

  setSuggestions() {}
  renderSuggestion() {}
  selectSuggestion() {}
}

const setIcon = jest.fn();
const debounce = (func, _wait) => {
  return (...args) => func(...args);
};

const MarkdownRenderer = {
  async render(_app, content, containerEl) {
    if (containerEl) {
      containerEl.textContent = `${content ?? ""}`;
    }
    return containerEl;
  },
  async renderMarkdown(content, containerEl) {
    if (containerEl) {
      containerEl.textContent = `${content ?? ""}`;
    }
    return containerEl;
  }
};

const Platform = {
  isDesktop: true,
  isMobile: false,
  isWin: false,
  isMacOS: false,
  isLinux: false,
  isIosApp: false,
  isAndroidApp: false,
  isDesktopApp: true,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
};

class App {
  constructor() {
    this.vault = {
      getMarkdownFiles: jest.fn(() => []),
      read: jest.fn(),
      cachedRead: jest.fn(),
      on: jest.fn(() => ({ unload: jest.fn() })),
      offref: jest.fn(),
      getFiles: jest.fn(() => []),
      getAllLoadedFiles: jest.fn(() => []),
      getRoot: jest.fn(() => new TFolder({ path: "/", children: [] })),
      getAbstractFileByPath: jest.fn(() => null),
      create: jest.fn(),
      createFolder: jest.fn(),
      modify: jest.fn(),
      configDir: "/.obsidian",
      adapter: {
        exists: jest.fn(),
        read: jest.fn(),
        write: jest.fn(),
        list: jest.fn(() => ({ files: [], folders: [] })),
        trashLocal: jest.fn(),
      },
    };
    this.fileManager = {
      renameFile: jest.fn(),
    };
    this.workspace = {
      on: jest.fn(() => ({ unload: jest.fn() })),
      off: jest.fn(),
      trigger: jest.fn(),
      getActiveViewOfType: jest.fn(() => null),
      getActiveFile: jest.fn(() => null),
      getLeavesOfType: jest.fn(() => []),
      onLayoutReady: jest.fn((cb) => cb()),
    };
    this.metadataCache = {
      getFileCache: jest.fn(() => null),
      getFirstLinkpathDest: jest.fn(() => null),
    };
  }
}

class Plugin extends Component {
  constructor(app = new App(), manifest = { id: "systemsculpt", version: "0.0.0" }) {
    super();
    this.app = app;
    this.manifest = manifest;
    this._commands = [];
    this._views = new Map();
    this._settingTabs = [];
    this._ribbons = [];
    this._editorExtensions = [];
    this._extensions = [];
  }

  addCommand(command) {
    this._commands.push(command);
    return command?.id;
  }

  addSettingTab(tab) {
    this._settingTabs.push(tab);
    return tab;
  }

  addRibbonIcon(icon, title, callback) {
    const ribbon = { icon, title, callback };
    this._ribbons.push(ribbon);
    return ribbon;
  }

  addStatusBarItem() {
    const el = document.createElement("div");
    return el;
  }

  registerView(viewType, viewCreator) {
    this._views.set(viewType, viewCreator);
    return viewCreator;
  }

  registerExtensions(extensions, viewType) {
    this._extensions.push({ extensions, viewType });
    return { extensions, viewType };
  }

  registerEditorExtension(extension) {
    this._editorExtensions.push(extension);
    return extension;
  }
}

class WorkspaceLeaf {
  constructor(app) {
    this.app = app;
    this.view = null;
    this._viewState = { type: "", state: {} };
  }

  getViewState() {
    return this._viewState;
  }

  async setViewState(viewState) {
    this._viewState = viewState;
  }
}

class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf?.app;
    // Mirror Obsidian's container layout: header + content container
    this.containerEl = document.createElement("div");
    this.containerEl.appendChild(document.createElement("div"));
    this.containerEl.appendChild(document.createElement("div"));
  }

  getViewType() {
    return "";
  }

  getDisplayText() {
    return "";
  }

  async onOpen() {}
  async onClose() {}
}

class PluginSettingTab extends Component {
  constructor(app, plugin) {
    super();
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }

  display() {}

  hide() {}
}

class ToggleComponent {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.toggleEl = containerEl.createEl("input", { attr: { type: "checkbox" } });
  }

  setValue(value) {
    this.toggleEl.checked = !!value;
    return this;
  }

  onChange(callback) {
    this.toggleEl.addEventListener("change", () => callback(this.toggleEl.checked));
    return this;
  }

  setDisabled(disabled) {
    this.toggleEl.disabled = !!disabled;
    return this;
  }
}

class DropdownComponent {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.selectEl = containerEl.createEl("select");
  }

  addOption(value, label) {
    const option = this.selectEl.createEl("option");
    option.value = value;
    option.textContent = label;
    return this;
  }

  addOptions(options) {
    Object.entries(options ?? {}).forEach(([value, label]) => {
      this.addOption(value, label);
    });
    return this;
  }

  setValue(value) {
    this.selectEl.value = value ?? "";
    return this;
  }

  onChange(callback) {
    this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
    return this;
  }

  setDisabled(disabled) {
    this.selectEl.disabled = !!disabled;
    return this;
  }
}

class TextComponent {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.inputEl = containerEl.createEl("input", { attr: { type: "text" } });
  }

  setPlaceholder(placeholder) {
    if (placeholder !== undefined) this.inputEl.setAttr("placeholder", placeholder);
    return this;
  }

  setValue(value) {
    this.inputEl.value = value ?? "";
    return this;
  }

  getValue() {
    return this.inputEl.value ?? "";
  }

  onChange(callback) {
    this.inputEl.addEventListener("change", () => callback(this.inputEl.value));
    return this;
  }

  setDisabled(disabled) {
    this.inputEl.disabled = !!disabled;
    return this;
  }

  setClass(cls) {
    if (cls) this.inputEl.addClass(cls);
    return this;
  }
}

class TextAreaComponent {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.inputEl = containerEl.createEl("textarea");
  }

  setPlaceholder(placeholder) {
    if (placeholder !== undefined) this.inputEl.setAttr("placeholder", placeholder);
    return this;
  }

  setValue(value) {
    this.inputEl.value = value ?? "";
    return this;
  }

  getValue() {
    return this.inputEl.value ?? "";
  }

  onChange(callback) {
    this.inputEl.addEventListener("change", () => callback(this.inputEl.value));
    return this;
  }

  setDisabled(disabled) {
    this.inputEl.disabled = !!disabled;
    return this;
  }

  setClass(cls) {
    if (cls) this.inputEl.addClass(cls);
    return this;
  }
}

class ButtonComponent {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.buttonEl = containerEl.createEl("button", { cls: "mod-button" });
  }

  setButtonText(text) {
    this.buttonEl.setText(text ?? "");
    return this;
  }

  setIcon(icon) {
    setIcon(this.buttonEl, icon);
    return this;
  }

  setTooltip(tooltip) {
    if (tooltip !== undefined) {
      this.buttonEl.setAttr("aria-label", tooltip);
      this.buttonEl.setAttr("title", tooltip);
    }
    return this;
  }

  setCta() {
    this.buttonEl.addClass("mod-cta");
    return this;
  }

  setWarning() {
    this.buttonEl.addClass("mod-warning");
    return this;
  }

  setClass(cls) {
    if (cls) this.buttonEl.addClass(cls);
    return this;
  }

  setDisabled(disabled) {
    this.buttonEl.disabled = !!disabled;
    return this;
  }

  onClick(callback) {
    this.buttonEl.addEventListener("click", (event) => callback(event));
    return this;
  }
}

class ExtraButtonComponent extends ButtonComponent {
  constructor(containerEl) {
    super(containerEl);
    this.buttonEl.addClass("extra-button");
  }
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setName(name) {
    this.nameEl.empty();
    if (typeof name === "string") {
      this.nameEl.setText(name);
    } else if (name instanceof HTMLElement) {
      this.nameEl.appendChild(name);
    }
    return this;
  }

  setDesc(desc) {
    this.descEl.empty();
    if (typeof desc === "string") {
      this.descEl.setText(desc);
    } else if (desc instanceof HTMLElement) {
      this.descEl.appendChild(desc);
    }
    return this;
  }

  setHeading() {
    this.settingEl.addClass("setting-item-heading");
    return this;
  }

  setClass(cls) {
    if (cls) this.settingEl.addClass(cls);
    return this;
  }

  addToggle(callback) {
    const component = new ToggleComponent(this.controlEl);
    callback?.(component);
    return this;
  }

  addDropdown(callback) {
    const component = new DropdownComponent(this.controlEl);
    callback?.(component);
    return this;
  }

  addButton(callback) {
    const component = new ButtonComponent(this.controlEl);
    callback?.(component);
    return this;
  }

  addExtraButton(callback) {
    const component = new ExtraButtonComponent(this.controlEl);
    callback?.(component);
    return this;
  }

  addText(callback) {
    const component = new TextComponent(this.controlEl);
    callback?.(component);
    return this;
  }

  addTextArea(callback) {
    const component = new TextAreaComponent(this.controlEl);
    callback?.(component);
    return this;
  }
}

module.exports = {
  App,
  Plugin,
  Notice: class Notice {
    constructor(message) {
      // eslint-disable-next-line no-console
      console.log(`Notice: ${message}`);
    }
  },
  TFile,
  TFolder,
  MarkdownView,
  WorkspaceLeaf,
  ItemView,
  Component,
  Modal,
  SuggestModal,
  AbstractInputSuggest,
  PluginSettingTab,
  Setting,
  ToggleComponent,
  DropdownComponent,
  TextComponent,
  TextAreaComponent,
  ButtonComponent,
  ExtraButtonComponent,
  Platform,
  setIcon,
  debounce,
  MarkdownRenderer,
  normalizePath: (path) => (path ?? "").replace(/\\/g, "/"),
  requestUrl: jest.fn(async () => {
    throw new Error("requestUrl not mocked");
  }),
};
