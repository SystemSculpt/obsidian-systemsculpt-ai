/**
 * @jest-environment jsdom
 */
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

  it("keeps the mobile node menu visible in a scrolled viewport without opening the keyboard", async () => {
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

    overlay.destroy();
  });

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
