import {
  cancelSurfaceAnimationFrame,
  getSurfaceOwnerWindow,
  requestSurfaceAnimationFrame,
} from "../../core/ui/surface/SurfaceDomContext";

export type AnchoredScrollMode = "end" | "manual";

export type AnchoredScrollerPrependAnchor = Readonly<{
  rowId: string;
  offsetFromViewportTop: number;
  mode: AnchoredScrollMode;
}>;

export type AnchoredScrollerOptions = Readonly<{
  viewport: HTMLElement;
  content: HTMLElement;
  scrollButton?: HTMLButtonElement;
  endThreshold?: number;
  reducedMotion?: boolean | (() => boolean);
  labelledBy?: string;
}>;

type RegisteredRow = Readonly<{
  id: string;
  element: HTMLElement;
}>;

const DEFAULT_END_THRESHOLD = 24;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * Owns conversation scrolling without owning messages, rendering, transport,
 * persistence, or agent state. Rows are registered by stable id so history
 * replacement never has to guess from raw pixels alone.
 */
export class AnchoredScroller {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly scrollButton?: HTMLButtonElement;
  private readonly endThreshold: number;
  private readonly reducedMotion: boolean | (() => boolean);
  private readonly rows = new Map<string, RegisteredRow>();
  private mode: AnchoredScrollMode = "end";
  private programmaticTarget: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private geometryFrame: number | null = null;
  private destroyed = false;

  constructor(options: AnchoredScrollerOptions) {
    this.viewport = options.viewport;
    this.content = options.content;
    this.scrollButton = options.scrollButton;
    this.endThreshold = Math.max(0, finite(options.endThreshold ?? DEFAULT_END_THRESHOLD));
    this.reducedMotion = options.reducedMotion ?? (() => {
      try {
        return getSurfaceOwnerWindow(this.viewport)
          .matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      } catch {
        return false;
      }
    });

    this.viewport.setAttribute("role", this.viewport.getAttribute("role") || "region");
    if (options.labelledBy) {
      this.viewport.removeAttribute("aria-label");
      this.viewport.setAttribute("aria-labelledby", options.labelledBy);
    } else {
      this.viewport.setAttribute("aria-label", this.viewport.getAttribute("aria-label") || "Messages");
    }
    this.viewport.setAttribute("tabindex", this.viewport.getAttribute("tabindex") || "0");
    this.content.setAttribute("role", this.content.getAttribute("role") || "log");
    this.content.setAttribute("aria-relevant", this.content.getAttribute("aria-relevant") || "additions");

    this.viewport.addEventListener("scroll", this.handleScroll, { passive: true });
    this.viewport.addEventListener("wheel", this.handleScrollIntent, { passive: true });
    this.viewport.addEventListener("touchmove", this.handleScrollIntent, { passive: true });
    this.viewport.addEventListener("pointerdown", this.handlePointerDown, { passive: true });
    this.viewport.addEventListener("keydown", this.handleKeyScrollIntent);
    this.scrollButton?.addEventListener("click", this.handleScrollButtonClick);
    const ownerWindow = getSurfaceOwnerWindow(this.viewport) as Window & {
      ResizeObserver?: typeof ResizeObserver;
    };
    if (typeof ownerWindow.ResizeObserver === "function") {
      this.resizeObserver = new ownerWindow.ResizeObserver(this.handleGeometryChange);
      this.resizeObserver.observe(this.viewport);
      this.resizeObserver.observe(this.content);
    }
    this.updateScrollButton();
  }

  public registerRow(rowId: string, element: HTMLElement): void {
    this.assertLive();
    const id = rowId.trim();
    if (!id) throw new Error("AnchoredScroller row id must be non-empty.");
    const existing = this.rows.get(id);
    if (existing && existing.element !== element) {
      throw new Error(`AnchoredScroller row ${id} is already registered to another element.`);
    }
    element.dataset.agentRowId = id;
    this.rows.set(id, {
      id,
      element,
    });
    this.updateScrollButton();
  }

  public unregisterRow(rowId: string): void {
    const row = this.rows.get(rowId);
    if (!row) return;
    this.rows.delete(rowId);
    if (row.element.dataset.agentRowId === rowId) delete row.element.dataset.agentRowId;
    this.updateScrollButton();
  }

  public notifyTurnStarted(): void {
    this.assertLive();
    // Starting another turn must not steal the viewport from someone reading
    // earlier content. End following resumes only after they return to the
    // bottom themselves or explicitly use the Latest control.
    if (this.mode === "manual" && !this.isNearEnd()) {
      this.updateScrollButton();
      return;
    }
    this.mode = "end";
    this.setScrollTop(this.maximumScrollTop(), "auto");
  }

  public notifyContentChanged(options: { streaming?: boolean } = {}): void {
    this.assertLive();
    this.setStreaming(options.streaming === true);
    if (this.mode === "end") {
      this.setScrollTop(this.maximumScrollTop(), "auto");
    }
    this.updateScrollButton();
  }

  /**
   * Reconciles an owned layout change, such as the composer growing, before a
   * browser-generated scroll event can be mistaken for manual reading.
   */
  public notifyViewportGeometryChanged(): void {
    this.assertLive();
    if (this.mode === "end") {
      this.setScrollTop(this.maximumScrollTop(), "auto");
    } else {
      this.updateScrollButton();
    }
  }

  public setStreaming(streaming: boolean): void {
    if (streaming) this.content.setAttribute("aria-busy", "true");
    else this.content.removeAttribute("aria-busy");
  }

  public capturePrependAnchor(): AnchoredScrollerPrependAnchor | null {
    this.assertLive();
    const viewportTop = finite(this.viewport.scrollTop);
    const candidates = [...this.rows.values()]
      .filter((row) => row.element.isConnected || row.element.parentElement === this.content)
      .sort((left, right) => this.rowTop(left) - this.rowTop(right));
    const firstVisible = candidates.find((row) => this.rowBottom(row) > viewportTop) ?? null;
    if (!firstVisible) return null;
    return Object.freeze({
      rowId: firstVisible.id,
      offsetFromViewportTop: this.rowTop(firstVisible) - viewportTop,
      mode: this.mode,
    });
  }

  public restorePrependAnchor(anchor: AnchoredScrollerPrependAnchor | null): void {
    this.assertLive();
    if (!anchor) {
      this.updateScrollButton();
      return;
    }
    const row = this.requireRow(anchor.rowId);
    this.mode = anchor.mode;
    if (anchor.mode === "end") {
      this.setScrollTop(this.maximumScrollTop(), "auto");
    } else {
      this.setScrollTop(this.rowTop(row) - finite(anchor.offsetFromViewportTop), "auto");
    }
    this.updateScrollButton();
  }

  public jumpTo(
    rowId: string,
    options: Readonly<{
      align?: "start" | "center" | "end";
      followEnd?: boolean;
    }> = {},
  ): void {
    this.assertLive();
    const row = this.requireRow(rowId);
    const rowTop = this.rowTop(row);
    const rowHeight = this.rowHeight(row);
    const viewportHeight = Math.max(0, finite(this.viewport.clientHeight));
    let target = rowTop;
    if (options.align === "center") target = rowTop - (viewportHeight - rowHeight) / 2;
    if (options.align === "end") target = rowTop + rowHeight - viewportHeight;
    this.mode = options.followEnd === true ? "end" : "manual";
    this.setScrollTop(target, "smooth");
  }

  public scrollToEnd(options: { smooth?: boolean } = {}): void {
    this.assertLive();
    this.mode = "end";
    this.setScrollTop(this.maximumScrollTop(), options.smooth === false ? "auto" : "smooth");
  }

  public getMode(): AnchoredScrollMode {
    return this.mode;
  }

  public isFollowingEnd(): boolean {
    return this.mode === "end";
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewport.removeEventListener("scroll", this.handleScroll);
    this.viewport.removeEventListener("wheel", this.handleScrollIntent);
    this.viewport.removeEventListener("touchmove", this.handleScrollIntent);
    this.viewport.removeEventListener("pointerdown", this.handlePointerDown);
    this.viewport.removeEventListener("keydown", this.handleKeyScrollIntent);
    this.scrollButton?.removeEventListener("click", this.handleScrollButtonClick);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.geometryFrame !== null) {
      cancelSurfaceAnimationFrame(this.viewport, this.geometryFrame);
      this.geometryFrame = null;
    }
    this.rows.clear();
    this.programmaticTarget = null;
  }

  private readonly handleScroll = (): void => {
    if (this.destroyed) return;
    const current = finite(this.viewport.scrollTop);
    if (this.programmaticTarget !== null) {
      if (Math.abs(current - this.programmaticTarget) <= 1) this.programmaticTarget = null;
      this.updateScrollButton();
      return;
    }
    if (this.isNearEnd()) {
      this.mode = "end";
    } else {
      this.mode = "manual";
    }
    this.updateScrollButton();
  };

  private readonly handleScrollIntent = (): void => {
    if (this.destroyed) return;
    this.programmaticTarget = null;
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.target === this.viewport) this.handleScrollIntent();
  };

  private readonly handleKeyScrollIntent = (event: KeyboardEvent): void => {
    if (![
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      " ",
    ].includes(event.key)) return;
    if (event.defaultPrevented || this.isInteractiveTarget(event.target)) return;
    this.handleScrollIntent();
  };

  private readonly handleGeometryChange: ResizeObserverCallback = (): void => {
    if (this.destroyed || this.geometryFrame !== null) return;
    this.geometryFrame = requestSurfaceAnimationFrame(this.viewport, () => {
      this.geometryFrame = null;
      if (this.destroyed) return;
      if (this.mode === "end") {
        this.setScrollTop(this.maximumScrollTop(), "auto");
      } else {
        this.updateScrollButton();
      }
    });
  };

  private readonly handleScrollButtonClick = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.scrollButton?.hasAttribute("inert")) return;
    this.scrollToEnd();
  };

  private requireRow(rowId: string): RegisteredRow {
    const row = this.rows.get(rowId);
    if (!row) throw new Error(`AnchoredScroller row ${rowId} is not registered.`);
    return row;
  }

  private rowTop(row: RegisteredRow): number {
    return finite(row.element.offsetTop);
  }

  private rowHeight(row: RegisteredRow): number {
    return Math.max(0, finite(row.element.offsetHeight));
  }

  private rowBottom(row: RegisteredRow): number {
    return this.rowTop(row) + this.rowHeight(row);
  }

  private maximumScrollTop(): number {
    return Math.max(0, finite(this.viewport.scrollHeight) - Math.max(0, finite(this.viewport.clientHeight)));
  }

  private isNearEnd(): boolean {
    return this.maximumScrollTop() - finite(this.viewport.scrollTop) <= this.endThreshold;
  }

  private setScrollTop(rawTarget: number, requestedBehavior: ScrollBehavior): void {
    const target = clamp(finite(rawTarget), 0, this.maximumScrollTop());
    const behavior = this.prefersReducedMotion() ? "auto" : requestedBehavior;
    if (Math.abs(finite(this.viewport.scrollTop) - target) <= 1) {
      this.programmaticTarget = null;
      this.updateScrollButton();
      return;
    }
    this.programmaticTarget = target;
    if (typeof this.viewport.scrollTo === "function") {
      this.viewport.scrollTo({ top: target, behavior });
    } else {
      this.viewport.scrollTop = target;
      this.programmaticTarget = null;
    }
    this.updateScrollButton();
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    const candidate = target as Partial<Element> | null;
    if (typeof candidate?.closest !== "function") return false;
    return candidate.closest([
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "option",
      "summary",
      "[contenteditable='true']",
      "[role='button']",
      "[role='checkbox']",
      "[role='link']",
      "[role='menuitem']",
      "[role='radio']",
      "[role='switch']",
      "[role='tab']",
    ].join(",")) !== null;
  }

  private prefersReducedMotion(): boolean {
    return typeof this.reducedMotion === "function"
      ? this.reducedMotion()
      : this.reducedMotion;
  }

  private updateScrollButton(): void {
    if (!this.scrollButton) return;
    const active = !this.isNearEnd();
    this.scrollButton.toggleAttribute("inert", !active);
    this.scrollButton.tabIndex = active ? 0 : -1;
    this.scrollButton.dataset.active = active ? "true" : "false";
    this.scrollButton.setAttribute("aria-hidden", active ? "false" : "true");
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error("AnchoredScroller has been destroyed.");
  }
}
