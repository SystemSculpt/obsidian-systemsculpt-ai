/** @jest-environment jsdom */

import {
  STUDIO_TERMINAL_FONT_FAMILY,
  buildStudioTerminalXtermOptions,
  mountStudioTerminalNode,
} from "../StudioTerminalNodeRenderer";
import * as studioTerminalXtermModule from "../terminal/StudioTerminalXterm";
import { resolveStudioTerminalShortcutInput } from "../terminal/StudioTerminalXterm";

jest.mock("../terminal/StudioTerminalXterm", () => {
  const actual = jest.requireActual("../terminal/StudioTerminalXterm");
  return {
    ...actual,
    loadXtermRuntime: jest.fn(),
  };
});

describe("buildStudioTerminalXtermOptions", () => {
  it("keeps first-line prompt glyphs stable across user shell themes", () => {
    const options = buildStudioTerminalXtermOptions(4_000);
    expect(options?.customGlyphs).toBe(true);
    expect(options?.rescaleOverlappingGlyphs).toBe(true);
    expect(options?.fontFamily).toBe(STUDIO_TERMINAL_FONT_FAMILY);
    expect(String(options?.fontFamily || "")).toContain("Symbols Nerd Font Mono");
    expect(String(options?.fontFamily || "")).toContain("MesloLGS NF");
  });

  it("preserves studio terminal visual defaults", () => {
    const options = buildStudioTerminalXtermOptions(1_234);
    expect(options?.scrollback).toBe(1_234);
    expect(options?.cursorBlink).toBe(false);
    expect(options?.fontSize).toBe(12);
    expect(options?.theme?.background).toBe("#06120d");
    expect(options?.theme?.foreground).toBe("#d7fce8");
  });
});

describe("resolveStudioTerminalShortcutInput", () => {
  it("maps Cmd+Backspace on macOS to line-kill control input", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      "MacIntel"
    );
    expect(translated).toBe("\u0015");
  });

  it("maps Cmd+Delete on macOS to line-kill control input", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Delete",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      "MacIntel"
    );
    expect(translated).toBe("\u0015");
  });

  it("does not map non-mac platforms", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      "Linux x86_64"
    );
    expect(translated).toBeNull();
  });

  it("does not remap option delete behavior", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        isComposing: false,
      },
      "MacIntel"
    );
    expect(translated).toBeNull();
  });
});

describe("mountStudioTerminalNode in-node integration", () => {
  const realResizeObserver = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

  class TestResizeObserver {
    constructor(private readonly _callback: ResizeObserverCallback) {}
    observe(): void {}
    disconnect(): void {}
  }

  type DomEl = HTMLElement & {
    createDiv: (options?: { cls?: string; text?: string; attr?: Record<string, string> }) => DomEl;
    createEl: (tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }) => DomEl;
    setText: (text: string) => void;
  };

  function decorateElement<T extends HTMLElement>(element: T): DomEl {
    const target = element as DomEl;
    target.setText = (text: string): void => {
      target.textContent = text;
    };
    target.createDiv = (options): DomEl => {
      const child = decorateElement(document.createElement("div"));
      if (options?.cls) {
        child.className = options.cls;
      }
      if (options?.text) {
        child.textContent = options.text;
      }
      if (options?.attr) {
        for (const [key, value] of Object.entries(options.attr)) {
          child.setAttribute(key, value);
        }
      }
      target.appendChild(child);
      return child;
    };
    target.createEl = (tag, options): DomEl => {
      const child = decorateElement(document.createElement(tag));
      if (options?.cls) {
        child.className = options.cls;
      }
      if (options?.text) {
        child.textContent = options.text;
      }
      if (options?.attr) {
        for (const [key, value] of Object.entries(options.attr)) {
          child.setAttribute(key, value);
        }
      }
      target.appendChild(child);
      return child;
    };
    return target;
  }

  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    (
      studioTerminalXtermModule.loadXtermRuntime as jest.MockedFunction<
        typeof studioTerminalXtermModule.loadXtermRuntime
      >
    ).mockReset();
    (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = TestResizeObserver as unknown as
      typeof ResizeObserver;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (realResizeObserver) {
      (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = realResizeObserver;
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
  });

  it("creates terminal in node surface and disposes cleanly", async () => {
    const fitMock = jest.fn();
    const proposeDimensionsMock = jest.fn(() => ({ cols: 144, rows: 52 }));
    const disposeDataMock = jest.fn();
    const terminalOpenMock = jest.fn();
    const terminalDisposeMock = jest.fn();
    const focusMock = jest.fn();

    class MockFitAddon {
      fit = fitMock;
      proposeDimensions = proposeDimensionsMock;
    }

    class MockTerminal {
      loadAddon(_addon: unknown): void {}
      open = terminalOpenMock;
      attachCustomKeyEventHandler(_handler: (event: KeyboardEvent) => boolean): void {}
      onData(_listener: (value: string) => void): { dispose: () => void } {
        return { dispose: disposeDataMock };
      }
      focus = focusMock;
      reset(): void {}
      write(_value: string): void {}
      dispose = terminalDisposeMock;
    }

    (
      studioTerminalXtermModule.loadXtermRuntime as jest.MockedFunction<
        typeof studioTerminalXtermModule.loadXtermRuntime
      >
    ).mockResolvedValue({
      TerminalCtor: MockTerminal as unknown as typeof import("@xterm/xterm").Terminal,
      FitAddonCtor: MockFitAddon as unknown as typeof import("@xterm/addon-fit").FitAddon,
    });

    const resizeSessionMock = jest.fn();
    const ensureSessionMock = jest.fn(async () => ({
      status: "idle",
      history: "",
      historyRevision: 0,
      errorMessage: "",
    }));

    const nodeEl = decorateElement(document.createElement("div"));
    document.body.appendChild(nodeEl);

    const dispose = mountStudioTerminalNode({
      node: {
        id: "terminal_node",
        kind: "studio.terminal",
        position: { x: 0, y: 0 },
        config: {},
      } as any,
      nodeEl,
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      interactionLocked: false,
      ensureSession: ensureSessionMock,
      restartSession: ensureSessionMock,
      stopSession: async () => undefined,
      clearSessionHistory: () => undefined,
      writeInput: () => undefined,
      resizeSession: resizeSessionMock,
      peekSession: async () => null,
      subscribe: () => () => undefined,
      getSnapshot: () => null,
      getSidecarStatus: () => null,
      subscribeSidecarStatus: () => () => undefined,
      refreshSidecarStatus: async () => null,
      onNodeConfigMutated: () => undefined,
      onNodeGeometryMutated: () => undefined,
      getGraphZoom: () => 1,
      subscribeToGraphZoomChanges: () => () => undefined,
    });

    await flushMicrotasks();
    jest.advanceTimersByTime(350);
    await flushMicrotasks();

    expect(terminalOpenMock).toHaveBeenCalledTimes(1);
    expect(ensureSessionMock).toHaveBeenCalled();
    expect(nodeEl.querySelector(".ss-studio-terminal-panel")).toBeTruthy();

    dispose();
    expect(nodeEl.querySelector(".ss-studio-terminal-panel")).toBeNull();
    expect(disposeDataMock).toHaveBeenCalledTimes(1);
    expect(terminalDisposeMock).toHaveBeenCalledTimes(1);
  });
});
