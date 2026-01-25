import { JSDOM } from "jsdom";
import { createChatComposer } from "../createInputUI";

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
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }
};

ensureDomHelpers();

describe("createChatComposer", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("hides web search button when not allowed", () => {
    const root = document.createElement("div");
    const composer = createChatComposer(root, {
      onEditSystemPrompt: jest.fn(),
      onAddContextFile: jest.fn(),
      isWebSearchAllowed: () => false,
      getWebSearchEnabled: () => false,
      toggleWebSearchEnabled: jest.fn(),
      updateWebSearchButtonState: jest.fn(),
      onSend: jest.fn(),
      onStop: jest.fn(),
      registerDomEvent: (el, type, cb) => el.addEventListener(type as any, cb as any),
      onKeyDown: jest.fn(),
      onInput: jest.fn(),
      onPaste: jest.fn(),
      handleMicClick: jest.fn(),
      hasProLicense: () => true,
    });

    expect(composer.webSearchButton.buttonEl.style.display).toBe("none");
  });

  it("toggles web search and updates state on click", () => {
    const root = document.createElement("div");
    const toggleWebSearchEnabled = jest.fn();
    const updateWebSearchButtonState = jest.fn();

    const composer = createChatComposer(root, {
      onEditSystemPrompt: jest.fn(),
      onAddContextFile: jest.fn(),
      isWebSearchAllowed: () => true,
      getWebSearchEnabled: () => true,
      toggleWebSearchEnabled,
      updateWebSearchButtonState,
      onSend: jest.fn(),
      onStop: jest.fn(),
      registerDomEvent: (el, type, cb) => el.addEventListener(type as any, cb as any),
      onKeyDown: jest.fn(),
      onInput: jest.fn(),
      onPaste: jest.fn(),
      handleMicClick: jest.fn(),
      hasProLicense: () => true,
    });

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    composer.webSearchButton.buttonEl.click();

    expect(toggleWebSearchEnabled).toHaveBeenCalled();
    expect(updateWebSearchButtonState).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
