import { errorLogger } from "../../utils/errorLogger";

export interface ScrollManagerConfig {
  container: HTMLElement;
  onAutoScrollChange?: (isAutoScroll: boolean) => void;
}

export type ScrollEventReason =
  | "init"
  | "dom-mutation"
  | "user-message"
  | "assistant-chunk"
  | "tool-call"
  | "resize"
  | "manual"
  | "restore"
  | "external";

export class ScrollManagerService {
  private readonly container: HTMLElement;
  private readonly onAutoScrollChange?: (isAutoScroll: boolean) => void;

  private autoScroll = true;
  private programmaticScroll = false;
  private isGenerating = false;

  private sentinel: HTMLElement;
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private mo: MutationObserver;

  private scheduledFrame: number | null = null;
  private pendingReason: ScrollEventReason = "init";
  private pendingImmediate = true;
  private destroyed = false;

  private readonly ANCHOR_EPSILON_PX = 24;

  constructor(config: ScrollManagerConfig) {
    this.container = config.container;
    this.onAutoScrollChange = config.onAutoScrollChange;

    this.initializeSentinel();
    this.initializeObservers();
    this.bindEvents();

    const shouldAutoScroll = this.isNearBottom();
    this.autoScroll = shouldAutoScroll;
    this.updateAutoScrollDataset();
    this.pendingImmediate = true;
    this.pendingReason = "init";
    this.applyReanchor("init", true);
  }

  public requestStickToBottom(reason: ScrollEventReason = "external", options: { immediate?: boolean } = {}): void {
    this.scheduleReanchor(reason, options.immediate ?? false);
  }

  public forceScrollToBottom(): void {
    this.cancelScheduledFrame();
    this.applyReanchor("manual", true);
  }

  public scrollToBottom(): void {
    this.cancelScheduledFrame();
    this.applyReanchor("manual", this.isGenerating);
  }

  public isAutoScrollEnabled(): boolean {
    return this.autoScroll;
  }

  public setGenerating(isGenerating: boolean): void {
    const prev = this.isGenerating;
    this.isGenerating = isGenerating;
    try {
      this.container.dataset.generating = this.isGenerating ? "true" : "false";
    } catch {}

    if (!isGenerating && prev) {
      this.scheduleReanchor("assistant-chunk", true);
    }
  }

  public getScrollState(): { scrollTop: number; isAtBottom: boolean } {
    return { scrollTop: this.container.scrollTop, isAtBottom: this.autoScroll };
  }

  public restoreScrollState(state: { scrollTop: number; isAtBottom: boolean }): void {
    if (state.isAtBottom) {
      this.applyReanchor("restore", true);
    } else {
      this.cancelScheduledFrame();
      this.programmaticScroll = true;
      this.container.scrollTop = state.scrollTop;
      setTimeout(() => {
        this.programmaticScroll = false;
      }, 16);
      this.setAutoScroll(false, { reason: "restore" });
    }
  }

  public updateContentHeight(): void {
    this.scheduleReanchor("dom-mutation", this.isGenerating);
  }

  public resetScrollState(): void {
    this.forceScrollToBottom();
  }

  public cleanup(): void {
    this.destroyed = true;
    this.cancelScheduledFrame();

    try { this.io.disconnect(); } catch {}
    try { this.ro.disconnect(); } catch {}
    try { this.mo.disconnect(); } catch {}
    try { this.container.removeEventListener("scroll", this.onUserScroll); } catch {}
    try { this.container.removeEventListener("systemsculpt-dom-content-changed" as any, this.onDomContentChanged); } catch {}
    try { window.removeEventListener("resize", this.onWindowResize); } catch {}
  }

  public destroy(): void {
    this.cleanup();
  }

  private initializeSentinel(): void {
    this.sentinel = document.createElement("div");
    this.sentinel.className = "systemsculpt-scroll-sentinel";
    this.sentinel.setAttribute("aria-hidden", "true");
    this.sentinel.style.cssText = "height:1px;width:100%;pointer-events:none;overflow-anchor:none;";
    this.container.appendChild(this.sentinel);
  }

  private initializeObservers(): void {
    this.io = new IntersectionObserver(this.onIntersection, {
      root: this.container,
      rootMargin: "0px 0px 64px 0px",
      threshold: 0,
    });
    this.io.observe(this.sentinel);

    this.ro = new ResizeObserver(() => {
      this.scheduleReanchor("resize", false);
    });
    this.ro.observe(this.container);

    this.mo = new MutationObserver(this.onMutations);
    this.mo.observe(this.container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private bindEvents(): void {
    this.container.addEventListener("scroll", this.onUserScroll, { passive: true });
    this.container.addEventListener("systemsculpt-dom-content-changed" as any, this.onDomContentChanged);
    window.addEventListener("resize", this.onWindowResize, { passive: true });
  }

  private onIntersection: IntersectionObserverCallback = (entries) => {
    if (this.destroyed) return;
    const entry = entries[0];
    const nearBottom = this.isNearBottom() || !!entry?.isIntersecting;
    this.setAutoScroll(nearBottom, { reason: "dom-mutation" });
  };

  private onMutations = (records: MutationRecord[]): void => {
    if (this.destroyed) return;
    if (!this.containsMeaningfulChanges(records)) return;
    const reason: ScrollEventReason = this.isGenerating ? "assistant-chunk" : "dom-mutation";
    this.scheduleReanchor(reason, this.isGenerating);
  };

  private onUserScroll = (): void => {
    if (this.destroyed || this.programmaticScroll) return;
    const nearBottom = this.isNearBottom();
    this.setAutoScroll(nearBottom, { reason: "manual" });
  };

  private onDomContentChanged = (): void => {
    if (this.destroyed) return;
    this.scheduleReanchor("dom-mutation", this.isGenerating);
  };

  private onWindowResize = (): void => {
    if (this.destroyed) return;
    this.scheduleReanchor("resize", false);
  };

  private containsMeaningfulChanges(records: MutationRecord[]): boolean {
    for (const record of records) {
      if (record.type === "childList") {
        if (this.hasMeaningfulNodes(record.addedNodes) || this.hasMeaningfulNodes(record.removedNodes)) {
          return true;
        }
      } else if (record.type === "characterData") {
        if (record.target === this.sentinel) continue;
        return true;
      }
    }
    return false;
  }

  private hasMeaningfulNodes(nodes: NodeList): boolean {
    for (const node of Array.from(nodes)) {
      if (node === this.sentinel) continue;
      if (node instanceof HTMLElement) {
        if (node.classList.contains("systemsculpt-scroll-sentinel")) continue;
        return true;
      }
      if (node instanceof Text) {
        return true;
      }
    }
    return false;
  }

  private scheduleReanchor(reason: ScrollEventReason, immediate: boolean): void {
    if (this.destroyed) return;

    this.pendingReason = reason;
    if (immediate) this.pendingImmediate = true;

    if (this.scheduledFrame != null) {
      return;
    }

    this.log("ScrollManager re-anchor scheduled", { reason, immediate });
    this.scheduledFrame = requestAnimationFrame(() => {
      this.scheduledFrame = null;
      const reasonToApply = this.pendingReason;
      const immediateToApply = this.pendingImmediate;
      this.pendingImmediate = false;
      this.applyReanchor(reasonToApply, immediateToApply || this.isGenerating);
    });
  }

  private cancelScheduledFrame(): void {
    if (this.scheduledFrame == null) return;
    cancelAnimationFrame(this.scheduledFrame);
    this.scheduledFrame = null;
  }

  private applyReanchor(reason: ScrollEventReason, immediate: boolean): void {
    if (this.destroyed) return;

    const previousAuto = this.autoScroll;
    this.setAutoScroll(true, { reason });
    this.ensureSentinel();

    if (immediate) {
      this.scrollToBottomImmediate();
    } else {
      this.scrollToBottomWithBehavior(this.isGenerating ? "auto" : "smooth");
    }

    this.log("ScrollManager applied re-anchor", {
      reason,
      immediate,
      wasAuto: previousAuto,
    });
  }

  private ensureSentinel(): void {
    if (this.container.lastElementChild !== this.sentinel) {
      this.container.appendChild(this.sentinel);
    }
  }

  private scrollToBottomImmediate(): void {
    this.programmaticScroll = true;
    this.ensureSentinel();
    this.container.scrollTop = this.container.scrollHeight;
    setTimeout(() => {
      this.programmaticScroll = false;
    }, 16);
  }

  private scrollToBottomWithBehavior(behavior: ScrollBehavior): void {
    this.programmaticScroll = true;
    this.ensureSentinel();
    this.container.scrollTo({ top: this.container.scrollHeight, behavior });
    const delay = behavior === "smooth" ? 250 : 16;
    setTimeout(() => {
      this.programmaticScroll = false;
    }, delay);
  }

  private isNearBottom(): boolean {
    try {
      const { scrollTop, scrollHeight, clientHeight } = this.container;
      const distance = scrollHeight - (scrollTop + clientHeight);
      return distance <= this.ANCHOR_EPSILON_PX;
    } catch {
      return true;
    }
  }

  private setAutoScroll(enabled: boolean, metadata?: { reason?: ScrollEventReason }): void {
    if (this.autoScroll === enabled) return;
    this.autoScroll = enabled;
    this.updateAutoScrollDataset();
    this.onAutoScrollChange?.(enabled);
    this.log("ScrollManager auto-scroll toggled", {
      enabled,
      reason: metadata?.reason,
    });
  }

  private updateAutoScrollDataset(): void {
    try {
      this.container.dataset.autoscroll = this.autoScroll ? "true" : "false";
    } catch {}
  }

  private log(message: string, metadata?: Record<string, unknown>): void {
    try {
      errorLogger.debug(message, {
        source: "ScrollManagerService",
        method: "scroll",
        metadata: {
          autoScroll: this.autoScroll,
          generating: this.isGenerating,
          scheduledFrame: this.scheduledFrame,
          ...metadata,
        },
      });
    } catch {}
  }
}
