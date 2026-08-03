/**
 * @jest-environment jsdom
 */

import {
  AnchoredScroller,
  type AnchoredScrollerPrependAnchor,
} from "../AnchoredScroller";

type ViewportState = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

type RowLayout = {
  top: number;
  height: number;
};

type ScrollCall = {
  top: number;
  behavior: ScrollBehavior;
};

function createHarness(options: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  reducedMotion?: boolean;
} = {}) {
  const viewport = document.createElement("div");
  const content = document.createElement("div");
  const scrollButton = document.createElement("button");
  viewport.appendChild(content);
  document.body.append(viewport, scrollButton);

  const state: ViewportState = {
    scrollTop: options.scrollTop ?? 600,
    scrollHeight: options.scrollHeight ?? 1_000,
    clientHeight: options.clientHeight ?? 400,
  };
  const calls: ScrollCall[] = [];
  const rowLayouts = new Map<HTMLElement, RowLayout>();

  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => { state.scrollTop = value; },
    },
    scrollHeight: {
      configurable: true,
      get: () => state.scrollHeight,
    },
    clientHeight: {
      configurable: true,
      get: () => state.clientHeight,
    },
  });

  viewport.scrollTo = ((scrollOptions: ScrollToOptions) => {
    const top = Number(scrollOptions.top ?? state.scrollTop);
    const behavior = scrollOptions.behavior ?? "auto";
    state.scrollTop = top;
    calls.push({ top, behavior });
    viewport.dispatchEvent(new Event("scroll"));
  }) as typeof viewport.scrollTo;

  const scroller = new AnchoredScroller({
    viewport,
    content,
    scrollButton,
    reducedMotion: options.reducedMotion ?? false,
  });

  const addRow = (
    id: string,
    top: number,
    height = 100,
  ): HTMLElement => {
    const row = document.createElement("article");
    row.textContent = id;
    content.appendChild(row);
    const layout = { top, height };
    rowLayouts.set(row, layout);
    Object.defineProperties(row, {
      offsetTop: {
        configurable: true,
        get: () => rowLayouts.get(row)?.top ?? 0,
      },
      offsetHeight: {
        configurable: true,
        get: () => rowLayouts.get(row)?.height ?? 0,
      },
    });
    scroller.registerRow(id, row);
    return row;
  };

  const setRowLayout = (row: HTMLElement, layout: Partial<RowLayout>): void => {
    const current = rowLayouts.get(row);
    if (!current) throw new Error("Unknown row");
    Object.assign(current, layout);
  };

  const manualScroll = (top: number): void => {
    state.scrollTop = top;
    viewport.dispatchEvent(new Event("scroll"));
  };

  const cleanup = (): void => {
    scroller.destroy();
    viewport.remove();
    scrollButton.remove();
  };

  return {
    viewport,
    content,
    scrollButton,
    state,
    calls,
    scroller,
    addRow,
    setRowLayout,
    manualScroll,
    cleanup,
  };
}

describe("AnchoredScroller", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("installs accessible transcript semantics without replacing explicit labels", () => {
    const first = createHarness();
    expect(first.viewport.getAttribute("role")).toBe("region");
    expect(first.viewport.getAttribute("aria-label")).toBe("Messages");
    expect(first.viewport.getAttribute("tabindex")).toBe("0");
    expect(first.content.getAttribute("role")).toBe("log");
    expect(first.content.getAttribute("aria-relevant")).toBe("additions");
    first.cleanup();

    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.setAttribute("role", "feed");
    viewport.setAttribute("aria-label", "Agent transcript");
    viewport.setAttribute("tabindex", "3");
    content.setAttribute("role", "list");
    content.setAttribute("aria-relevant", "all");
    viewport.appendChild(content);
    const scroller = new AnchoredScroller({ viewport, content });
    expect(viewport.getAttribute("role")).toBe("feed");
    expect(viewport.getAttribute("aria-label")).toBe("Agent transcript");
    expect(viewport.getAttribute("tabindex")).toBe("3");
    expect(content.getAttribute("role")).toBe("list");
    expect(content.getAttribute("aria-relevant")).toBe("all");
    scroller.destroy();
  });

  it("follows streaming growth only while the reader remains at the end", () => {
    const harness = createHarness();
    expect(harness.scroller.isFollowingEnd()).toBe(true);

    harness.state.scrollHeight = 1_200;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.state.scrollTop).toBe(800);
    expect(harness.calls.at(-1)).toEqual({ top: 800, behavior: "auto" });
    expect(harness.content.getAttribute("aria-busy")).toBe("true");

    harness.manualScroll(120);
    expect(harness.scroller.getMode()).toBe("manual");
    expect(harness.scrollButton.getAttribute("data-active")).toBe("true");

    harness.state.scrollHeight = 1_400;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.state.scrollTop).toBe(120);
    expect(harness.scroller.isFollowingEnd()).toBe(false);

    harness.scroller.setStreaming(false);
    expect(harness.content.hasAttribute("aria-busy")).toBe(false);
    harness.cleanup();
  });

  it("does not yank a manual reader when a new turn starts", () => {
    const harness = createHarness({ scrollTop: 120, scrollHeight: 1_600 });
    harness.manualScroll(120);
    expect(harness.scroller.getMode()).toBe("manual");

    harness.scroller.notifyTurnStarted();
    expect(harness.scroller.getMode()).toBe("manual");
    expect(harness.state.scrollTop).toBe(120);

    harness.state.scrollHeight = 2_000;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.state.scrollTop).toBe(120);

    harness.manualScroll(1_600);
    harness.scroller.notifyTurnStarted();
    expect(harness.scroller.getMode()).toBe("end");
    expect(harness.state.scrollTop).toBe(1_600);
    harness.cleanup();
  });

  it("preserves the first visible stable row and its pixel offset when history is prepended", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    const first = harness.addRow("first", 200, 100);
    const second = harness.addRow("second", 300, 100);
    harness.addRow("third", 400, 100);
    harness.manualScroll(250);
    expect(harness.scroller.getMode()).toBe("manual");

    const anchor = harness.scroller.capturePrependAnchor();
    expect(anchor).toEqual({
      rowId: "first",
      offsetFromViewportTop: -50,
      mode: "manual",
    });

    harness.state.scrollHeight = 1_300;
    harness.setRowLayout(first, { top: 500 });
    harness.setRowLayout(second, { top: 600 });
    harness.scroller.restorePrependAnchor(anchor);

    expect(harness.state.scrollTop).toBe(550);
    expect(harness.scroller.getMode()).toBe("manual");
    expect((first.offsetTop - harness.state.scrollTop)).toBe(-50);
    harness.cleanup();
  });

  it("treats a null prepend anchor as a safe no-op", () => {
    const harness = createHarness({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
    expect(harness.scroller.capturePrependAnchor()).toBeNull();
    harness.scroller.restorePrependAnchor(null);
    expect(harness.state.scrollTop).toBe(0);
    harness.cleanup();
  });

  it.each([
    ["start", 700],
    ["center", 550],
    ["end", 400],
  ] as const)("jumps to a stable row with %s alignment", (align, expectedTop) => {
    const harness = createHarness({ scrollTop: 0, scrollHeight: 1_500, clientHeight: 400 });
    harness.addRow("target", 700, 100);
    harness.scroller.jumpTo("target", { align });
    expect(harness.state.scrollTop).toBe(expectedTop);
    expect(harness.calls.at(-1)).toEqual({ top: expectedTop, behavior: "smooth" });
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("uses auto behavior for reduced motion across turn following, jumping, and end scrolling", () => {
    const harness = createHarness({ scrollTop: 0, scrollHeight: 1_500, reducedMotion: true });
    harness.addRow("turn", 500, 100);

    harness.scroller.notifyTurnStarted();
    expect(harness.calls.at(-1)?.behavior).toBe("auto");
    harness.scroller.jumpTo("turn", { align: "center" });
    expect(harness.calls.at(-1)?.behavior).toBe("auto");
    harness.scroller.scrollToEnd();
    expect(harness.calls.at(-1)).toEqual({ top: 1_100, behavior: "auto" });
    harness.cleanup();
  });

  it("makes the scroll control inert outside useful states and restores end following on click", () => {
    const harness = createHarness({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
    expect(harness.scrollButton.hasAttribute("inert")).toBe(true);
    expect(harness.scrollButton.tabIndex).toBe(-1);
    expect(harness.scrollButton.getAttribute("data-active")).toBe("false");
    expect(harness.scrollButton.getAttribute("aria-hidden")).toBe("true");

    harness.state.scrollHeight = 1_000;
    harness.manualScroll(100);
    expect(harness.scrollButton.hasAttribute("inert")).toBe(false);
    expect(harness.scrollButton.tabIndex).toBe(0);
    expect(harness.scrollButton.getAttribute("data-active")).toBe("true");

    harness.scrollButton.click();
    expect(harness.state.scrollTop).toBe(600);
    expect(harness.scroller.getMode()).toBe("end");
    expect(harness.scrollButton.hasAttribute("inert")).toBe(true);
    expect(harness.scrollButton.tabIndex).toBe(-1);
    harness.cleanup();
  });

  it("recognizes a manual return to the end as renewed follow ownership", () => {
    const harness = createHarness();
    harness.manualScroll(100);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.manualScroll(590);
    expect(harness.scroller.getMode()).toBe("end");

    harness.state.scrollHeight = 1_200;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.state.scrollTop).toBe(800);
    harness.cleanup();
  });

  it("preserves follow ownership across owned viewport geometry changes only", () => {
    const harness = createHarness();
    expect(harness.scroller.getMode()).toBe("end");

    harness.state.clientHeight = 260;
    harness.scroller.notifyViewportGeometryChanged();

    expect(harness.state.scrollTop).toBe(740);
    expect(harness.calls.at(-1)).toEqual({ top: 740, behavior: "auto" });
    expect(harness.scroller.getMode()).toBe("end");
    expect(harness.scrollButton.dataset.active).toBe("false");

    harness.manualScroll(200);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.state.clientHeight = 320;
    harness.scroller.notifyViewportGeometryChanged();

    expect(harness.state.scrollTop).toBe(200);
    expect(harness.scroller.getMode()).toBe("manual");
    expect(harness.scrollButton.dataset.active).toBe("true");
    harness.cleanup();
  });

  it("coalesces content and viewport geometry changes while respecting manual reading", () => {
    const originalResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    let resizeCallback: ResizeObserverCallback | null = null;
    const observe = jest.fn();
    const disconnect = jest.fn();
    class TestResizeObserver {
      public constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      public observe = observe;
      public unobserve = jest.fn();
      public disconnect = disconnect;
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    });
    const frames: FrameRequestCallback[] = [];
    const requestFrame = jest.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelFrame = jest.spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    let harness: ReturnType<typeof createHarness> | null = null;
    try {
      harness = createHarness();
      expect(observe).toHaveBeenNthCalledWith(1, harness.viewport);
      expect(observe).toHaveBeenNthCalledWith(2, harness.content);

      harness.state.scrollHeight = 1_100;
      harness.state.clientHeight = 300;
      resizeCallback?.([], {} as ResizeObserver);
      resizeCallback?.([], {} as ResizeObserver);
      expect(requestFrame).toHaveBeenCalledTimes(1);
      frames.shift()?.(0);
      expect(harness.state.scrollTop).toBe(800);
      expect(harness.calls.at(-1)).toEqual({ top: 800, behavior: "auto" });

      harness.manualScroll(100);
      harness.state.scrollHeight = 1_300;
      resizeCallback?.([], {} as ResizeObserver);
      frames.shift()?.(0);
      expect(harness.state.scrollTop).toBe(100);
      expect(harness.scrollButton.dataset.active).toBe("true");

      resizeCallback?.([], {} as ResizeObserver);
      harness.cleanup();
      harness = null;
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(cancelFrame).toHaveBeenCalledTimes(1);
    } finally {
      harness?.cleanup();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      if (originalResizeObserver) {
        Object.defineProperty(window, "ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(window, "ResizeObserver");
      }
    }
  });

  it("fails fast for unstable registration, missing rows, and use after destroy", () => {
    const harness = createHarness();
    const row = harness.addRow("row", 100);
    expect(() => harness.scroller.registerRow("row", row)).not.toThrow();
    expect(() => harness.scroller.registerRow("row", document.createElement("div"))).toThrow(
      "AnchoredScroller row row is already registered to another element.",
    );
    expect(() => harness.scroller.jumpTo("missing")).toThrow(
      "AnchoredScroller row missing is not registered.",
    );

    harness.scroller.unregisterRow("row");
    expect(row.dataset.agentRowId).toBeUndefined();
    harness.scroller.destroy();
    expect(() => harness.scroller.notifyContentChanged()).toThrow(
      "AnchoredScroller has been destroyed.",
    );
    harness.viewport.remove();
    harness.scrollButton.remove();
  });

  it("restores end ownership to the latest content after history replacement", () => {
    const harness = createHarness({ scrollTop: 1_000, scrollHeight: 1_400 });
    const turn = harness.addRow("turn", 900, 200);
    const anchor: AnchoredScrollerPrependAnchor = {
      rowId: "turn",
      offsetFromViewportTop: turn.offsetTop - harness.state.scrollTop,
      mode: "end",
    };
    harness.state.scrollHeight = 1_700;
    harness.setRowLayout(turn, { top: 1_200 });
    harness.scroller.restorePrependAnchor(anchor);
    expect(harness.scroller.getMode()).toBe("end");
    expect(harness.state.scrollTop).toBe(1_300);
    harness.cleanup();
  });

  it("keeps programmatic ownership through intermediate smooth-scroll frames", () => {
    const harness = createHarness({ scrollTop: 0, scrollHeight: 1_600 });
    harness.viewport.scrollTo = ((options: ScrollToOptions) => {
      harness.calls.push({
        top: Number(options.top ?? harness.state.scrollTop),
        behavior: options.behavior ?? "auto",
      });
    }) as typeof harness.viewport.scrollTo;

    harness.scroller.scrollToEnd();
    harness.state.scrollTop = 300;
    harness.viewport.dispatchEvent(new Event("scroll"));

    expect(harness.scroller.getMode()).toBe("end");
    harness.state.scrollHeight = 1_900;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.calls.at(-1)).toEqual({ top: 1_500, behavior: "auto" });
    harness.cleanup();
  });

  it("does not disable end following for no-op wheel, touch tap, or interactive keyboard input", () => {
    const harness = createHarness();
    const button = document.createElement("button");
    harness.content.appendChild(button);

    harness.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: 120,
    }));
    button.dispatchEvent(new Event("touchstart", { bubbles: true }));
    button.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: " ",
    }));
    expect(harness.scroller.getMode()).toBe("end");

    harness.state.scrollHeight = 1_200;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.state.scrollTop).toBe(800);
    expect(harness.scroller.getMode()).toBe("end");
    harness.cleanup();
  });

  it.each([
    ["wheel", () => new WheelEvent("wheel", { bubbles: true, deltaY: -120 })],
    ["touch", () => new Event("touchmove", { bubbles: true })],
    ["keyboard", () => new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })],
  ])("uses the resulting scroll position after %s input", (_name, createEvent) => {
    const harness = createHarness();
    harness.viewport.dispatchEvent(createEvent());
    harness.manualScroll(100);
    expect(harness.scroller.getMode()).toBe("manual");

    harness.viewport.dispatchEvent(createEvent());
    harness.manualScroll(600);
    expect(harness.scroller.getMode()).toBe("end");
    harness.state.scrollHeight = 1_200;
    harness.scroller.notifyContentChanged({ streaming: true });
    expect(harness.state.scrollTop).toBe(800);
    harness.cleanup();
  });
});
