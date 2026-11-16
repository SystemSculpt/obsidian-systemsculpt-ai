/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudioNodeDefinition } from "../../../studio/types";
import { disposeMobileHostLayoutStates } from "../../../platform/mobileHostLayout";
import { StudioNodeContextMenuOverlay } from "../StudioNodeContextMenuOverlay";
import { StudioSimpleContextMenuOverlay } from "../StudioSimpleContextMenuOverlay";

function definition(kind: string): StudioNodeDefinition {
  return {
    kind,
    version: "1.0.0",
    capabilityClass: "local_io",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: [],
    requiredHostCapabilities: [],
    configDefaults: {},
    configSchema: { fields: [], allowUnknownKeys: true },
    async execute() {
      return { outputs: {} };
    },
  };
}

describe("Studio context menu accessibility", () => {
  beforeEach(() => {
    document.body.empty();
    document.body.removeClass("is-mobile");
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  afterEach(() => {
    disposeMobileHostLayoutStates();
  });

  it.each(["simple", "node"] as const)("releases pending focus and owner-window listeners on %s menu destruction", kind => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const ownerDocument = frame.contentDocument!;
    const ownerWindow = frame.contentWindow as Window & typeof globalThis;
    // Obsidian patches every window's Element/HTMLElement prototypes; mirror the host mock in the pop-out.
    for (const [source, target] of [[Element.prototype, ownerWindow.Element.prototype], [HTMLElement.prototype, ownerWindow.HTMLElement.prototype]]) {
      for (const key of Object.getOwnPropertyNames(source)) {
        if (!(key in target)) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)!);
      }
    }
    const viewport = document.createElement("div");
    ownerDocument.body.appendChild(viewport);
    const observe = jest.fn(), disconnect = jest.fn();
    Object.defineProperty(ownerWindow, "ResizeObserver", {
      configurable: true, value: class { observe = observe; disconnect = disconnect; },
    });
    const visualViewport = new ownerWindow.EventTarget();
    Object.defineProperty(ownerWindow, "visualViewport", { configurable: true, value: visualViewport });
    const visualAdd = jest.spyOn(visualViewport, "addEventListener");
    const visualRemove = jest.spyOn(visualViewport, "removeEventListener");
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    const raf = jest.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation(callback => { frames.set(++next, callback); return next; });
    const caf = jest.spyOn(ownerWindow, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const add = jest.spyOn(ownerWindow, "addEventListener");
    const remove = jest.spyOn(ownerWindow, "removeEventListener");
    const overlay = kind === "simple" ? new StudioSimpleContextMenuOverlay() : new StudioNodeContextMenuOverlay();
    overlay.mount(viewport);
    const open = () => {
      if (overlay instanceof StudioSimpleContextMenuOverlay) overlay.open({ anchorX: 0, anchorY: 0, items: [{ id: "run", title: "Run", onSelect: jest.fn() }] });
      else overlay.open({ anchorX: 0, anchorY: 0, items: [], onSelectDefinition: jest.fn() });
    };
    open();
    open();
    expect(frames.size).toBe(1);
    overlay.destroy();
    expect(frames.size).toBe(0);
    for (const [type, listener, capture] of add.mock.calls.filter(([type, , capture]) => capture === true && ["pointerdown", "keydown", "contextmenu"].includes(type))) {
      expect(remove).toHaveBeenCalledWith(type, listener, capture);
    }
    for (const [, listener] of add.mock.calls.filter(([type]) => type === "resize")) {
      expect(remove).toHaveBeenCalledWith("resize", listener);
    }
    for (const [, listener] of visualAdd.mock.calls) {
      expect(visualRemove).toHaveBeenCalledWith("resize", listener);
    }
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(viewport);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(viewport.children.length).toBe(0);
    raf.mockRestore(); caf.mockRestore(); add.mockRestore(); remove.mockRestore();
    visualAdd.mockRestore(); visualRemove.mockRestore();
  });

  it.each(["window", "visualViewport", "pane", "pane-before-initial"] as const)("relayouts a focused node popup on %s resize without losing its query", target => {
    const originalObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const viewportHeight = jest.replaceProperty(window, "innerHeight", 844);
    const callbacks: Array<() => void> = [];
    const disconnect = jest.fn();
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: () => void) { callbacks.push(callback); }
        observe = jest.fn();
        disconnect = disconnect;
      },
    });
    const visualViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    const workspace = document.body.createDiv();
    const controls = workspace.createDiv({ cls: "ss-studio-graph-workspace-controls" });
    const viewport = workspace.createDiv();
    let bottom = 812;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 322 },
      clientHeight: { configurable: true, get: () => bottom - 90 },
      scrollTop: { configurable: true, value: 500 },
      getBoundingClientRect: { configurable: true, value: () => ({ top: 90, bottom }) },
    });
    Object.defineProperty(controls, "getBoundingClientRect", {
      configurable: true, value: () => ({ bottom: 207 }),
    });
    viewport.createDiv({ cls: "ss-studio-graph-canvas" }).style.transform = "scale(0.83)";
    const overlay = new StudioNodeContextMenuOverlay();
    const hide = jest.spyOn(overlay, "hide");
    try {
      overlay.mount(viewport);
      overlay.open({
        anchorX: 200, anchorY: 900,
        items: [
          { definition: definition("studio.alpha"), title: "Alpha", summary: "First node" },
          { definition: definition("studio.beta"), title: "Beta", summary: "Second node" },
        ],
        onSelectDefinition: jest.fn(),
      });
      const root = viewport.querySelector<HTMLElement>(".ss-studio-node-context-menu")!;
      const search = root.querySelector<HTMLInputElement>("input")!;
      search.value = "alpha";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.focus();
      expect(root.style.maxHeight).toBe("589px");
      expect(root.parentElement).toBe(viewport);
      expect(root.style.width).toBe("306px");
      // Initial and unchanged ResizeObserver deliveries must leave the menu open.
      if (target !== "pane-before-initial") { callbacks[0](); callbacks[0](); }
      expect(root.getAttribute("aria-hidden")).toBe("false");
      expect(hide).not.toHaveBeenCalled();

      if (target === "visualViewport") {
        // Opening the on-screen keyboard changes only the visual viewport.
        visualViewport.offsetTop = 100;
        visualViewport.height = 400;
      } else {
        bottom = 500;
      }
      if (target.startsWith("pane")) callbacks[0]();
      else (target === "window" ? window : visualViewport).dispatchEvent(new Event("resize"));
      expect(root.getAttribute("aria-hidden")).toBe("false");
      expect(root.hasAttribute("inert")).toBe(false);
      expect(root.style.maxHeight).toBe("277px");
      expect(document.activeElement).toBe(search);
      expect(search.value).toBe("alpha");
      expect(root.querySelectorAll('[role="option"]')).toHaveLength(1);
      expect(root.querySelector('[role="option"]')?.textContent).toContain("Alpha");
      expect(hide).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();

      // Hide releases listeners and ignores an already-queued observer callback.
      overlay.hide();
      root.style.maxHeight = "1px";
      bottom = 400;
      callbacks[0]();
      window.dispatchEvent(new Event("resize"));
      visualViewport.dispatchEvent(new Event("resize"));
      expect(root.getAttribute("aria-hidden")).toBe("true");
      expect(root.style.maxHeight).toBe("1px");
      expect(hide).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      overlay.destroy();
      viewportHeight.restore();
      if (originalObserver) Object.defineProperty(window, "ResizeObserver", originalObserver);
      else Reflect.deleteProperty(window, "ResizeObserver");
      if (originalVisualViewport) Object.defineProperty(window, "visualViewport", originalVisualViewport);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("keeps simple menus' default dismissal on window, keyboard, and pane resize", () => {
    const originalObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const callbacks: Array<() => void> = [];
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: () => void) { callbacks.push(callback); }
        observe = jest.fn();
        disconnect = jest.fn();
      },
    });
    const visualViewport = new EventTarget();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    const viewport = document.body.createDiv();
    let height = 700;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 322 },
      clientHeight: { configurable: true, get: () => height },
    });
    const overlay = new StudioSimpleContextMenuOverlay();
    try {
      overlay.mount(viewport);
      for (const target of ["window", "visualViewport", "pane"] as const) {
        overlay.open({ anchorX: 0, anchorY: 0, items: [{ id: "run", title: "Run", onSelect: jest.fn() }] });
        const root = viewport.querySelector<HTMLElement>(".ss-studio-simple-context-menu")!;
        expect(root.getAttribute("aria-hidden")).toBe("false");
        if (target === "pane") {
          height -= 100;
          callbacks.at(-1)!();
        } else {
          (target === "window" ? window : visualViewport).dispatchEvent(new Event("resize"));
        }
        expect(root.getAttribute("aria-hidden")).toBe("true");
      }
    } finally {
      overlay.destroy();
      if (originalObserver) Object.defineProperty(window, "ResizeObserver", originalObserver);
      else Reflect.deleteProperty(window, "ResizeObserver");
      if (originalVisualViewport) Object.defineProperty(window, "visualViewport", originalVisualViewport);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("exposes add-node search as a dialog with a combobox-owned listbox", () => {
    const viewport = document.body.createDiv();
    const overlay = new StudioNodeContextMenuOverlay();
    const first = definition("studio.alpha");
    const second = definition("studio.beta");
    const onSelectDefinition = jest.fn();

    overlay.mount(viewport);
    overlay.open({
      anchorX: 20,
      anchorY: 30,
      items: [
        { definition: first, title: "Alpha", summary: "First node" },
        { definition: second, title: "Beta", summary: "Second node" },
      ],
      onSelectDefinition,
    });

    const root = viewport.querySelector<HTMLElement>(".ss-studio-node-context-menu");
    const title = viewport.querySelector<HTMLElement>(".ss-studio-node-context-menu-title");
    const search = viewport.querySelector<HTMLInputElement>(".ss-studio-node-context-menu-search-input");
    const list = viewport.querySelector<HTMLElement>(".ss-studio-node-context-menu-list");
    const options = Array.from(
      viewport.querySelectorAll<HTMLElement>(".ss-studio-node-context-menu-item")
    );

    expect(root?.getAttribute("data-ss-surface")).toBe("transient");
    expect(root?.getAttribute("role")).toBe("dialog");
    expect(root?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(root?.getAttribute("aria-hidden")).toBe("false");
    expect(search?.getAttribute("role")).toBe("combobox");
    expect(search?.getAttribute("aria-expanded")).toBe("true");
    expect(search?.getAttribute("aria-controls")).toBe(list?.id);
    expect(list?.getAttribute("role")).toBe("listbox");
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("role")).toBe("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(search?.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    search?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(search?.getAttribute("aria-activedescendant")).toBe(options[1]?.id);

    search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    search?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelectDefinition).toHaveBeenCalledWith(second);
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(search?.getAttribute("aria-expanded")).toBe("false");

    overlay.destroy();
  });

  it.each([0.5, 0.83, 1, 2])("keeps the scrolled mobile picker below the toolbar without opening the keyboard at graph zoom %s", async zoom => {
    document.body.addClass("is-mobile");
    const workspace = document.body.createDiv();
    const controls = workspace.createDiv({ cls: "ss-studio-graph-workspace-controls" });
    const viewport = workspace.createDiv();
    const mobileNav = document.body.createDiv({ cls: "mobile-navbar-action" });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 700 },
      scrollTop: { configurable: true, value: 500, writable: true },
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0, y: 100, width: 400, height: 700,
        top: 100, right: 400, bottom: 800, left: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(controls, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 8, y: 108, width: 384, height: 96,
        top: 108, right: 392, bottom: 204, left: 8,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(mobileNav, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 40, y: 720, width: 320, height: 52,
        top: 720, right: 360, bottom: 772, left: 40,
        toJSON: () => ({}),
      }),
    });
    const focus = jest.spyOn(HTMLInputElement.prototype, "focus");
    viewport.createDiv({ cls: "ss-studio-graph-canvas" }).style.transform = `scale(${zoom})`;
    const overlay = new StudioNodeContextMenuOverlay();

    overlay.mount(viewport);
    overlay.open({
      anchorX: 200,
      anchorY: 900,
      items: [
        { definition: definition("studio.alpha"), title: "Alpha", summary: "First node" },
        { definition: definition("studio.beta"), title: "Beta", summary: "Second node" },
      ],
      onSelectDefinition: jest.fn(),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const root = viewport.querySelector<HTMLElement>(".ss-studio-node-context-menu");
    expect(focus).not.toHaveBeenCalled();
    expect(root?.style.top).toBe("612px");
    expect(root?.style.maxHeight).toBe("500px");

    // A narrow pane and an anchor near the toolbar must not crop the popup
    // horizontally or place its title underneath the floating controls.
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 322 });
    overlay.open({
      anchorX: 1,
      anchorY: 500,
      items: [{ definition: definition("studio.alpha"), title: "Alpha", summary: "First node" }],
      onSelectDefinition: jest.fn(),
    });
    expect(root?.style.width).toBe("306px");
    expect(root?.classList.contains("is-compact-width")).toBe(true);
    expect(root?.style.left).toBe("8px");
    expect(root?.style.top).toBe("612px");
    expect(focus).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it.each([0.5, 0.83, 1, 2])("bounds the compact desktop picker in screen pixels at graph zoom %s", zoom => {
    const viewportHeight = jest.replaceProperty(window, "innerHeight", 844);
    const workspace = document.body.createDiv();
    const controls = workspace.createDiv({ cls: "ss-studio-graph-workspace-controls" });
    const viewport = workspace.createDiv();
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 322 },
      clientHeight: { configurable: true, value: 722 },
      scrollTop: { configurable: true, value: 500, writable: true },
      getBoundingClientRect: { configurable: true, value: () => ({ top: 90, bottom: 812 }) },
    });
    Object.defineProperty(controls, "getBoundingClientRect", {
      configurable: true, value: () => ({ bottom: 207 }),
    });
    viewport.createDiv({ cls: "ss-studio-graph-canvas" }).style.transform = `scale(${zoom})`;
    const overlay = new StudioNodeContextMenuOverlay();
    overlay.mount(viewport);
    overlay.open({
      anchorX: 200,
      anchorY: 900,
      items: Array.from({ length: 30 }, (_, index) => ({
        definition: definition("studio.item" + index), title: "Node " + index, summary: "A long node description",
      })),
      onSelectDefinition: jest.fn(),
    });
    const root = viewport.querySelector<HTMLElement>(".ss-studio-node-context-menu")!;
    try {
      expect(document.body.classList.contains("is-mobile")).toBe(false);
      expect(root.classList.contains("is-compact-width")).toBe(true);
      expect(root.style.width).toBe("306px");
      expect(root.style.top).toBe("625px");
      expect(root.style.maxHeight).toBe("589px");
      // The entire border box, not just the list, must stay above the bottom edge.
      expect(Number.parseFloat(root.style.top) - viewport.scrollTop + 90
        + Number.parseFloat(root.style.maxHeight)).toBe(804);
      expect(root.querySelectorAll('[role="option"]')).toHaveLength(30);

      // Zoom changes keep the screen-pixel height budget; a narrow keyboard
      // boundary must not be overridden by the menu's 120px measurement floor.
      Object.defineProperty(viewport, "getBoundingClientRect", {
        configurable: true, value: () => ({ top: 90, bottom: 287 }),
      });
      window.dispatchEvent(new Event("resize"));
      expect(root.style.maxHeight).toBe("64px");
      expect(Number.parseFloat(root.style.top) - viewport.scrollTop + 90
        + Number.parseFloat(root.style.maxHeight)).toBe(279);

      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 900 });
      window.dispatchEvent(new Event("resize"));
      expect(root.classList.contains("is-compact-width")).toBe(false);
      expect(root.style.width).toBe("360px");
      expect(root.style.maxHeight).toBe("");
    } finally {
      overlay.destroy();
      viewportHeight.restore();
    }
  });

  it.each(["node", "simple"].flatMap(kind => [0.5, 0.83, 1, 2].map(zoom => ({ kind, zoom }))))(
    "keeps $kind menu UI unscaled and anchors in scroll-box pixels at graph zoom $zoom", ({ kind, zoom }) => {
      const viewportHeight = jest.replaceProperty(window, "innerHeight", 844);
      const viewport = document.body.createDiv();
      let paneWidth = 900;
      Object.defineProperties(viewport, {
        clientWidth: { configurable: true, get: () => paneWidth },
        clientHeight: { configurable: true, value: 700 },
        getBoundingClientRect: { configurable: true, value: () => ({ left: 180, top: 90, right: 180 + paneWidth, bottom: 790 }) },
      });
      const canvas = viewport.createDiv({ cls: "ss-studio-graph-canvas" });
      canvas.style.transform = `scale(${zoom})`;
      const className = `ss-studio-${kind === "node" ? "node" : "simple"}-context-menu`;
      // Read the owning root rule: jsdom cannot parse the later @container block.
      const style = document.createElement("style");
      const rootRule = readFileSync(resolve(__dirname, "../../../css/views/studio/menus.css"), "utf8")
        .match(new RegExp(`\\.${className} \\{[^}]*\\}`))?.[0];
      expect(rootRule).toBeDefined();
      style.textContent = rootRule!;
      document.head.appendChild(style);
      const overlay = kind === "node" ? new StudioNodeContextMenuOverlay() : new StudioSimpleContextMenuOverlay();
      try {
        overlay.mount(viewport);
        const root = viewport.querySelector<HTMLElement>(`.${className}`)!;
        const height = kind === "node" ? 400 : 80;
        Object.defineProperty(root, "offsetHeight", { configurable: true, value: height });
        const openAt = (anchorX: number, anchorY: number) => {
          if (overlay instanceof StudioNodeContextMenuOverlay) {
            overlay.open({ anchorX, anchorY,
              items: [{ definition: definition("studio.alpha"), title: "Alpha", summary: "First node" }],
              onSelectDefinition: jest.fn() });
          } else {
            overlay.open({ anchorX, anchorY, items: [{ id: "run", title: "Run", onSelect: jest.fn() }] });
          }
        };
        for (paneWidth of [900, 322]) {
          const width = kind === "node" ? Math.min(360, paneWidth - 16) : 220;
          for (const [scrollLeft, scrollTop] of [[0, 0], [340, 500]]) {
            viewport.scrollLeft = scrollLeft;
            viewport.scrollTop = scrollTop;
            // The caller converts world/client anchors once; only these pixels enter the menu.
            openAt(scrollLeft + 120 * zoom, scrollTop + 160 * zoom);
            expect(root.parentElement).toBe(viewport);
            expect(canvas.contains(root)).toBe(false);
            expect(root.style.width).toBe(`${width}px`);
            expect(getComputedStyle(root).transform || "none").toBe("none");
            expect(root.style.left).toBe(`${scrollLeft + Math.min(paneWidth - width - 8, 120 * zoom + 8)}px`);
            expect(root.style.top).toBe(`${scrollTop + Math.min(700 - height - 8, 160 * zoom + 8)}px`);

            openAt(scrollLeft + paneWidth - 5, scrollTop + 695);
            expect(root.style.left).toBe(`${scrollLeft + paneWidth - width - 8}px`);
            expect(root.style.top).toBe(`${scrollTop + 700 - height - 8}px`);
            expect(Number.parseFloat(root.style.left) - scrollLeft + width).toBe(paneWidth - 8);
            expect(Number.parseFloat(root.style.top) - scrollTop + height).toBe(692);
          }
        }
      } finally {
        overlay.destroy();
        style.remove();
        viewportHeight.restore();
      }
    }
  );

  it("uses roving focus for keyboard navigation in action menus", () => {
    const viewport = document.body.createDiv();
    const overlay = new StudioSimpleContextMenuOverlay();

    overlay.mount(viewport);
    overlay.open({
      anchorX: 20,
      anchorY: 30,
      title: "Node actions",
      items: [
        { id: "one", title: "One", onSelect: jest.fn() },
        { id: "two", title: "Two", onSelect: jest.fn() },
        { id: "three", title: "Three", onSelect: jest.fn() },
      ],
    });

    const root = viewport.querySelector<HTMLElement>(".ss-studio-simple-context-menu");
    const items = Array.from(
      viewport.querySelectorAll<HTMLButtonElement>(".ss-studio-simple-context-menu-item")
    );
    expect(root?.getAttribute("data-ss-surface")).toBe("transient");
    expect(root?.getAttribute("role")).toBe("menu");
    expect(root?.getAttribute("aria-label")).toBe("Node actions");
    expect(items.map((item) => item.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
    ]);
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1]);

    items[0]?.focus();
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items[2]);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, 0]);

    items[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(items[2]);

    overlay.destroy();
  });
});
