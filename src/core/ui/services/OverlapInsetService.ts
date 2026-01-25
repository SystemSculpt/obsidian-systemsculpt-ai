import type { App, Component } from "obsidian";

export interface OverlapInsetOptions {
  app: App;
  container: HTMLElement;
  getAnchor: () => HTMLElement | null;
  cssVariable?: string;
  applyPaddingBottom?: boolean;
  retryCount?: number;
  retryIntervalMs?: number;
}

export const DEFAULT_OVERLAP_INSET_VAR = "--systemsculpt-overlap-inset";

export function calculateOverlapInset(containerRect: DOMRect, anchorRect: DOMRect): number {
  return Math.max(0, Math.round(containerRect.bottom - anchorRect.top));
}

export function attachOverlapInsetManager(component: Component, options: OverlapInsetOptions): void {
  const {
    app,
    container,
    getAnchor,
    cssVariable = DEFAULT_OVERLAP_INSET_VAR,
    applyPaddingBottom = true,
    retryCount = 15,
    retryIntervalMs = 200,
  } = options;

  let anchorObserver: ResizeObserver | null = null;
  let containerObserver: ResizeObserver | null = null;
  let anchorEl: HTMLElement | null = null;
  let retryTimer: number | null = null;

  const applyInset = (overlap: number) => {
    if (applyPaddingBottom) {
      if (overlap > 0) {
        container.style.setProperty("padding-bottom", `${overlap}px`, "important");
      } else {
        container.style.removeProperty("padding-bottom");
      }
    }
    container.style.setProperty(cssVariable, `${overlap}px`, "important");
  };

  const cleanupObservers = () => {
    if (anchorObserver) {
      anchorObserver.disconnect();
      anchorObserver = null;
    }
    if (containerObserver) {
      containerObserver.disconnect();
      containerObserver = null;
    }
  };

  const updateInset = () => {
    const anchor = getAnchor();
    const isVisible =
      anchor?.isConnected &&
      anchor.getClientRects().length > 0 &&
      getComputedStyle(anchor).display !== "none";

    if (!anchor || !isVisible) {
      applyInset(0);
      cleanupObservers();
      anchorEl = null;
      return;
    }

    const overlap = calculateOverlapInset(container.getBoundingClientRect(), anchor.getBoundingClientRect());
    applyInset(overlap);

    if (anchorEl !== anchor) {
      cleanupObservers();
      anchorEl = anchor;
      if (typeof ResizeObserver !== "undefined") {
        anchorObserver = new ResizeObserver(() => updateInset());
        anchorObserver.observe(anchor);
      }
    }

    if (!containerObserver && typeof ResizeObserver !== "undefined") {
      containerObserver = new ResizeObserver(() => updateInset());
      containerObserver.observe(container);
    }
  };

  updateInset();

  const workspace = app.workspace as any;
  if (typeof workspace?.onLayoutReady === "function") {
    workspace.onLayoutReady(() => {
      updateInset();
      window.setTimeout(updateInset, 50);
      window.setTimeout(updateInset, 250);
    });
  }

  component.registerDomEvent(window, "resize", updateInset);
  component.registerEvent(app.workspace.on("layout-change", updateInset));
  component.registerEvent(app.workspace.on("css-change", updateInset));

  const scheduleRetry = (attempt = 0) => {
    if (attempt >= retryCount) return;
    if (retryTimer) {
      window.clearTimeout(retryTimer);
    }
    retryTimer = window.setTimeout(() => {
      updateInset();
      if (!anchorEl) {
        scheduleRetry(attempt + 1);
      }
    }, retryIntervalMs);
  };
  scheduleRetry();

  component.register(() => {
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    cleanupObservers();
    anchorEl = null;
    container.style.removeProperty("padding-bottom");
    container.style.setProperty(cssVariable, "0px", "important");
  });
}
