import { JSDOM } from "jsdom";
import { renderStudioSearchableDropdown } from "../StudioSearchableDropdown";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
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
    const list = host.querySelector(".ss-studio-searchable-select-list") as HTMLElement;

    setRect(root, { top: 120, left: 32, width: 260, height: 32 });
    setRect(panel, { top: 0, left: 0, width: 260, height: 240 });
    setRect(list, { top: 0, left: 0, width: 244, height: 160 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 240 });

    trigger.click();
    await flush();

    expect(root.classList.contains("is-open-upward")).toBe(false);
    expect(panel.style.top).toBe("calc(100% + 4px)");
    expect(panel.style.bottom).toBe("auto");
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

    trigger.click();
    await flush();

    expect(root.classList.contains("is-open-upward")).toBe(true);
    expect(panel.style.top).toBe("auto");
    expect(panel.style.bottom).toBe("calc(100% + 4px)");
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

    trigger.click();
    await flush();

    expect(root.classList.contains("is-open-upward")).toBe(true);
    expect(panel.style.maxHeight).toBe("200px");
    expect(list.style.maxHeight).toBe("80px");
  });
});
