/**
 * @jest-environment jsdom
 */

import { AnchoredScroller } from "../AnchoredScroller";

type ViewportState = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

type RowLayout = {
  top: number;
  height: number;
};

type PartLayout = {
  top: number;
  height: number;
};

type ScrollCall = {
  top: number;
  behavior: ScrollBehavior;
};

type ViewportGeometryReads = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function bindViewportRect(
  element: HTMLElement,
  viewportState: ViewportState,
  layout: Readonly<{ top: number; height: number }>,
): void {
  element.getBoundingClientRect = () => {
    const top = layout.top - viewportState.scrollTop;
    return {
      x: 0,
      y: top,
      top,
      right: 100,
      bottom: top + layout.height,
      left: 0,
      width: 100,
      height: layout.height,
      toJSON: () => ({}),
    };
  };
}

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
  const viewportGeometryReads: ViewportGeometryReads = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  const rowLayouts = new Map<HTMLElement, RowLayout>();
  const partLayouts = new Map<HTMLElement, PartLayout>();

  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => {
        viewportGeometryReads.scrollTop += 1;
        return state.scrollTop;
      },
      set: (value: number) => { state.scrollTop = value; },
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        viewportGeometryReads.scrollHeight += 1;
        const spacer = content.querySelector<HTMLElement>(
          "[data-agent-submitted-prompt-space]",
        );
        return state.scrollHeight + Number.parseFloat(spacer?.getAttribute("height") || "0");
      },
    },
    clientHeight: {
      configurable: true,
      get: () => {
        viewportGeometryReads.clientHeight += 1;
        return state.clientHeight;
      },
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

  const addPart = (
    row: HTMLElement,
    key: string,
    top: number,
    height = 100,
  ): HTMLElement => {
    const part = document.createElement("div");
    part.dataset.partKey = key;
    row.appendChild(part);
    const layout = { top, height };
    partLayouts.set(part, layout);
    part.getBoundingClientRect = () => {
      const current = partLayouts.get(part) ?? { top: 0, height: 0 };
      const viewportTop = current.top - state.scrollTop;
      return {
        x: 0,
        y: viewportTop,
        top: viewportTop,
        right: 100,
        bottom: viewportTop + current.height,
        left: 0,
        width: 100,
        height: current.height,
        toJSON: () => ({}),
      };
    };
    return part;
  };

  const setPartLayout = (part: HTMLElement, layout: Partial<PartLayout>): void => {
    const current = partLayouts.get(part);
    if (!current) throw new Error("Unknown part");
    Object.assign(current, layout);
  };

  const manualScroll = (top: number): void => {
    state.scrollTop = top;
    viewport.dispatchEvent(new Event("scroll"));
  };

  const resetViewportGeometryReads = (): void => {
    viewportGeometryReads.scrollTop = 0;
    viewportGeometryReads.scrollHeight = 0;
    viewportGeometryReads.clientHeight = 0;
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
    viewportGeometryReads,
    scroller,
    addRow,
    addPart,
    setRowLayout,
    setPartLayout,
    manualScroll,
    resetViewportGeometryReads,
    cleanup,
  };
}

function installResizeObserverHarness(): {
  notify: (target: Element) => void;
  flush: () => void;
  cleanup: () => void;
} {
  const originalResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
  let resizeCallback: ResizeObserverCallback | null = null;
  class TestResizeObserver {
    public constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    public observe = jest.fn();
    public unobserve = jest.fn();
    public disconnect = jest.fn();
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
  return {
    notify: (target) => {
      resizeCallback?.([{ target } as ResizeObserverEntry], {} as ResizeObserver);
    },
    flush: () => {
      const frame = frames.shift();
      if (!frame) throw new Error("Expected a pending geometry frame.");
      frame(0);
    },
    cleanup: () => {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      if (originalResizeObserver) {
        Object.defineProperty(window, "ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(window, "ResizeObserver");
      }
    },
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

  it("returns a frozen content-free incident snapshot from maintained scroll state", () => {
    const harness = createHarness();
    harness.addRow("private-row-id-canary", 600);

    const atEnd = harness.scroller.captureIncidentSnapshot();
    expect(Object.isFrozen(atEnd)).toBe(true);
    expect(atEnd).toEqual({
      mode: "end",
      distanceFromEndBucket: "at_end",
      registeredRowCount: 1,
      pendingLayoutMutationCount: 0,
      layoutMutationPending: false,
      geometryUpdatePending: false,
      programmaticScrollPending: false,
      submittedPromptAnchorActive: false,
      destroyed: false,
    });

    harness.manualScroll(300);
    expect(harness.scroller.captureIncidentSnapshot()).toMatchObject({
      mode: "manual",
      distanceFromEndBucket: "within_viewport",
    });
    harness.manualScroll(0);
    expect(harness.scroller.captureIncidentSnapshot().distanceFromEndBucket)
      .toBe("far_from_end");

    const finishOuter = harness.scroller.beginLayoutMutation();
    const finishInner = harness.scroller.beginLayoutMutation();
    const pending = harness.scroller.captureIncidentSnapshot();
    expect(pending.pendingLayoutMutationCount).toBe(2);
    expect(pending.layoutMutationPending).toBe(true);
    expect(JSON.stringify(pending)).not.toContain("private-row-id-canary");
    finishInner();
    finishOuter();

    Object.defineProperties(harness.viewport, {
      scrollTop: {
        configurable: true,
        get: () => { throw new Error("scroll-top-private-canary"); },
      },
      scrollHeight: {
        configurable: true,
        get: () => { throw new Error("scroll-height-private-canary"); },
      },
      clientHeight: {
        configurable: true,
        get: () => { throw new Error("client-height-private-canary"); },
      },
    });
    expect(() => harness.scroller.captureIncidentSnapshot()).not.toThrow();
    expect(JSON.stringify(harness.scroller.captureIncidentSnapshot()))
      .not.toContain("private-canary");
    harness.cleanup();
  });

  it.each([
    [0, "at_end", false, "end"],
    [1, "at_end", false, "end"],
    [1.01, "near_end", false, "end"],
    [24, "near_end", false, "end"],
    [24.01, "within_viewport", true, "manual"],
    [400, "within_viewport", true, "manual"],
    [400.01, "far_from_end", true, "manual"],
  ] as const)(
    "measures geometry once and keeps boundary state aligned at %s pixels from the end",
    (distanceFromEnd, expectedBucket, expectedButtonActive, expectedMode) => {
      const harness = createHarness({
        scrollTop: 600 - distanceFromEnd,
      });
      harness.resetViewportGeometryReads();

      harness.addRow(`boundary-${String(distanceFromEnd)}`, 0);

      expect(harness.viewportGeometryReads).toEqual({
        scrollTop: 1,
        scrollHeight: 1,
        clientHeight: 1,
      });
      const refreshedState = {
        bucket: harness.scroller.captureIncidentSnapshot().distanceFromEndBucket,
        active: harness.scrollButton.dataset.active,
        hidden: harness.scrollButton.getAttribute("aria-hidden"),
        inert: harness.scrollButton.hasAttribute("inert"),
        tabIndex: harness.scrollButton.tabIndex,
      };
      expect(refreshedState).toEqual({
        bucket: expectedBucket,
        active: String(expectedButtonActive),
        hidden: expectedButtonActive ? "false" : "true",
        inert: !expectedButtonActive,
        tabIndex: expectedButtonActive ? 0 : -1,
      });

      harness.resetViewportGeometryReads();
      harness.viewport.dispatchEvent(new Event("scroll"));

      expect(harness.viewportGeometryReads).toEqual({
        scrollTop: 1,
        scrollHeight: 1,
        clientHeight: 1,
      });
      expect(harness.scroller.getMode()).toBe(expectedMode);
      expect({
        bucket: harness.scroller.captureIncidentSnapshot().distanceFromEndBucket,
        active: harness.scrollButton.dataset.active,
        hidden: harness.scrollButton.getAttribute("aria-hidden"),
        inert: harness.scrollButton.hasAttribute("inert"),
        tabIndex: harness.scrollButton.tabIndex,
      }).toEqual(refreshedState);
      harness.cleanup();
    },
  );

  it("follows streaming growth only while the reader remains at the end", () => {
    const harness = createHarness();
    expect(harness.scroller.isFollowingEnd()).toBe(true);

    const finishEndGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_200;
    finishEndGrowth();
    harness.scroller.setStreaming(true);
    expect(harness.state.scrollTop).toBe(800);
    expect(harness.calls.at(-1)).toEqual({ top: 800, behavior: "auto" });
    expect(harness.content.getAttribute("aria-busy")).toBe("true");

    harness.manualScroll(120);
    expect(harness.scroller.getMode()).toBe("manual");
    expect(harness.scrollButton.getAttribute("data-active")).toBe("true");

    const finishManualGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_400;
    finishManualGrowth();
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

    const finishGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 2_000;
    finishGrowth();
    expect(harness.state.scrollTop).toBe(120);

    harness.manualScroll(1_600);
    harness.scroller.notifyTurnStarted();
    expect(harness.scroller.getMode()).toBe("end");
    expect(harness.state.scrollTop).toBe(1_600);
    harness.cleanup();
  });

  it("anchors an explicitly submitted prompt 16px below the viewport top", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_200 });
    const prompt = harness.addRow("prompt", 900, 80);

    harness.scroller.notifyTurnStarted({
      submittedPromptRowId: "prompt",
      submittedPromptOffset: 16,
    });

    expect(harness.state.scrollTop).toBe(884);
    expect(prompt.offsetTop - harness.state.scrollTop).toBe(16);
    expect(harness.calls.at(-1)).toEqual({ top: 884, behavior: "smooth" });
    expect(harness.content.querySelector<HTMLElement>(
      "[data-agent-submitted-prompt-space]",
    )?.getAttribute("height")).toBe("84");
    harness.cleanup();
  });

  it("keeps a fitting response below its submitted prompt, then reveals only overflow", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_100 });
    const prompt = harness.addRow("prompt", 900, 80);
    harness.scroller.notifyTurnStarted({ submittedPromptRowId: "prompt" });
    expect(harness.state.scrollTop).toBe(884);

    const finishFittingGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_150;
    finishFittingGrowth();
    expect(harness.state.scrollTop).toBe(884);
    expect(prompt.offsetTop - harness.state.scrollTop).toBe(16);

    const finishOverflowGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_400;
    finishOverflowGrowth();
    expect(harness.state.scrollTop).toBe(1_000);
    expect(prompt.offsetTop - harness.state.scrollTop).toBe(-100);
    expect(harness.calls.at(-1)).toEqual({ top: 1_000, behavior: "auto" });
    harness.cleanup();
  });

  it("preserves manual navigation after submitted-prompt anchoring", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_200 });
    harness.addRow("prompt", 900, 80);
    harness.scroller.notifyTurnStarted({ submittedPromptRowId: "prompt" });
    harness.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    harness.manualScroll(300);
    expect(harness.scroller.getMode()).toBe("manual");

    const finishGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_600;
    finishGrowth();

    expect(harness.state.scrollTop).toBe(300);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("clears submitted-prompt space when Latest returns to the real end", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_200 });
    harness.addRow("prompt", 900, 80);
    harness.scroller.notifyTurnStarted({ submittedPromptRowId: "prompt" });

    harness.scroller.scrollToEnd();

    expect(harness.state.scrollTop).toBe(800);
    expect(harness.calls.at(-1)).toEqual({ top: 800, behavior: "smooth" });
    expect(harness.content.querySelector<HTMLElement>(
      "[data-agent-submitted-prompt-space]",
    )?.getAttribute("height")).toBe("0");
    harness.cleanup();
  });

  it("uses reduced motion and does not restart an unchanged prompt-anchor scroll", () => {
    const harness = createHarness({
      scrollTop: 600,
      scrollHeight: 1_200,
      reducedMotion: true,
    });
    harness.addRow("prompt", 900, 80);
    harness.viewport.scrollTo = ((options: ScrollToOptions) => {
      harness.calls.push({
        top: Number(options.top ?? harness.state.scrollTop),
        behavior: options.behavior ?? "auto",
      });
    }) as typeof harness.viewport.scrollTo;

    harness.scroller.notifyTurnStarted({ submittedPromptRowId: "prompt" });
    const finishGrowth = harness.scroller.beginLayoutMutation();
    finishGrowth();

    expect(harness.calls).toEqual([{ top: 884, behavior: "auto" }]);
    harness.cleanup();
  });

  it("preserves a visible row and its pixel offset across owned layout mutations", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    harness.addRow("above", 0, 200);
    const visible = harness.addRow("visible", 200, 200);
    harness.manualScroll(250);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_300;
    harness.setRowLayout(visible, { top: 500 });
    finishMutation();

    expect(harness.state.scrollTop).toBe(550);
    expect(visible.offsetTop - harness.state.scrollTop).toBe(-50);
    expect(harness.scroller.getMode()).toBe("manual");

    harness.setRowLayout(visible, { top: 700 });
    finishMutation();
    expect(harness.state.scrollTop).toBe(550);
    harness.cleanup();
  });

  it("preserves the first visible keyed part when work above it collapses", () => {
    const harness = createHarness({
      scrollTop: 650,
      scrollHeight: 1_600,
      clientHeight: 400,
    });
    const response = harness.addRow("response", 100, 1_200);
    harness.addPart(response, "tool:finished", 100, 450);
    const answer = harness.addPart(response, "answer", 700, 180);
    harness.addPart(response, "sources", 900, 120);
    harness.manualScroll(650);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_300;
    harness.setRowLayout(response, { height: 850 });
    harness.setPartLayout(answer, { top: 350 });
    finishMutation();

    expect(harness.state.scrollTop).toBe(300);
    expect(answer.getBoundingClientRect().top).toBe(50);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("resolves a replaced visible part through its stable key", () => {
    const harness = createHarness({
      scrollTop: 650,
      scrollHeight: 1_600,
      clientHeight: 400,
    });
    const response = harness.addRow("response", 100, 1_200);
    const original = harness.addPart(response, "answer", 700, 180);
    harness.manualScroll(650);
    const finishMutation = harness.scroller.beginLayoutMutation();

    original.remove();
    const replacement = harness.addPart(response, "answer", 400, 180);
    harness.state.scrollHeight = 1_300;
    finishMutation();

    expect(harness.state.scrollTop).toBe(350);
    expect(replacement.getBoundingClientRect().top).toBe(50);
    harness.cleanup();
  });

  it("falls back to the response row when its keyed parts are outside the viewport", () => {
    const harness = createHarness({
      scrollTop: 600,
      scrollHeight: 1_400,
      clientHeight: 400,
    });
    const response = harness.addRow("response", 500, 700);
    const above = harness.addPart(response, "above", 500, 50);
    const below = harness.addPart(response, "below", 1_050, 50);
    harness.manualScroll(600);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_700;
    harness.setRowLayout(response, { top: 700 });
    harness.setPartLayout(above, { top: 700 });
    harness.setPartLayout(below, { top: 1_250 });
    finishMutation();

    expect(harness.state.scrollTop).toBe(800);
    expect(response.offsetTop - harness.state.scrollTop).toBe(-100);
    harness.cleanup();
  });

  it("falls back to the response row when the captured keyed part disappears", () => {
    const harness = createHarness({
      scrollTop: 650,
      scrollHeight: 1_600,
      clientHeight: 400,
    });
    const response = harness.addRow("response", 100, 1_200);
    const answer = harness.addPart(response, "answer", 700, 180);
    harness.manualScroll(650);
    const finishMutation = harness.scroller.beginLayoutMutation();

    answer.remove();
    harness.state.scrollHeight = 1_800;
    harness.setRowLayout(response, { top: 250 });
    finishMutation();

    expect(harness.state.scrollTop).toBe(800);
    expect(response.offsetTop - harness.state.scrollTop).toBe(-550);
    harness.cleanup();
  });

  it("anchors the topmost visible row without relying on registration order", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    const lower = harness.addRow("lower", 300, 100);
    const topmost = harness.addRow("topmost", 200, 100);
    harness.addRow("above", 0, 100);
    harness.manualScroll(250);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_500;
    harness.setRowLayout(lower, { top: 900 });
    harness.setRowLayout(topmost, { top: 500 });
    finishMutation();

    expect(harness.state.scrollTop).toBe(550);
    expect(topmost.offsetTop - harness.state.scrollTop).toBe(-50);
    harness.cleanup();
  });

  it("does not inspect row geometry when an end-follow mutation starts", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_000 });
    const row = harness.addRow("visible", 500, 300);
    const target = document.createElement("div");
    harness.content.appendChild(target);
    const targetRect = jest.spyOn(target, "getBoundingClientRect");
    const offsetTop = jest.spyOn(row, "offsetTop", "get");
    const offsetHeight = jest.spyOn(row, "offsetHeight", "get");

    const finishMutation = harness.scroller.beginLayoutMutation(target);
    expect(targetRect).not.toHaveBeenCalled();
    expect(offsetTop).not.toHaveBeenCalled();
    expect(offsetHeight).not.toHaveBeenCalled();

    harness.state.scrollHeight = 1_300;
    finishMutation();
    expect(harness.state.scrollTop).toBe(900);
    expect(offsetTop).not.toHaveBeenCalled();
    expect(offsetHeight).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it("skips manual history geometry for a connected target below the viewport", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 5_000 });
    const rows = Array.from({ length: 40 }, (_, index) =>
      harness.addRow(`history-${String(index)}`, index * 100, 100));
    const offsetTopReads = rows.map((row) => jest.spyOn(row, "offsetTop", "get"));
    const offsetHeightReads = rows.map((row) => jest.spyOn(row, "offsetHeight", "get"));
    const target = document.createElement("div");
    harness.content.appendChild(target);
    bindViewportRect(harness.viewport, harness.state, {
      top: harness.state.scrollTop,
      height: harness.state.clientHeight,
    });
    bindViewportRect(target, harness.state, {
      top: harness.state.scrollTop + harness.state.clientHeight + 1,
      height: 20,
    });
    harness.manualScroll(250);

    const finishMutation = harness.scroller.beginLayoutMutation(target);
    harness.state.scrollHeight = 5_200;
    finishMutation();

    expect(offsetTopReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(offsetHeightReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(harness.state.scrollTop).toBe(250);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("anchors a visible target part without reading unrelated row geometry", () => {
    const harness = createHarness({
      scrollTop: 650,
      scrollHeight: 5_000,
      clientHeight: 400,
    });
    const historyRows = Array.from({ length: 40 }, (_, index) =>
      harness.addRow(`history-target-${String(index)}`, index * 100, 100));
    const response = harness.addRow("target-response", 500, 800);
    const answer = harness.addPart(response, "target-answer", 700, 180);
    const offsetTopReads = historyRows.map((row) => jest.spyOn(row, "offsetTop", "get"));
    const offsetHeightReads = historyRows.map((row) => jest.spyOn(row, "offsetHeight", "get"));
    bindViewportRect(harness.viewport, harness.state, {
      top: harness.state.scrollTop,
      height: harness.state.clientHeight,
    });
    harness.manualScroll(650);

    const finishMutation = harness.scroller.beginLayoutMutation(answer);
    expect(offsetTopReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(offsetHeightReads.every((read) => read.mock.calls.length === 0)).toBe(true);

    harness.setPartLayout(answer, { top: 400 });
    harness.state.scrollHeight = 4_700;
    finishMutation();

    expect(harness.state.scrollTop).toBe(350);
    expect(answer.getBoundingClientRect().top).toBe(50);
    expect(offsetTopReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(offsetHeightReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it.each([
    ["intersecting", "content", 400],
    ["above", "content", -20],
    ["foreign", "foreign", 401],
    ["disconnected", "disconnected", 401],
  ] as const)("uses the full manual anchor path for a %s target", (_name, owner, screenTop) => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    const visible = harness.addRow("visible", 200, 200);
    const offsetTop = jest.spyOn(visible, "offsetTop", "get");
    const target = document.createElement("div");
    if (owner === "content") harness.content.appendChild(target);
    else if (owner === "foreign") document.body.appendChild(target);
    bindViewportRect(harness.viewport, harness.state, {
      top: harness.state.scrollTop,
      height: harness.state.clientHeight,
    });
    bindViewportRect(target, harness.state, {
      top: harness.state.scrollTop + screenTop,
      height: 20,
    });
    harness.manualScroll(250);

    const finishMutation = harness.scroller.beginLayoutMutation(target);

    expect(offsetTop).toHaveBeenCalled();
    finishMutation();
    expect(harness.state.scrollTop).toBe(250);
    harness.cleanup();
  });

  it("upgrades a skipped outer mutation when overlapping work needs a full anchor", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    const visible = harness.addRow("visible", 200, 200);
    const offsetTop = jest.spyOn(visible, "offsetTop", "get");
    const target = document.createElement("div");
    harness.content.appendChild(target);
    bindViewportRect(harness.viewport, harness.state, {
      top: harness.state.scrollTop,
      height: harness.state.clientHeight,
    });
    bindViewportRect(target, harness.state, {
      top: harness.state.scrollTop + harness.state.clientHeight + 1,
      height: 20,
    });
    harness.manualScroll(250);

    const finishOuterMutation = harness.scroller.beginLayoutMutation(target);
    expect(offsetTop).not.toHaveBeenCalled();
    const finishInnerMutation = harness.scroller.beginLayoutMutation();
    expect(offsetTop).toHaveBeenCalled();
    harness.setRowLayout(visible, { top: 500 });
    harness.state.scrollHeight = 1_300;

    finishInnerMutation();
    expect(harness.state.scrollTop).toBe(250);
    finishOuterMutation();
    expect(harness.state.scrollTop).toBe(550);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("does not restore a skipped target mutation after manual scroll input", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    harness.addRow("visible", 200, 200);
    const target = document.createElement("div");
    harness.content.appendChild(target);
    bindViewportRect(harness.viewport, harness.state, {
      top: harness.state.scrollTop,
      height: harness.state.clientHeight,
    });
    bindViewportRect(target, harness.state, {
      top: harness.state.scrollTop + harness.state.clientHeight + 1,
      height: 20,
    });
    harness.manualScroll(250);
    const finishMutation = harness.scroller.beginLayoutMutation(target);

    harness.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    harness.manualScroll(100);
    finishMutation();

    expect(harness.state.scrollTop).toBe(100);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("keeps outer and nested disclosure controls fixed across open and close", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_000 });
    const row = harness.addRow("response", 400, 500);
    const outer = document.createElement("details");
    const outerSummary = document.createElement("summary");
    const nested = document.createElement("details");
    const nestedSummary = document.createElement("summary");
    outerSummary.dataset.focusKey = "activity-summary";
    nestedSummary.dataset.focusKey = "tool-summary";
    nested.appendChild(nestedSummary);
    outer.append(outerSummary, nested);
    row.appendChild(outer);
    const outerLayout = { top: 700, height: 30 };
    const nestedLayout = { top: 850, height: 30 };
    bindViewportRect(outerSummary, harness.state, outerLayout);
    bindViewportRect(nestedSummary, harness.state, nestedLayout);

    const finishOuterOpen = harness.scroller.beginDisclosureLayoutMutation(outerSummary);
    harness.state.scrollHeight = 1_400;
    finishOuterOpen();
    expect(harness.state.scrollTop).toBe(600);
    expect(outerSummary.getBoundingClientRect().top).toBe(100);
    expect(harness.scroller.getMode()).toBe("manual");

    const finishNestedOpen = harness.scroller.beginDisclosureLayoutMutation(nestedSummary);
    nestedLayout.top = 900;
    harness.state.scrollHeight = 1_500;
    finishNestedOpen();
    expect(harness.state.scrollTop).toBe(650);
    expect(nestedSummary.getBoundingClientRect().top).toBe(250);

    const finishNestedClose = harness.scroller.beginDisclosureLayoutMutation(nestedSummary);
    nestedLayout.top = 800;
    harness.state.scrollHeight = 1_300;
    finishNestedClose();
    expect(harness.state.scrollTop).toBe(550);
    expect(nestedSummary.getBoundingClientRect().top).toBe(250);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("falls back to the containing response when a disclosure control disappears", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_000 });
    const row = harness.addRow("response", 400, 500);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.dataset.focusKey = "activity-summary";
    details.appendChild(summary);
    row.appendChild(details);
    bindViewportRect(summary, harness.state, { top: 700, height: 30 });

    const finishMutation = harness.scroller.beginDisclosureLayoutMutation(summary);
    summary.remove();
    harness.setRowLayout(row, { top: 450 });
    harness.state.scrollHeight = 1_300;
    finishMutation();

    expect(harness.state.scrollTop).toBe(650);
    expect(row.offsetTop - harness.state.scrollTop).toBe(-200);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("shares the outermost anchor across overlapping layout mutations", () => {
    const harness = createHarness({ scrollTop: 250, scrollHeight: 1_000 });
    const visible = harness.addRow("visible", 200, 200);
    harness.manualScroll(250);
    const finishOuterMutation = harness.scroller.beginLayoutMutation();

    harness.setRowLayout(visible, { top: 400 });
    const finishInnerMutation = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_300;
    harness.setRowLayout(visible, { top: 500 });

    finishInnerMutation();
    expect(harness.state.scrollTop).toBe(250);
    finishOuterMutation();
    expect(harness.state.scrollTop).toBe(550);
    expect(visible.offsetTop - harness.state.scrollTop).toBe(-50);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("restores exact end following after mutation-generated scroll events", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_000 });
    harness.addRow("visible", 500, 300);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_400;
    harness.manualScroll(600);
    expect(harness.scroller.getMode()).toBe("manual");
    finishMutation();

    expect(harness.state.scrollTop).toBe(1_000);
    expect(harness.scroller.getMode()).toBe("end");
    expect(harness.calls.at(-1)).toEqual({ top: 1_000, behavior: "auto" });
    harness.cleanup();
  });

  it("does not restore a mutation anchor after the reader takes scroll ownership", () => {
    const harness = createHarness({ scrollTop: 600, scrollHeight: 1_000 });
    harness.addRow("visible", 500, 300);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_400;
    harness.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    harness.manualScroll(100);
    finishMutation();

    expect(harness.state.scrollTop).toBe(100);
    expect(harness.scroller.getMode()).toBe("manual");
    harness.cleanup();
  });

  it("keeps manual ownership when a layout mutation has no visible registered row", () => {
    const harness = createHarness({ scrollTop: 100, scrollHeight: 1_000 });
    harness.addRow("below", 600, 100);
    harness.manualScroll(100);
    const finishMutation = harness.scroller.beginLayoutMutation();

    harness.state.scrollHeight = 1_300;
    finishMutation();

    expect(harness.state.scrollTop).toBe(100);
    expect(harness.scroller.getMode()).toBe("manual");
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

    const finishGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_200;
    finishGrowth();
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
      const callsBeforeStreamingState = harness.calls.length;
      harness.scroller.setStreaming(true);
      expect(harness.content.getAttribute("aria-busy")).toBe("true");
      expect(harness.calls).toHaveLength(callsBeforeStreamingState);
      resizeCallback?.([], {} as ResizeObserver);
      resizeCallback?.([], {} as ResizeObserver);
      expect(requestFrame).toHaveBeenCalledTimes(1);
      frames.shift()?.(0);
      expect(harness.state.scrollTop).toBe(800);
      expect(harness.calls.at(-1)).toEqual({ top: 800, behavior: "auto" });
      harness.scroller.setStreaming(false);
      expect(harness.content.hasAttribute("aria-busy")).toBe(false);

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

  it("keeps a keyed part fixed when delayed intrinsic content grows above the viewport", () => {
    const resize = installResizeObserverHarness();
    let harness: ReturnType<typeof createHarness> | null = null;
    try {
      harness = createHarness({
        scrollTop: 650,
        scrollHeight: 1_600,
        clientHeight: 400,
      });
      const response = harness.addRow("delayed-above", 100, 1_200);
      const answer = harness.addPart(response, "answer", 700, 180);
      harness.viewport.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        deltaY: -120,
      }));
      harness.manualScroll(650);
      harness.scroller.notifyViewportGeometryChanged();
      expect(answer.getBoundingClientRect().top).toBe(50);

      harness.state.scrollHeight = 1_800;
      harness.setRowLayout(response, { height: 1_400 });
      harness.setPartLayout(answer, { top: 900 });
      resize.notify(harness.content);
      resize.flush();

      expect(harness.state.scrollTop).toBe(850);
      expect(answer.getBoundingClientRect().top).toBe(50);
      expect(harness.scroller.getMode()).toBe("manual");
    } finally {
      harness?.cleanup();
      resize.cleanup();
    }
  });

  it("keeps a keyed part fixed when delayed intrinsic content grows inside the viewport", () => {
    const resize = installResizeObserverHarness();
    let harness: ReturnType<typeof createHarness> | null = null;
    try {
      harness = createHarness({
        scrollTop: 600,
        scrollHeight: 1_500,
        clientHeight: 400,
      });
      const response = harness.addRow("delayed-visible", 100, 1_200);
      const delayedEmbed = document.createElement("div");
      response.appendChild(delayedEmbed);
      bindViewportRect(delayedEmbed, harness.state, { top: 650, height: 80 });
      const answer = harness.addPart(response, "answer", 780, 180);
      harness.viewport.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        deltaY: -120,
      }));
      harness.manualScroll(600);
      harness.scroller.notifyViewportGeometryChanged();
      expect(delayedEmbed.getBoundingClientRect().top).toBe(50);
      expect(answer.getBoundingClientRect().top).toBe(180);

      harness.state.scrollHeight = 1_630;
      harness.setRowLayout(response, { height: 1_330 });
      harness.setPartLayout(answer, { top: 910 });
      resize.notify(harness.content);
      resize.flush();

      expect(harness.state.scrollTop).toBe(730);
      expect(answer.getBoundingClientRect().top).toBe(180);
      expect(harness.scroller.getMode()).toBe("manual");
    } finally {
      harness?.cleanup();
      resize.cleanup();
    }
  });

  it("lets a reader scroll during a pending intrinsic resize and anchors later growth", () => {
    const resize = installResizeObserverHarness();
    let harness: ReturnType<typeof createHarness> | null = null;
    try {
      harness = createHarness({
        scrollTop: 650,
        scrollHeight: 1_600,
        clientHeight: 400,
      });
      const response = harness.addRow("delayed-user-scroll", 100, 1_300);
      const answer = harness.addPart(response, "answer", 700, 180);
      harness.viewport.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        deltaY: -120,
      }));
      harness.manualScroll(650);
      harness.scroller.notifyViewportGeometryChanged();

      harness.state.scrollHeight = 1_800;
      harness.setRowLayout(response, { height: 1_500 });
      harness.setPartLayout(answer, { top: 900 });
      resize.notify(harness.content);
      harness.viewport.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        deltaY: 120,
      }));
      harness.manualScroll(720);
      harness.scroller.notifyViewportGeometryChanged();
      resize.flush();

      expect(harness.state.scrollTop).toBe(720);
      expect(answer.getBoundingClientRect().top).toBe(180);

      harness.state.scrollHeight = 1_900;
      harness.setRowLayout(response, { height: 1_600 });
      harness.setPartLayout(answer, { top: 1_000 });
      resize.notify(harness.content);
      resize.flush();

      expect(harness.state.scrollTop).toBe(820);
      expect(answer.getBoundingClientRect().top).toBe(180);
      expect(harness.scroller.getMode()).toBe("manual");
    } finally {
      harness?.cleanup();
      resize.cleanup();
    }
  });

  it("keeps end followers pinned during delayed intrinsic content growth", () => {
    const resize = installResizeObserverHarness();
    let harness: ReturnType<typeof createHarness> | null = null;
    try {
      harness = createHarness({
        scrollTop: 600,
        scrollHeight: 1_000,
        clientHeight: 400,
      });

      harness.state.scrollHeight = 1_300;
      resize.notify(harness.content);
      resize.flush();

      expect(harness.state.scrollTop).toBe(900);
      expect(harness.calls.at(-1)).toEqual({ top: 900, behavior: "auto" });
      expect(harness.scroller.getMode()).toBe("end");
    } finally {
      harness?.cleanup();
      resize.cleanup();
    }
  });

  it("suppresses ResizeObserver end correction while a disclosure settles", () => {
    const originalResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      public constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      public observe = jest.fn();
      public unobserve = jest.fn();
      public disconnect = jest.fn();
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
    let harness: ReturnType<typeof createHarness> | null = null;
    try {
      harness = createHarness({ scrollTop: 600, scrollHeight: 1_000 });
      const row = harness.addRow("response", 400, 500);
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      details.appendChild(summary);
      row.appendChild(details);
      bindViewportRect(summary, harness.state, { top: 700, height: 30 });

      const finishMutation = harness.scroller.beginDisclosureLayoutMutation(summary);
      harness.state.scrollHeight = 1_400;
      resizeCallback?.([], {} as ResizeObserver);
      frames.shift()?.(0);
      expect(harness.state.scrollTop).toBe(600);

      finishMutation();
      expect(harness.state.scrollTop).toBe(600);
      expect(harness.scroller.getMode()).toBe("manual");

      resizeCallback?.([], {} as ResizeObserver);
      frames.shift()?.(0);
      expect(harness.state.scrollTop).toBe(600);
      expect(harness.scroller.getMode()).toBe("manual");
    } finally {
      harness?.cleanup();
      requestFrame.mockRestore();
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
    expect(() => harness.scroller.beginLayoutMutation()).toThrow(
      "AnchoredScroller has been destroyed.",
    );
    harness.viewport.remove();
    harness.scrollButton.remove();
  });

  it("restores end ownership to the latest content after history replacement", () => {
    const harness = createHarness({ scrollTop: 1_000, scrollHeight: 1_400 });
    const turn = harness.addRow("turn", 900, 200);
    const finishMutation = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_700;
    harness.setRowLayout(turn, { top: 1_200 });
    finishMutation();
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
    harness.resetViewportGeometryReads();
    harness.viewport.dispatchEvent(new Event("scroll"));

    expect(harness.viewportGeometryReads).toEqual({
      scrollTop: 1,
      scrollHeight: 1,
      clientHeight: 1,
    });
    expect(harness.scroller.getMode()).toBe("end");
    const finishGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_900;
    finishGrowth();
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

    const finishGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_200;
    finishGrowth();
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
    const finishGrowth = harness.scroller.beginLayoutMutation();
    harness.state.scrollHeight = 1_200;
    finishGrowth();
    expect(harness.state.scrollTop).toBe(800);
    harness.cleanup();
  });
});
