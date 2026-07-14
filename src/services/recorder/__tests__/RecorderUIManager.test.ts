/**
 * @jest-environment jsdom
 */

jest.mock("../../../modals/RecorderAdvancedModal", () => ({
  openRecorderAdvancedModal: jest.fn(),
}));

import { RecorderUIManager } from "../RecorderUIManager";
import { JSDOM } from "jsdom";

function installDomHelpers(targetWindow: Window): void {
  const prototype = targetWindow.HTMLElement.prototype as typeof HTMLElement.prototype & {
    createDiv?: (options?: unknown) => HTMLDivElement;
    createSpan?: (options?: unknown) => HTMLSpanElement;
    createEl?: (tag: string, options?: unknown) => HTMLElement;
    setAttrs?: (attributes: Record<string, unknown>) => HTMLElement;
    setCssStyles?: (styles: Record<string, string>) => HTMLElement;
  };
  const applyAttributes = (element: HTMLElement, attributes?: Record<string, unknown>): void => {
    Object.entries(attributes ?? {}).forEach(([name, value]) => {
      if (value !== null && value !== undefined && value !== false) {
        element.setAttribute(name, value === true ? "" : String(value));
      }
    });
  };
  prototype.createEl = function (tag: string, options?: unknown): HTMLElement {
    const normalized = typeof options === "string" ? { cls: options } : (options ?? {}) as {
      cls?: string;
      text?: string;
      attr?: Record<string, unknown>;
    };
    const element = this.ownerDocument.createElement(tag);
    if (normalized.cls) {
      element.classList.add(...normalized.cls.split(/\s+/).filter(Boolean));
    }
    if (normalized.text !== undefined) {
      element.textContent = normalized.text;
    }
    applyAttributes(element, normalized.attr);
    this.appendChild(element);
    return element;
  };
  prototype.createDiv = function (options?: unknown): HTMLDivElement {
    return this.createEl!("div", options) as HTMLDivElement;
  };
  prototype.createSpan = function (options?: unknown): HTMLSpanElement {
    return this.createEl!("span", options) as HTMLSpanElement;
  };
  prototype.setAttrs = function (attributes: Record<string, unknown>): HTMLElement {
    applyAttributes(this, attributes);
    return this;
  };
  prototype.setCssStyles = function (styles: Record<string, string>): HTMLElement {
    Object.assign(this.style, styles);
    return this;
  };
}

const stopButtons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll("button[data-action-id='stop']")) as HTMLButtonElement[];

// The most recently rendered Stop button. open() leaves the previous shell in
// the DOM for a short teardown delay, so the newest button is always last.
const latestStopButton = (): HTMLButtonElement => {
  const buttons = stopButtons();
  return buttons[buttons.length - 1];
};

const createManager = (): RecorderUIManager =>
  new RecorderUIManager({
    app: {} as any,
    plugin: {} as any,
  });

describe("RecorderUIManager one-tap stop (#148)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("ends the recording on a single tap of Stop", () => {
    const onStop = jest.fn();
    const ui = createManager();
    ui.open(onStop);

    const button = latestStopButton();
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);

    button.click();

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated taps so 5 mashed taps still trigger exactly one stop (#148)", () => {
    const onStop = jest.fn();
    const ui = createManager();
    ui.open(onStop);

    // The reported bug: the first tap looked like it did nothing, so the user
    // tapped Stop five times. Hold the original (enabled) button reference to
    // mimic taps that land before the UI repaints the button as disabled. Each
    // tap must be a no-op after the first, which relies on the idempotency
    // guard, not just the disabled attribute.
    const button = latestStopButton();
    for (let i = 0; i < 5; i++) {
      button.click();
    }

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables and relabels Stop after the first tap", () => {
    const onStop = jest.fn();
    const ui = createManager();
    ui.open(onStop);

    latestStopButton().click();

    const button = latestStopButton();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Stopping");
  });

  it("resets to one-tap stop for the next recording", () => {
    const ui = createManager();

    const firstStop = jest.fn();
    ui.open(firstStop);
    latestStopButton().click();
    expect(firstStop).toHaveBeenCalledTimes(1);

    const secondStop = jest.fn();
    ui.open(secondStop);

    const button = latestStopButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Stop");

    button.click();

    expect(secondStop).toHaveBeenCalledTimes(1);
    expect(firstStop).toHaveBeenCalledTimes(1);
  });

  it("keeps shell, timers, visualization, and theme reads in the initiating popout", async () => {
    const popout = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://systemsculpt.local/recorder-popout",
      pretendToBeVisual: true,
    });
    installDomHelpers(popout.window as unknown as Window);

    const canvasContext = {
      fillStyle: "",
      fillRect: jest.fn(),
      createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    };
    Object.defineProperty(popout.window.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: jest.fn(() => canvasContext),
    });

    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 2,
      getByteFrequencyData: jest.fn(),
    };
    const audioContext = {
      createAnalyser: jest.fn(() => analyser),
      createMediaStreamSource: jest.fn(() => ({ connect: jest.fn() })),
      close: jest.fn(() => Promise.resolve()),
    };
    const AudioContextConstructor = jest.fn(() => audioContext);
    Object.defineProperty(popout.window, "AudioContext", {
      configurable: true,
      value: AudioContextConstructor,
    });

    let nextAnimationId = 0;
    const popoutRequestAnimationFrame = jest
      .spyOn(popout.window, "requestAnimationFrame")
      .mockImplementation(() => ++nextAnimationId);
    const popoutCancelAnimationFrame = jest
      .spyOn(popout.window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const popoutSetInterval = jest
      .spyOn(popout.window, "setInterval")
      .mockReturnValue(41);
    const popoutClearInterval = jest
      .spyOn(popout.window, "clearInterval")
      .mockImplementation(() => undefined);
    const popoutSetTimeout = jest
      .spyOn(popout.window, "setTimeout")
      .mockReturnValue(51);
    const popoutClearTimeout = jest
      .spyOn(popout.window, "clearTimeout")
      .mockImplementation(() => undefined);
    const popoutGetComputedStyle = jest
      .spyOn(popout.window, "getComputedStyle")
      .mockReturnValue({
        getPropertyValue: (property: string) => `popout:${property}`,
      } as CSSStyleDeclaration);
    const mainRequestAnimationFrame = jest.spyOn(window, "requestAnimationFrame");
    const mainSetInterval = jest.spyOn(window, "setInterval");
    const mainGetComputedStyle = jest.spyOn(window, "getComputedStyle");
    const activeDocumentDescriptor = Object.getOwnPropertyDescriptor(window, "activeDocument");
    Object.defineProperty(window, "activeDocument", {
      configurable: true,
      value: popout.window.document,
    });

    const ui = createManager();
    try {
      const hostContext = ui.open(jest.fn());
      ui.startTimer();
      await ui.attachStream({} as MediaStream);
      ui.closeAfter(250);

      const shell = popout.window.document.querySelector<HTMLElement>(".ss-recorder-hover");
      expect(hostContext.host).toBe(popout.window.document.body);
      expect(hostContext.hostDocument).toBe(popout.window.document);
      expect(hostContext.hostWindow).toBe(popout.window);
      expect(shell?.ownerDocument).toBe(popout.window.document);
      expect(document.querySelector(".ss-recorder-hover")).toBeNull();
      expect(popoutRequestAnimationFrame).toHaveBeenCalled();
      expect(popoutSetInterval).toHaveBeenCalledWith(expect.any(Function), 1000);
      expect(popoutSetTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
      expect(popoutGetComputedStyle).toHaveBeenCalledWith(popout.window.document.body);
      expect(AudioContextConstructor).toHaveBeenCalledTimes(1);
      expect(mainRequestAnimationFrame).not.toHaveBeenCalled();
      expect(mainSetInterval).not.toHaveBeenCalled();
      expect(mainGetComputedStyle).not.toHaveBeenCalled();

      ui.close();
      expect(popoutClearInterval).toHaveBeenCalledWith(41);
      expect(popoutClearTimeout).toHaveBeenCalledWith(51);
      expect(popoutCancelAnimationFrame).toHaveBeenCalledWith(nextAnimationId);
      expect(audioContext.close).toHaveBeenCalledTimes(1);
    } finally {
      ui.close();
      if (activeDocumentDescriptor) {
        Object.defineProperty(window, "activeDocument", activeDocumentDescriptor);
      } else {
        delete (window as Window & { activeDocument?: Document }).activeDocument;
      }
      popout.window.close();
    }
  });
});
