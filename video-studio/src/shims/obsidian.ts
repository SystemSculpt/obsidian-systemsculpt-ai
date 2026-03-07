import { ensureObsidianDomCompat } from "./domCompat";
import { marked } from "marked";

ensureObsidianDomCompat();

const SVG_NS = "http://www.w3.org/2000/svg";

type IconShape = {
  viewBox?: string;
  paths?: string[];
  circles?: Array<{ cx: number; cy: number; r: number }>;
  rects?: Array<{ x: number; y: number; width: number; height: number; rx?: number }>;
};

const iconShapes: Record<string, IconShape> = {
  paperclip: { paths: ["M8.5 12.5 14 7a3 3 0 1 1 4.2 4.3l-7.1 7.1a5 5 0 1 1-7.1-7.1l7.4-7.4"] },
  settings: {
    paths: [
      "M12 7.5A4.5 4.5 0 1 0 12 16.5A4.5 4.5 0 1 0 12 7.5Z",
      "M19 12h2",
      "M3 12h2",
      "M12 3v2",
      "M12 19v2",
      "m17 7 1.5-1.5",
      "M5.5 18.5 7 17",
      "M17 17 18.5 18.5",
      "M5.5 5.5 7 7",
    ],
  },
  mic: {
    rects: [{ x: 9, y: 4, width: 6, height: 10, rx: 3 }],
    paths: ["M6 11a6 6 0 0 0 12 0", "M12 17v3"],
  },
  video: {
    rects: [{ x: 3, y: 7, width: 13, height: 10, rx: 2 }],
    paths: ["m16 11 5-3v8l-5-3Z"],
  },
  square: {
    rects: [{ x: 6, y: 6, width: 12, height: 12, rx: 2 }],
  },
  send: { paths: ["m3 12 17-8-4 16-4-6-9-2Z"] },
  file: { paths: ["M8 3h7l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M15 3v5h5"] },
  "file-text": {
    paths: ["M8 3h7l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M15 3v5h5", "M10 12h6", "M10 16h6"],
  },
  image: {
    rects: [{ x: 3, y: 5, width: 18, height: 14, rx: 2 }],
    circles: [{ cx: 9, cy: 10, r: 1.5 }],
    paths: ["m21 16-4.5-4.5L8 20"],
  },
  headphones: {
    paths: ["M4 12a8 8 0 0 1 16 0"],
    rects: [
      { x: 4, y: 12, width: 4, height: 7, rx: 2 },
      { x: 16, y: 12, width: 4, height: 7, rx: 2 },
    ],
  },
  "file-x": {
    paths: ["M8 3h7l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M15 3v5h5", "m10 12 6 6", "m16 12-6 6"],
  },
  search: { circles: [{ cx: 11, cy: 11, r: 6 }], paths: ["m20 20-3.5-3.5"] },
  brain: {
    paths: [
      "M9 5a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6 3 3 0 0 0 3 3",
      "M15 5a3 3 0 0 1 3 3v1a3 3 0 0 1 0 6 3 3 0 0 1-3 3",
      "M9 5a3 3 0 0 1 6 0v14a3 3 0 0 1-6 0Z",
    ],
  },
  wrench: { paths: ["M14 6a4 4 0 0 0 4 4l-8 8a2 2 0 1 1-2.8-2.8l8-8a4 4 0 0 0 4-4"] },
  "chevron-down": { paths: ["m6 9 6 6 6-6"] },
  "chevron-left": { paths: ["m15 6-6 6 6 6"] },
  "chevron-right": { paths: ["m9 6 6 6-6 6"] },
  bot: {
    rects: [{ x: 5, y: 7, width: 14, height: 11, rx: 3 }],
    paths: ["M12 3v4", "M9 12h.01", "M15 12h.01", "M8 18v2", "M16 18v2"],
  },
  bolt: { paths: ["M13 2 6 13h5l-1 9 8-12h-5V2Z"] },
  note: {
    paths: ["M7 3h10a2 2 0 0 1 2 2v14l-4-3H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M9 8h6", "M9 12h4"],
  },
  "git-fork": {
    circles: [
      { cx: 6, cy: 5, r: 2 },
      { cx: 18, cy: 19, r: 2 },
      { cx: 6, cy: 19, r: 2 },
    ],
    paths: ["M8 5h4a4 4 0 0 1 4 4v8", "M6 7v10"],
  },
  sparkles: {
    paths: [
      "m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z",
      "m18.5 3 .6 1.5 1.4.6-1.4.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z",
    ],
  },
  check: { paths: ["m5 12 4 4L19 6"] },
  clock: { circles: [{ cx: 12, cy: 12, r: 8 }], paths: ["M12 8v5l3 2"] },
  copy: {
    rects: [
      { x: 9, y: 9, width: 10, height: 11, rx: 2 },
      { x: 5, y: 4, width: 10, height: 11, rx: 2 },
    ],
  },
  "folder-search": {
    paths: ["M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"],
    circles: [{ cx: 14.5, cy: 14.5, r: 2.5 }],
    rects: [],
  },
  x: { paths: ["m18 6-12 12", "m6 6 12 12"] },
  "loader-2": {
    paths: ["M12 2a10 10 0 0 1 10 10", "M20 12a8 8 0 0 1-8 8", "M12 20a8 8 0 0 1-8-8"],
  },
  coins: {
    circles: [{ cx: 12, cy: 8, r: 4 }, { cx: 12, cy: 16, r: 4 }],
    paths: ["M8 8h8", "M8 16h8"],
  },
  "alert-triangle": {
    paths: ["M12 3 2.2 19h19.6L12 3Z", "M12 9v4", "M12 17h.01"],
  },
  bug: {
    circles: [{ cx: 12, cy: 8, r: 2 }],
    paths: [
      "M8 11a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0v-5Z",
      "M4 13h4",
      "M16 13h4",
      "M5 9l3 2",
      "M19 9l-3 2",
      "M6 18l3-2",
      "M18 18l-3-2",
    ],
  },
  history: {
    paths: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 8v5l3 2"],
  },
  star: {
    paths: ["m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.7 6.6 20.8l1-6.1L3.2 9.4l6.1-.9L12 3Z"],
  },
  "star-off": {
    paths: [
      "m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.7 6.6 20.8l1-6.1L3.2 9.4l6.1-.9L12 3Z",
      "M4 4l16 16",
    ],
  },
  "more-horizontal": {
    circles: [
      { cx: 6, cy: 12, r: 1.5 },
      { cx: 12, cy: 12, r: 1.5 },
      { cx: 18, cy: 12, r: 1.5 },
    ],
  },
  "refresh-ccw": {
    paths: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"],
  },
  "refresh-cw": {
    paths: ["M21 12a9 9 0 1 1-3-6.7", "M21 4v5h-5"],
  },
  "corner-down-left": {
    paths: ["M20 10v4a4 4 0 0 1-4 4H8", "m12 14-4 4-4-4"],
  },
  "help-circle": {
    circles: [{ cx: 12, cy: 12, r: 9 }],
    paths: ["M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 5", "M12 17h.01"],
  },
  "maximize-2": {
    paths: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  },
  "plug-zap": {
    paths: [
      "M8 3v6",
      "M16 3v6",
      "M6 9h12v2a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9Z",
      "m12 14-2 4h3l-1 3",
    ],
  },
  info: { circles: [{ cx: 12, cy: 12, r: 9 }], paths: ["M12 10v6", "M12 7h.01"] },
  loader: {
    paths: ["M12 2a10 10 0 0 1 10 10", "M20 12a8 8 0 0 1-8 8", "M12 20a8 8 0 0 1-8-8"],
  },
  play: {
    paths: ["M8 5v14l11-7Z"],
  },
  list: {
    paths: ["M9 6h11", "M9 12h11", "M9 18h11"],
    circles: [{ cx: 5, cy: 6, r: 1 }, { cx: 5, cy: 12, r: 1 }, { cx: 5, cy: 18, r: 1 }],
  },
  cpu: {
    rects: [{ x: 7, y: 7, width: 10, height: 10, rx: 2 }],
    paths: [
      "M9 1v3",
      "M15 1v3",
      "M9 20v3",
      "M15 20v3",
      "M20 9h3",
      "M20 14h3",
      "M1 9h3",
      "M1 14h3",
    ],
  },
  box: {
    paths: ["M12 2 4 6v12l8 4 8-4V6l-8-4Z", "M4 6l8 4 8-4", "M12 10v12"],
  },
  tag: {
    paths: ["M20 10 11 19 3 11V3h8l9 7Z"],
    circles: [{ cx: 7.5, cy: 7.5, r: 1.2 }],
  },
  files: {
    rects: [
      { x: 7, y: 6, width: 10, height: 13, rx: 2 },
      { x: 4, y: 3, width: 10, height: 13, rx: 2 },
    ],
  },
  "check-circle": {
    circles: [{ cx: 12, cy: 12, r: 9 }],
    paths: ["m8.5 12.5 2.5 2.5 5-6"],
  },
  "alert-circle": {
    circles: [{ cx: 12, cy: 12, r: 9 }],
    paths: ["M12 8v5", "M12 16h.01"],
  },
  trophy: {
    paths: [
      "M8 4h8v3a4 4 0 0 1-8 0V4Z",
      "M8 5H5a2 2 0 0 0 0 4h3",
      "M16 5h3a2 2 0 0 1 0 4h-3",
      "M12 11v4",
      "M9 20h6",
      "M10 15h4",
    ],
  },
  "flask-conical": {
    paths: ["M10 3v5l-6 10a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3L14 8V3", "M8 14h8"],
  },
  clipboard: {
    rects: [{ x: 7, y: 5, width: 10, height: 14, rx: 2 }],
    paths: ["M9 5h6", "M10 3h4"],
  },
  "external-link": {
    paths: ["M14 5h5v5", "M10 14 19 5", "M19 13v5H5V5h5"],
  },
};

const appendSvg = (target: HTMLElement, name: string) => {
  target.innerHTML = "";
  const shape = iconShapes[name] ?? iconShapes.file;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", shape.viewBox ?? "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.classList.add("svg-icon");
  svg.style.width = "16px";
  svg.style.height = "16px";
  svg.style.flexShrink = "0";

  for (const rectSpec of shape.rects ?? []) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(rectSpec.x));
    rect.setAttribute("y", String(rectSpec.y));
    rect.setAttribute("width", String(rectSpec.width));
    rect.setAttribute("height", String(rectSpec.height));
    if (rectSpec.rx !== undefined) {
      rect.setAttribute("rx", String(rectSpec.rx));
    }
    svg.appendChild(rect);
  }

  for (const circleSpec of shape.circles ?? []) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(circleSpec.cx));
    circle.setAttribute("cy", String(circleSpec.cy));
    circle.setAttribute("r", String(circleSpec.r));
    svg.appendChild(circle);
  }

  for (const pathSpec of shape.paths ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathSpec);
    svg.appendChild(path);
  }

  target.appendChild(svg);
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderInternalLinks = (markdown: string): string =>
  markdown
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, href: string, label: string) => {
      return `<a class="internal-link" href="${escapeHtml(href.trim())}">${escapeHtml(
        label.trim()
      )}</a>`;
    })
    .replace(/\[\[([^\]]+)\]\]/g, (_match, href: string) => {
      const normalizedHref = href.trim();
      const defaultLabel = normalizedHref.split("/").pop() ?? normalizedHref;
      return `<a class="internal-link" href="${escapeHtml(normalizedHref)}">${escapeHtml(
        defaultLabel
      )}</a>`;
    });

export class Component {
  private cleanups: Array<() => void> = [];
  private children: Component[] = [];

  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    return child;
  }

  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K | string,
    callback: (evt: HTMLElementEventMap[K]) => void
  ): void {
    el.addEventListener(type as string, callback as EventListener);
    this.register(() => {
      el.removeEventListener(type as string, callback as EventListener);
    });
  }

  unload(): void {
    for (const child of [...this.children].reverse()) {
      child.unload?.();
    }
    this.children = [];
    for (const cleanup of [...this.cleanups].reverse()) {
      cleanup();
    }
    this.cleanups = [];
  }
}

export class MarkdownRenderer {
  static async render(
    _app: any,
    markdown: string,
    container: HTMLElement,
    _sourcePath: string,
    _component: Component
  ): Promise<void> {
    marked.setOptions({
      gfm: true,
      breaks: true,
    });
    container.innerHTML = marked.parse(renderInternalLinks(markdown)) as string;
  }
}

export class ButtonComponent extends Component {
  public buttonEl: HTMLButtonElement;

  constructor(container: HTMLElement) {
    super();
    this.buttonEl = document.createElement("button");
    this.buttonEl.type = "button";
    container.appendChild(this.buttonEl);
  }

  setIcon(name: string): this {
    setIcon(this.buttonEl, name);
    return this;
  }

  setTooltip(text: string): this {
    this.buttonEl.title = text;
    return this;
  }

  setClass(cls: string): this {
    this.buttonEl.classList.add(cls);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  onClick(callback: () => void): this {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }

  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }

  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }

  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
}

class TextComponent extends Component {
  public inputEl: HTMLInputElement;

  constructor(container: HTMLElement) {
    super();
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    container.appendChild(this.inputEl);
  }

  setPlaceholder(text: string): this {
    this.inputEl.placeholder = text;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.inputEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }
}

class DropdownComponent extends Component {
  public selectEl: HTMLSelectElement;

  constructor(container: HTMLElement) {
    super();
    this.selectEl = document.createElement("select");
    container.appendChild(this.selectEl);
  }

  addOption(value: string, label: string): this {
    this.selectEl.createEl("option", { value, text: label });
    return this;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.selectEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
    return this;
  }
}

class ToggleComponent extends Component {
  public toggleEl: HTMLInputElement;

  constructor(container: HTMLElement) {
    super();
    const wrapper = container.createEl("label", { cls: "checkbox-container" });
    this.toggleEl = wrapper.createEl("input", { type: "checkbox" });
    wrapper.createSpan({ cls: "checkbox-slider" });
  }

  setValue(value: boolean): this {
    this.toggleEl.checked = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.toggleEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: boolean) => void): this {
    this.toggleEl.addEventListener("change", () => callback(this.toggleEl.checked));
    return this;
  }
}

export class TextAreaComponent extends Component {
  public inputEl: HTMLTextAreaElement;

  constructor(container: HTMLElement) {
    super();
    this.inputEl = document.createElement("textarea");
    container.appendChild(this.inputEl);
  }

  setPlaceholder(text: string): this {
    this.inputEl.placeholder = text;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }
}

export class SearchComponent extends Component {
  public containerEl: HTMLDivElement;
  public inputEl: HTMLInputElement;

  constructor(container: HTMLElement) {
    super();
    this.containerEl = container.createDiv({ cls: "search-input-container" });
    const iconEl = this.containerEl.createSpan({ cls: "search-input-icon" });
    setIcon(iconEl, "search");
    this.inputEl = this.containerEl.createEl("input", {
      cls: "search-input",
      type: "search",
    }) as HTMLInputElement;
  }

  setPlaceholder(text: string): this {
    this.inputEl.placeholder = text;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  clear(): this {
    this.inputEl.value = "";
    return this;
  }
}

export class Setting extends Component {
  public settingEl: HTMLDivElement;
  public infoEl: HTMLDivElement;
  public nameEl: HTMLDivElement;
  public descEl: HTMLDivElement;
  public controlEl: HTMLDivElement;

  constructor(container: HTMLElement) {
    super();
    this.settingEl = container.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setName(text: string): this {
    this.nameEl.textContent = text;
    return this;
  }

  setDesc(text: string): this {
    this.descEl.textContent = text;
    return this;
  }

  addText(callback: (component: TextComponent) => void): this {
    const component = new TextComponent(this.controlEl);
    callback(component);
    return this;
  }

  addDropdown(callback: (component: DropdownComponent) => void): this {
    const component = new DropdownComponent(this.controlEl);
    callback(component);
    return this;
  }

  addToggle(callback: (component: ToggleComponent) => void): this {
    const component = new ToggleComponent(this.controlEl);
    callback(component);
    return this;
  }

  addButton(callback: (component: ButtonComponent) => void): this {
    const component = new ButtonComponent(this.controlEl);
    callback(component);
    return this;
  }

  addExtraButton(callback: (component: ButtonComponent) => void): this {
    const component = new ButtonComponent(this.controlEl);
    component.buttonEl.classList.add("clickable-icon");
    callback(component);
    return this;
  }
}

export class Modal extends Component {
  public app: any;
  public modalEl: HTMLDivElement;
  public titleEl: HTMLDivElement;
  public contentEl: HTMLDivElement;

  constructor(app: any) {
    super();
    this.app = app;
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "modal-title";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(this.titleEl, this.contentEl);
  }

  open(): void {
    if (typeof (this as any).onOpen === "function") {
      (this as any).onOpen();
    }
  }

  close(): void {
    if (typeof (this as any).onClose === "function") {
      (this as any).onClose();
    }
  }
}

export class ItemView extends Component {
  public app: any;
  public leaf: WorkspaceLeaf;
  public containerEl: HTMLDivElement;
  public contentEl: HTMLDivElement;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.app = (leaf as any).app;
    this.leaf = leaf;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    this.containerEl.createDiv({ cls: "view-header" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
    this.leaf.view = this;
  }
}

export class TAbstractFile {
  public path: string;

  constructor(path: string) {
    this.path = path;
  }
}

export class TFolder extends TAbstractFile {}

export class TFile extends TAbstractFile {
  public basename: string;
  public extension: string;
  public stat: { mtime: number; size: number };

  constructor(
    input: string | { path: string; stat?: { mtime?: number; size?: number } },
    stat?: { mtime?: number; size?: number }
  ) {
    const path = typeof input === "string" ? input : input.path;
    const resolvedStat = typeof input === "string" ? stat : input.stat;
    super(path);
    const fileName = path.split("/").pop() ?? path;
    const lastDot = fileName.lastIndexOf(".");
    this.basename = lastDot === -1 ? fileName : fileName.slice(0, lastDot);
    this.extension = lastDot === -1 ? "" : fileName.slice(lastDot + 1);
    this.stat = {
      mtime: resolvedStat?.mtime ?? Date.now(),
      size: resolvedStat?.size ?? 0,
    };
  }
}

export class WorkspaceLeaf {
  public view: any = null;
  public app: any;
  private viewState: { type: string; state: Record<string, unknown> } = {
    type: "",
    state: {},
  };

  constructor(app?: any) {
    this.app = app;
  }

  getViewState(): { type: string; state: Record<string, unknown> } {
    return this.viewState;
  }

  async setViewState(
    viewState: { type: string; state?: Record<string, unknown> },
    _opts?: unknown
  ): Promise<void> {
    this.viewState = {
      type: viewState.type,
      state: viewState.state ?? {},
    };
  }

  async openFile(_file: TFile): Promise<void> {}
}

export type EventRef = { id?: string };

export class App {
  [key: string]: unknown;

  constructor(init?: Record<string, unknown>) {
    const defaultLeaf = new WorkspaceLeaf(this);
    const defaultWorkspace = {
      activeLeaf: defaultLeaf,
      trigger: () => {},
      openLinkText: () => {},
      on: () => ({ id: "workspace-event" }),
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => new WorkspaceLeaf(this),
      setActiveLeaf: () => {},
    };
    const defaultVault = {
      getFiles: () => [] as TFile[],
      getAbstractFileByPath: () => null as TAbstractFile | null,
      on: () => ({ id: "vault-event" }),
      offref: (_eventRef: EventRef) => {},
      read: async () => "",
      adapter: {
        read: async () => "",
        list: async () => ({ files: [] as string[], folders: [] as string[] }),
      },
    };

    Object.assign(this, {
      workspace: defaultWorkspace,
      vault: defaultVault,
      plugins: {
        plugins: {},
      },
    });
    Object.assign(this, init);
  }
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMacOS: true,
  isMobile: false,
};

export const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+/g, "/");

export const setIcon = (el: HTMLElement, icon: string): void => {
  appendSvg(el, icon);
};

export const debounce = <TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  wait: number,
  immediate = false
): ((...args: TArgs) => void) => {
  let timeoutId: number | null = null;

  return (...args: TArgs) => {
    const shouldCallNow = immediate && timeoutId === null;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      if (!immediate) {
        callback(...args);
      }
    }, wait);

    if (shouldCallNow) {
      callback(...args);
    }
  };
};
