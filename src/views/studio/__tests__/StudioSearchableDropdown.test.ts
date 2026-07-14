import { JSDOM } from "jsdom";
import { renderStudioSearchableDropdown } from "../StudioSearchableDropdown";
import type { StudioNodeConfigSelectOption } from "../../../studio/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = (targetWindow: Window = (global as any).window) => {
  const proto = (targetWindow as any).HTMLElement?.prototype;
  if (!proto) return;
  if (!proto.addClass) {
    proto.addClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        });
      return this;
    };
  }
  if (!proto.removeClass) {
    proto.removeClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.remove(c));
        });
      return this;
    };
  }
  if (!proto.setCssStyles) {
    proto.setCssStyles = function (styles: Record<string, string>) {
      Object.assign(this.style, styles);
      return this;
    };
  }
  if (!proto.setText) {
    proto.setText = function (text: string) {
      this.textContent = text ?? "";
      return this;
    };
  }
  if (!proto.setAttr) {
    proto.setAttr = function (name: string, value: any) {
      if (value === null || value === undefined || value === false) {
        this.removeAttribute(name);
      } else if (value === true) {
        this.setAttribute(name, "");
      } else {
        this.setAttribute(name, `${value}`);
      }
      return this;
    };
  }
  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const el = (this.ownerDocument ?? document).createElement(tag);
      if (options?.cls) {
        `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
      }
      if (options?.text !== undefined) {
        el.textContent = `${options.text}`;
      }
      if (options?.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          (el as any).setAttr?.(key, value as any);
        });
      }
      if (options?.type) {
        (el as HTMLInputElement).type = `${options.type}`;
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }
  if (!proto.createSpan) {
    proto.createSpan = function (options?: any) {
      return this.createEl("span", options);
    };
  }
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
      return this;
    };
  }
};

ensureDomHelpers();

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const setViewportSize = (width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
};

const setRect = (
  el: Element,
  rect: { top: number; left: number; width: number; height: number },
) => {
  const fullRect = {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  };
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => fullRect,
  });
};

describe("renderStudioSearchableDropdown", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setViewportSize(1200, 900);
  });

  it("opens downward when there is enough space below the trigger", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: async () => [
        { value: "model-a", label: "Model A" },
        { value: "model-b", label: "Model B" },
      ],
      onValueChange: jest.fn(),
    });

    await flush();

    const root = host.querySelector(".ss-studio-searchable-select") as HTMLElement;
    const trigger = host.querySelector(".ss-studio-searchable-select-trigger") as HTMLButtonElement;
    const panel = host.querySelector(".ss-studio-searchable-select-panel") as HTMLElement;
    expect(panel.getAttribute("data-ss-surface")).toBe("transient");
    const list = host.querySelector(".ss-studio-searchable-select-list") as HTMLElement;

    setRect(root, { top: 120, left: 32, width: 260, height: 32 });
    setRect(panel, { top: 0, left: 0, width: 260, height: 240 });
    setRect(list, { top: 0, left: 0, width: 244, height: 160 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 160 });

    trigger.click();
    await flush();

    expect(root.classList.contains("is-open-upward")).toBe(false);
    expect(panel.style.top).toBe("calc(100% + 4px)");
    expect(panel.style.bottom).toBe("auto");
  });

  it("binds viewport behavior and active-option semantics to the host popout", async () => {
    const popout = new JSDOM("<!doctype html><html><body></body></html>");
    ensureDomHelpers(popout.window as unknown as Window);
    Object.defineProperty(popout.window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(popout.window, "innerHeight", {
      configurable: true,
      value: 700,
    });
    const host = popout.window.document.createElement("div");
    popout.window.document.body.appendChild(host);
    const popoutAddListener = jest.spyOn(popout.window, "addEventListener");
    const mainAddListener = jest.spyOn(window, "addEventListener");

    const dropdown = renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: async () => [
        { value: "model-a", label: "Model A" },
        { value: "model-b", label: "Model B" },
      ],
      onValueChange: jest.fn(),
    });

    const trigger = host.querySelector<HTMLButtonElement>(
      ".ss-studio-searchable-select-trigger"
    );
    trigger?.click();
    await flush();

    const search = host.querySelector<HTMLInputElement>(
      ".ss-studio-searchable-select-search"
    );
    const list = host.querySelector<HTMLElement>(
      ".ss-studio-searchable-select-list"
    );
    const activeOption = host.querySelector<HTMLElement>(
      ".ss-studio-searchable-select-item.is-active"
    );
    expect(popoutAddListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(mainAddListener).not.toHaveBeenCalledWith("resize", expect.any(Function));
    expect(trigger?.getAttribute("aria-controls")).toBe(list?.id);
    expect(search?.getAttribute("aria-controls")).toBe(list?.id);
    expect(activeOption?.id).toBeTruthy();
    expect(search?.getAttribute("aria-activedescendant")).toBe(activeOption?.id);
    expect(activeOption?.ownerDocument).toBe(popout.window.document);

    popoutAddListener.mockRestore();
    mainAddListener.mockRestore();
    dropdown.destroy();
    popout.window.close();
  });

  it("opens upward when there is not enough space below the trigger", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: async () => [
        { value: "model-a", label: "Model A" },
        { value: "model-b", label: "Model B" },
      ],
      onValueChange: jest.fn(),
    });

    await flush();

    const root = host.querySelector(".ss-studio-searchable-select") as HTMLElement;
    const trigger = host.querySelector(".ss-studio-searchable-select-trigger") as HTMLButtonElement;
    const panel = host.querySelector(".ss-studio-searchable-select-panel") as HTMLElement;
    const list = host.querySelector(".ss-studio-searchable-select-list") as HTMLElement;

    setViewportSize(1200, 760);
    setRect(root, { top: 648, left: 32, width: 260, height: 32 });
    setRect(panel, { top: 0, left: 0, width: 260, height: 240 });
    setRect(list, { top: 0, left: 0, width: 244, height: 160 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 160 });

    trigger.click();
    await flush();

    expect(root.classList.contains("is-open-upward")).toBe(true);
    expect(panel.style.top).toBe("auto");
    expect(panel.style.bottom).toBe("calc(100% + 4px)");
  });

  it("keeps the list usable when positioned during the async loading state", async () => {
    // Regression: the first positioning pass runs while the list still shows
    // the empty "Loading options..." state. The old math derived the panel
    // chrome from that empty measurement and wrote a near-zero list
    // max-height that every later re-measure inherited - the dropdown
    // opened a few pixels tall with no visible options.
    const host = document.createElement("div");
    document.body.appendChild(host);

    let releaseOptions: (() => void) | null = null;
    renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: () =>
        new Promise((resolve) => {
          releaseOptions = () =>
            resolve([
              { value: "model-a", label: "Model A" },
              { value: "model-b", label: "Model B" },
              { value: "model-c", label: "Model C" },
            ]);
        }),
      onValueChange: jest.fn(),
    });
    await flush();

    const trigger = host.querySelector(".ss-studio-searchable-select-trigger") as HTMLButtonElement;
    const list = host.querySelector(".ss-studio-searchable-select-list") as HTMLElement;

    trigger.click();
    await flush();
    releaseOptions?.();
    await flush();

    const listMaxHeight = Number.parseInt(list.style.maxHeight || "0", 10);
    expect(listMaxHeight).toBeGreaterThanOrEqual(72);
  });

  it("does not refocus or render a dropdown closed while options load", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let releaseOptions: (() => void) | null = null;
    const pendingOptions = new Promise<StudioNodeConfigSelectOption[]>((resolve) => {
      releaseOptions = () => resolve([{ value: "model-a", label: "Model A" }]);
    });

    renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: () => pendingOptions,
      onValueChange: jest.fn(),
    });

    const trigger = host.querySelector<HTMLButtonElement>(
      ".ss-studio-searchable-select-trigger"
    );
    const search = host.querySelector<HTMLInputElement>(
      ".ss-studio-searchable-select-search"
    );
    const panel = host.querySelector<HTMLElement>(
      ".ss-studio-searchable-select-panel"
    );
    const focusSpy = jest.spyOn(search!, "focus");

    trigger?.click();
    trigger?.click();
    releaseOptions?.();
    await flush();

    expect(panel?.style.display).toBe("none");
    expect(focusSpy).not.toHaveBeenCalled();
    expect(host.querySelector(".ss-studio-searchable-select-item")).toBeNull();
  });

  it("caps panel height to the available viewport space", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: async () => [
        { value: "model-a", label: "Model A" },
        { value: "model-b", label: "Model B" },
        { value: "model-c", label: "Model C" },
      ],
      onValueChange: jest.fn(),
    });

    await flush();

    const root = host.querySelector(".ss-studio-searchable-select") as HTMLElement;
    const trigger = host.querySelector(".ss-studio-searchable-select-trigger") as HTMLButtonElement;
    const panel = host.querySelector(".ss-studio-searchable-select-panel") as HTMLElement;
    const list = host.querySelector(".ss-studio-searchable-select-list") as HTMLElement;

    setViewportSize(1200, 360);
    setRect(root, { top: 216, left: 32, width: 260, height: 32 });
    setRect(panel, { top: 0, left: 0, width: 260, height: 240 });
    setRect(list, { top: 0, left: 0, width: 244, height: 160 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 160 });

    trigger.click();
    await flush();

    expect(root.classList.contains("is-open-upward")).toBe(true);
    expect(panel.style.maxHeight).toBe("200px");
    expect(list.style.maxHeight).toBe("120px");
  });

  it("uses canonical Home/End/Enter/Escape behavior without changing Studio markup", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onValueChange = jest.fn();

    renderStudioSearchableDropdown({
      containerEl: host,
      ariaLabel: "Model",
      value: "model-a",
      disabled: false,
      loadOptions: async () => [
        { value: "model-a", label: "Model A" },
        { value: "model-b", label: "Model B" },
        { value: "model-c", label: "Model C" },
      ],
      onValueChange,
    });

    const trigger = host.querySelector<HTMLButtonElement>(
      ".ss-studio-searchable-select-trigger"
    )!;
    const panel = host.querySelector<HTMLElement>(
      ".ss-studio-searchable-select-panel"
    )!;
    const search = host.querySelector<HTMLInputElement>(
      ".ss-studio-searchable-select-search"
    )!;

    trigger.click();
    await flush();
    expect(search.getAttribute("role")).toBe("combobox");
    expect(search.getAttribute("aria-expanded")).toBe("true");

    search.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    }));
    const active = host.querySelector<HTMLElement>(
      ".ss-studio-searchable-select-item.is-active"
    );
    expect(active?.textContent).toContain("Model C");
    expect(search.getAttribute("aria-activedescendant")).toBe(active?.id);

    search.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }));
    expect(onValueChange).toHaveBeenCalledWith("model-c");
    expect(panel.style.display).toBe("none");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    await flush();
    search.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    expect(panel.style.display).toBe("none");
    expect(document.activeElement).toBe(trigger);
  });
});
