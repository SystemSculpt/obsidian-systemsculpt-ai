import { ensureObsidianDomCompat } from "./domCompat";

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
  svg.classList.add("svg-icon");

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
  public nameEl: HTMLDivElement;
  public controlEl: HTMLDivElement;

  constructor(container: HTMLElement) {
    super();
    this.settingEl = container.createDiv({ cls: "setting-item" });
    this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setName(text: string): this {
    this.nameEl.textContent = text;
    return this;
  }

  addText(callback: (component: TextComponent) => void): this {
    const component = new TextComponent(this.controlEl);
    callback(component);
    return this;
  }

  addButton(callback: (component: ButtonComponent) => void): this {
    const component = new ButtonComponent(this.controlEl);
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

export class TFile {
  public path: string;
  public basename: string;
  public extension: string;

  constructor(path: string) {
    this.path = path;
    const fileName = path.split("/").pop() ?? path;
    const lastDot = fileName.lastIndexOf(".");
    this.basename = lastDot === -1 ? fileName : fileName.slice(0, lastDot);
    this.extension = lastDot === -1 ? "" : fileName.slice(lastDot + 1);
  }
}

export class App {
  [key: string]: unknown;

  constructor(init?: Record<string, unknown>) {
    if (init) {
      Object.assign(this, init);
    }
  }
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export const Platform = {
  isDesktop: true,
  isMacOS: true,
  isMobile: false,
};

export const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+/g, "/");

export const setIcon = (el: HTMLElement, icon: string): void => {
  appendSvg(el, icon);
};
