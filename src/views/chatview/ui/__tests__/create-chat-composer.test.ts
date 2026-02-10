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

  it("creates the expected core elements", () => {
    const root = document.createElement("div");
    const onSend = jest.fn();
    const composer = createChatComposer(root, {
      onEditSystemPrompt: jest.fn(),
      onAddContextFile: jest.fn(),
      onSend,
      onStop: jest.fn(),
      registerDomEvent: (el, type, cb) => el.addEventListener(type as any, cb as any),
      onKeyDown: jest.fn(),
      onInput: jest.fn(),
      onPaste: jest.fn(),
      handleMicClick: jest.fn(),
      hasProLicense: () => true,
    });

    expect(composer.input.tagName).toBe("TEXTAREA");
    expect(composer.sendButton.buttonEl.tagName).toBe("BUTTON");
    expect(composer.stopButton.buttonEl.tagName).toBe("BUTTON");
    expect(composer.attachButton.buttonEl.tagName).toBe("BUTTON");
    expect(composer.settingsButton.buttonEl.tagName).toBe("BUTTON");
    expect(composer.micButton.buttonEl.tagName).toBe("BUTTON");

    // Send button starts disabled until the host enables it.
    expect(composer.sendButton.buttonEl.disabled).toBe(true);
  });

  it("toggles has-value class as input changes", () => {
    const root = document.createElement("div");
    const onInput = jest.fn();

    const composer = createChatComposer(root, {
      onEditSystemPrompt: jest.fn(),
      onAddContextFile: jest.fn(),
      onSend: jest.fn(),
      onStop: jest.fn(),
      registerDomEvent: (el, type, cb) => el.addEventListener(type as any, cb as any),
      onKeyDown: jest.fn(),
      onInput,
      onPaste: jest.fn(),
      handleMicClick: jest.fn(),
      hasProLicense: () => true,
    });

    expect(composer.inputWrap.classList.contains("has-value")).toBe(false);

    composer.input.value = "hello";
    composer.input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect(onInput).toHaveBeenCalled();
    expect(composer.inputWrap.classList.contains("has-value")).toBe(true);

    composer.input.value = "";
    composer.input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect(composer.inputWrap.classList.contains("has-value")).toBe(false);
  });

  it("invokes button callbacks", () => {
    const root = document.createElement("div");
    const onAddContextFile = jest.fn();
    const onEditSystemPrompt = jest.fn();
    const onSend = jest.fn();
    const onStop = jest.fn();
    const handleMicClick = jest.fn();

    const composer = createChatComposer(root, {
      onEditSystemPrompt,
      onAddContextFile,
      onSend,
      onStop,
      registerDomEvent: (el, type, cb) => el.addEventListener(type as any, cb as any),
      onKeyDown: jest.fn(),
      onInput: jest.fn(),
      onPaste: jest.fn(),
      handleMicClick,
      hasProLicense: () => true,
    });

    composer.attachButton.buttonEl.click();
    expect(onAddContextFile).toHaveBeenCalled();

    composer.settingsButton.buttonEl.click();
    expect(onEditSystemPrompt).toHaveBeenCalled();

    composer.sendButton.setDisabled(false);
    composer.sendButton.buttonEl.click();
    expect(onSend).toHaveBeenCalled();

    composer.stopButton.buttonEl.click();
    expect(onStop).toHaveBeenCalled();

    composer.micButton.buttonEl.click();
    expect(handleMicClick).toHaveBeenCalled();
  });
});
