/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { disposeMobileHostLayoutStates } from "../../../platform/mobileHostLayout";
import {
  RecorderUIManager,
  type RecorderUiActions,
  type RecorderUiModel,
} from "../RecorderUIManager";

function installDomHelpers(targetWindow: Window): void {
  const prototype = targetWindow.HTMLElement.prototype as typeof HTMLElement.prototype & {
    createDiv?: (options?: unknown) => HTMLDivElement;
    createSpan?: (options?: unknown) => HTMLSpanElement;
    createEl?: (tag: string, options?: unknown) => HTMLElement;
    setAttrs?: (attributes: Record<string, unknown>) => HTMLElement;
    setAttr?: (name: string, value: unknown) => HTMLElement;
    setCssStyles?: (styles: Record<string, string>) => HTMLElement;
    setText?: (text: string) => HTMLElement;
    toggleClass?: (className: string, value: boolean) => void;
    instanceOf?: (constructor: typeof Element) => boolean;
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
    if (normalized.text !== undefined) element.textContent = normalized.text;
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
  prototype.setAttr = function (name: string, value: unknown): HTMLElement {
    this.setAttribute(name, String(value));
    return this;
  };
  prototype.setCssStyles = function (styles: Record<string, string>): HTMLElement {
    Object.assign(this.style, styles);
    return this;
  };
  prototype.setText = function (text: string): HTMLElement {
    this.textContent = text;
    return this;
  };
  prototype.toggleClass = function (className: string, value: boolean): void {
    this.classList.toggle(className, value);
  };
  prototype.instanceOf = function (constructor: typeof Element): boolean {
    return this instanceof constructor;
  };
}

function createActions(): jest.Mocked<RecorderUiActions> {
  return {
    onStop: jest.fn(),
    onClose: jest.fn(),
    onTranscribe: jest.fn(),
    onRetry: jest.fn(),
    onRetrySave: jest.fn(),
    onCancelTranscription: jest.fn(),
    onOpenOutput: jest.fn(),
    onOpenSettings: jest.fn(),
  };
}

function createManager(host?: HTMLElement): RecorderUIManager {
  return new RecorderUIManager({
    app: {} as never,
    plugin: {} as never,
    host,
  });
}

function latestRoot(owner: ParentNode = document): HTMLElement {
  const roots = owner.querySelectorAll<HTMLElement>(".ss-recorder-hover");
  const root = roots.item(roots.length - 1);
  if (!root) throw new Error("Expected recorder UI");
  return root;
}

function action(root: HTMLElement, id: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`button[data-action-id='${id}']`);
  if (!button) throw new Error(`Expected recorder action: ${id}`);
  return button;
}

function actionIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-action-id]"))
    .map((button) => button.dataset.actionId ?? "");
}

describe("RecorderUIManager state-driven contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.classList.remove("is-mobile", "ss-mobile-layout");
    localStorage.clear();
  });

  afterEach(() => {
    disposeMobileHostLayoutStates();
    jest.restoreAllMocks();
  });

  it("is a non-modal transient region that leaves the Obsidian surface interactive", () => {
    const editor = document.body.createDiv({ cls: "workspace-editor" });
    const ui = createManager();
    ui.open(createActions(), {
      phase: "starting",
      status: "Waiting for microphone access…",
    });
    const root = latestRoot();

    expect(root.getAttribute("role")).toBe("region");
    expect(root.getAttribute("aria-modal")).toBeNull();
    expect(root.getAttribute("data-ss-surface")).toBe("transient");
    expect(document.querySelector(".modal-bg, .modal-container")).toBeNull();
    expect(editor.isConnected).toBe(true);
    expect(actionIds(root)).toEqual(["stop"]);
    expect(action(root, "stop").textContent).toContain("Cancel");
  });

  it("shows actions that match each lifecycle phase", () => {
    const actions = createActions();
    const ui = createManager();
    ui.open(actions, { phase: "starting", status: "Starting" });
    const root = latestRoot();

    ui.render({
      phase: "recording",
      status: "Recording with Phone microphone",
      startedAt: Date.now(),
      microphoneLabel: "Phone microphone",
    });
    expect(actionIds(root)).toEqual(["stop"]);
    expect(action(root, "stop").textContent).toContain("Stop recording");
    action(root, "stop").click();
    expect(actions.onStop).toHaveBeenCalledTimes(1);

    ui.render({ phase: "saving", status: "Saving recording…" });
    expect(actionIds(root)).toEqual([]);

    ui.render({
      phase: "saved",
      status: "Recording was interrupted. The captured audio is saved.",
      durationMs: 8_000,
      sourcePath: "SystemSculpt/Recordings/mobile.m4a",
    });
    expect(actionIds(root)).toEqual(["close", "transcribe"]);
    action(root, "transcribe").click();
    expect(actions.onTranscribe).toHaveBeenCalledTimes(1);

    ui.render({
      phase: "transcribing",
      status: "Uploading saved audio…",
      durationMs: 8_000,
      progress: 42,
    });
    expect(actionIds(root)).toEqual(["hide", "cancel-transcription"]);
    expect(action(root, "cancel-transcription").textContent).toContain("Stop waiting");
    expect(action(root, "cancel-transcription").textContent).not.toContain("Cancel upload");
    expect(root.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("42");

    ui.render({
      phase: "complete",
      status: "Transcript saved.",
      outputPath: "SystemSculpt/Transcriptions/mobile.md",
    });
    expect(actionIds(root)).toEqual(["close", "open-output"]);
    action(root, "open-output").click();
    expect(actions.onOpenOutput).toHaveBeenCalledTimes(1);
  });

  it("offers recovery without pretending an interrupted recording was lost", () => {
    const actions = createActions();
    const ui = createManager();
    ui.open(actions, {
      phase: "warning",
      status: "Audio saved. Transcription failed: Network unavailable",
      durationMs: 12_000,
      sourcePath: "SystemSculpt/Recordings/recover.m4a",
      canRetry: true,
    });
    const root = latestRoot();

    expect(root.querySelector(".ss-recorder-hover__phase")?.textContent).toBe("Needs attention");
    expect(root.querySelector(".ss-hover-shell__status")?.textContent).toContain("Audio saved");
    expect(actionIds(root)).toEqual(["settings", "retry"]);
    action(root, "retry").click();
    expect(actions.onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps a saved-with-warning transcript actionable instead of showing failure recovery", () => {
    const actions = createActions();
    const ui = createManager();
    ui.open(actions, {
      phase: "warning",
      status: "Transcript saved, but the origin note changed.",
      outputPath: "SystemSculpt/Transcriptions/recovered.md",
    });
    const root = latestRoot();

    expect(actionIds(root)).toEqual(["close", "open-output"]);
    expect(actionIds(root)).not.toContain("settings");
    action(root, "open-output").click();
    expect(actions.onOpenOutput).toHaveBeenCalledTimes(1);
  });

  it("keeps unsaved audio in a dedicated Retry save flow", () => {
    const actions = createActions();
    const ui = createManager();
    ui.open(actions, {
      phase: "warning",
      status: "Audio is still in memory because it could not be saved. Retry save before closing Obsidian.",
      durationMs: 12_000,
      sourcePath: "SystemSculpt/Recordings/recover.m4a",
      canRetrySave: true,
    });
    const root = latestRoot();

    expect(actionIds(root)).toEqual(["hide", "retry-save"]);
    expect(action(root, "retry-save").textContent).toContain("Retry save");
    expect(action(root, "retry-save").textContent).not.toContain("transcription");
    action(root, "retry-save").click();
    expect(actions.onRetrySave).toHaveBeenCalledTimes(1);
  });

  it("keeps one stable owner-window timer across recording status rerenders", () => {
    let tick: (() => void) | null = null;
    const setInterval = jest.spyOn(window, "setInterval").mockImplementation((handler) => {
      tick = handler as () => void;
      return 73;
    });
    const clearInterval = jest.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const now = jest.spyOn(Date, "now").mockReturnValue(61_000);
    const ui = createManager();
    ui.open(createActions(), {
      phase: "recording",
      status: "Recording",
      startedAt: 1_000,
    });
    const root = latestRoot();

    expect(root.querySelector("time")?.textContent).toBe("01:00");
    ui.render({
      phase: "recording",
      status: "Recording with Phone microphone",
      startedAt: 60_000,
    });
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(root.querySelector("time")?.textContent).toBe("01:00");

    now.mockReturnValue(62_000);
    if (!tick) throw new Error("Expected timer callback");
    (tick as () => void)();
    expect(root.querySelector("time")?.textContent).toBe("01:01");

    ui.render({ phase: "saving", status: "Saving", durationMs: 61_000 });
    expect(clearInterval).toHaveBeenCalledWith(73);
    expect(root.querySelector("time")?.textContent).toBe("01:01");
  });

  it("keeps layout, timers, and delayed close in the initiating mobile window without an audio visualizer loop", async () => {
    const popout = new JSDOM("<!doctype html><html><body class='is-mobile'></body></html>", {
      url: "https://systemsculpt.local/mobile-recorder",
      pretendToBeVisual: true,
    });
    installDomHelpers(popout.window as unknown as Window);
    Object.defineProperty(popout.window, "innerWidth", { configurable: true, value: 390 });

    let animationId = 0;
    const requestAnimationFrame = jest.spyOn(popout.window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        animationId += 1;
        return animationId;
      });
    let tick: (() => void) | null = null;
    const setInterval = jest.spyOn(popout.window, "setInterval").mockImplementation((handler) => {
      tick = handler as () => void;
      return 41;
    });
    const clearInterval = jest.spyOn(popout.window, "clearInterval").mockImplementation(() => undefined);
    const setTimeout = jest.spyOn(popout.window, "setTimeout").mockReturnValue(51);
    const clearTimeout = jest.spyOn(popout.window, "clearTimeout").mockImplementation(() => undefined);
    const audioContext = jest.fn();
    Object.defineProperty(popout.window, "AudioContext", {
      configurable: true,
      value: audioContext,
    });
    const mainSetInterval = jest.spyOn(window, "setInterval");
    const ui = createManager(popout.window.document.body);

    try {
      const context = ui.open(createActions(), {
        phase: "recording",
        status: "Recording with Phone microphone",
        startedAt: Date.now(),
      });
      await Promise.resolve();
      const root = latestRoot(popout.window.document);

      expect(context.hostDocument).toBe(popout.window.document);
      expect(context.hostWindow).toBe(popout.window);
      expect(root.dataset.layout).toBe("compact");
      expect(root.style.bottom).toBe("var(--ss-mobile-bottom-clearance)");
      expect(root.style.left).toContain("safe-area-inset-left");
      expect(root.style.right).toContain("safe-area-inset-right");
      expect(root.querySelector("canvas")).toBeNull();
      expect(audioContext).not.toHaveBeenCalled();
      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(mainSetInterval).not.toHaveBeenCalled();

      const layoutFrameCount = requestAnimationFrame.mock.calls.length;
      if (!tick) throw new Error("Expected timer callback");
      (tick as () => void)();
      expect(requestAnimationFrame).toHaveBeenCalledTimes(layoutFrameCount);

      ui.closeAfter(250);
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
      ui.close();
      expect(clearInterval).toHaveBeenCalledWith(41);
      expect(clearTimeout).toHaveBeenCalledWith(51);
    } finally {
      ui.close();
      disposeMobileHostLayoutStates();
      popout.window.close();
    }
  });

  it("pins the mobile card above host chrome and provides coarse-pointer targets", () => {
    const css = readFileSync("src/css/components/recorder.css", "utf8");
    const shellCss = readFileSync("src/css/components/hover-shell.css", "utf8");
    const tokensCss = readFileSync("src/css/foundation/tokens.css", "utf8");

    expect(tokensCss).toMatch(/--ss-z-floating-workflow:\s*40;/);
    expect(css).toMatch(
      /\.ss-recorder-hover\s*\{[^}]*z-index:\s*var\(--ss-z-floating-workflow\);/s,
    );
    expect(css).toMatch(
      /\.ss-mobile-layout \.ss-recorder-hover\s*\{[^}]*right:\s*max\([^;]*safe-area-inset-right[^;]*;[^}]*bottom:\s*var\(--ss-mobile-bottom-clearance\);[^}]*left:\s*max\([^;]*safe-area-inset-left/s,
    );
    expect(css).toMatch(
      /@media \(pointer:\s*coarse\)\s*\{[\s\S]*\.ss-recorder-hover \.ss-hover-shell__action\s*\{[^}]*min-height:\s*44px;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*transition:\s*none;/,
    );
    expect(shellCss).toMatch(
      /\.ss-mobile-layout \.ss-hover-shell\s*\{[^}]*max-height:\s*calc\([^}]*100dvh[^}]*--ss-mobile-bottom-clearance[^}]*safe-area-inset-top/s,
    );
    expect(shellCss).toMatch(
      /\.ss-mobile-layout \.ss-hover-shell__content\s*\{[^}]*min-height:\s*0;[^}]*max-height:\s*none;/s,
    );
  });
});
