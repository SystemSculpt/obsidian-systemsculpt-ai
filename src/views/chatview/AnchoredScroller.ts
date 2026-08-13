import {
  cancelSurfaceAnimationFrame,
  getSurfaceOwnerDocument,
  getSurfaceOwnerWindow,
  requestSurfaceAnimationFrame,
} from "../../core/ui/surface/SurfaceDomContext";

export type AnchoredScrollMode = "end" | "manual";

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

type LayoutMutationAnchor = Readonly<{
  rowId: string;
  partKey: string | null;
  offsetFromViewportTop: number;
  rowOffsetFromViewportTop: number;
}>;

type DisclosureLayoutMutationAnchor = Readonly<{
  control: HTMLElement;
  focusKey: string | null;
  tagName: string;
  offsetFromViewportTop: number | null;
  fallback: LayoutMutationAnchor | null;
}>;

type ActiveLayoutMutation = {
  anchor: LayoutMutationAnchor | null;
  manualAnchorCaptured: boolean;
  readonly mode: AnchoredScrollMode;
  disclosureAnchor: DisclosureLayoutMutationAnchor | null;
  scrollIntentVersion: number;
  pendingFinishes: number;
};

type SubmittedPromptAnchor = Readonly<{
  rowId: string;
  offset: number;
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
  private scrollIntentVersion = 0;
  private lastKnownManualAnchor: LayoutMutationAnchor | null = null;
  private layoutMutation: ActiveLayoutMutation | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private geometryFrame: number | null = null;
  private geometryFrameIncludesContentResize = false;
  private geometryFrameContentScrollIntentVersion = 0;
  private readonly submittedPromptSpacer: SVGSVGElement;
  private submittedPromptSpacerHeight = 0;
  private submittedPromptAnchor: SubmittedPromptAnchor | null = null;
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
    // Intrinsic SVG height reserves prompt-follow space without inline styles.
    // eslint-disable-next-line obsidianmd/prefer-create-el
    this.submittedPromptSpacer = getSurfaceOwnerDocument(this.content).createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    this.submittedPromptSpacer.setAttribute("width", "0");
    this.submittedPromptSpacer.setAttribute("height", "0");
    this.submittedPromptSpacer.setAttribute("aria-hidden", "true");
    this.submittedPromptSpacer.setAttribute("focusable", "false");
    this.submittedPromptSpacer.setAttribute("data-agent-submitted-prompt-space", "");
    this.content.appendChild(this.submittedPromptSpacer);

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
    if (this.lastKnownManualAnchor?.rowId === rowId) {
      this.lastKnownManualAnchor = null;
    }
    if (row.element.dataset.agentRowId === rowId) delete row.element.dataset.agentRowId;
    this.updateScrollButton();
  }

  public notifyTurnStarted(options: Readonly<{
    submittedPromptRowId?: string;
    submittedPromptOffset?: number;
  }> = {}): void {
    this.assertLive();
    const submittedPromptRowId = options.submittedPromptRowId?.trim();
    if (submittedPromptRowId) {
      this.requireRow(submittedPromptRowId);
      this.submittedPromptAnchor = Object.freeze({
        rowId: submittedPromptRowId,
        offset: Math.max(0, finite(options.submittedPromptOffset ?? 16)),
      });
      this.mode = "end";
      this.lastKnownManualAnchor = null;
      this.maintainFollowPosition("smooth");
      return;
    }
    // Starting another turn must not steal the viewport from someone reading
    // earlier content. End following resumes only after they return to the
    // bottom themselves or explicitly use the Latest control.
    if (this.mode === "manual" && !this.isNearEnd()) {
      this.updateScrollButton();
      return;
    }
    this.clearSubmittedPromptAnchor();
    this.mode = "end";
    this.lastKnownManualAnchor = null;
    this.setScrollTop(this.maximumScrollTop(), "auto");
  }

  public clearSubmittedPromptAnchor(): void {
    this.assertLive();
    this.submittedPromptAnchor = null;
    this.setSubmittedPromptSpacerHeight(0);
    this.programmaticTarget = null;
    this.updateScrollButton();
  }

  /**
   * Reconciles an owned layout change, such as the composer growing, before a
   * browser-generated scroll event can be mistaken for manual reading.
   */
  public notifyViewportGeometryChanged(): void {
    this.assertLive();
    if (this.layoutMutation?.disclosureAnchor) {
      this.updateScrollButton();
      return;
    }
    if (this.mode === "end") {
      this.maintainFollowPosition("auto");
    } else {
      this.refreshLastKnownManualAnchor();
      this.updateScrollButton();
    }
  }

  public setStreaming(streaming: boolean): void {
    if (streaming) this.content.setAttribute("aria-busy", "true");
    else this.content.removeAttribute("aria-busy");
  }

  /**
   * Preserves scroll ownership across an owned DOM mutation. Call the returned
   * function after the mutation and after registering its current rows.
   *
   * Manual readers keep the first visible keyed part at the same pixel offset.
   * A response row remains the fallback when no visible keyed part survives.
   * End followers remain pinned to the exact end. User scroll input during an
   * asynchronous mutation takes ownership and cancels the pending restore.
   * Overlapping mutations share the outermost snapshot and restore only after
   * every returned function finishes. A connected target strictly below the
   * viewport cannot move earlier content, so manual readers skip the full row
   * scan for that mutation.
   */
  public beginLayoutMutation(target?: HTMLElement): () => void {
    this.assertLive();
    const mutationMode = this.layoutMutation?.mode ?? this.mode;
    const captureManualAnchor = mutationMode === "manual"
      && !this.isConnectedTargetStrictlyBelowViewport(target);
    return this.beginOwnedLayoutMutation(
      null,
      captureManualAnchor,
      target,
    );
  }

  /**
   * Preserves the activated disclosure control while its drawer changes the
   * transcript height. A disclosure interaction takes manual scroll ownership
   * so delayed resize delivery cannot pull the reader back to the end.
   */
  public beginDisclosureLayoutMutation(control: HTMLElement): () => void {
    this.assertLive();
    return this.beginOwnedLayoutMutation(
      this.captureDisclosureLayoutMutationAnchor(control),
      false,
    );
  }

  private beginOwnedLayoutMutation(
    disclosureAnchor: DisclosureLayoutMutationAnchor | null,
    captureManualAnchor: boolean,
    target?: HTMLElement,
  ): () => void {
    const mutation = this.layoutMutation ?? {
      anchor: this.mode === "manual" && captureManualAnchor
        ? this.captureLayoutMutationAnchor(target)
        : null,
      manualAnchorCaptured: this.mode === "manual" && captureManualAnchor,
      mode: this.mode,
      disclosureAnchor: null,
      scrollIntentVersion: this.scrollIntentVersion,
      pendingFinishes: 0,
    };
    if (
      this.layoutMutation
      && mutation.mode === "manual"
      && captureManualAnchor
      && !mutation.manualAnchorCaptured
    ) {
      mutation.anchor = this.captureLayoutMutationAnchor(target);
      mutation.manualAnchorCaptured = true;
    }
    if (disclosureAnchor) {
      mutation.disclosureAnchor = disclosureAnchor;
      mutation.scrollIntentVersion = this.scrollIntentVersion;
    }
    this.layoutMutation = mutation;
    mutation.pendingFinishes += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (this.layoutMutation !== mutation) return;
      mutation.pendingFinishes = Math.max(0, mutation.pendingFinishes - 1);
      if (mutation.pendingFinishes > 0) return;
      this.layoutMutation = null;
      if (mutation.scrollIntentVersion !== this.scrollIntentVersion) {
        this.updateScrollButton();
        return;
      }
      if (mutation.disclosureAnchor) {
        this.mode = "manual";
        if (this.restoreDisclosureLayoutMutationAnchor(mutation.disclosureAnchor)) {
          this.refreshLastKnownManualAnchor();
          return;
        }
        if (this.restoreLayoutMutationAnchor(mutation.disclosureAnchor.fallback)) {
          this.refreshLastKnownManualAnchor();
          return;
        }
        this.programmaticTarget = null;
        this.refreshLastKnownManualAnchor();
        this.updateScrollButton();
        return;
      }
      this.mode = mutation.mode;
      if (mutation.mode === "end") {
        this.lastKnownManualAnchor = null;
        this.maintainFollowPosition("auto");
        return;
      }
      if (this.restoreLayoutMutationAnchor(mutation.anchor)) {
        this.refreshLastKnownManualAnchor(mutation.anchor);
        return;
      }
      this.programmaticTarget = null;
      if (mutation.manualAnchorCaptured) {
        this.refreshLastKnownManualAnchor();
      }
      this.updateScrollButton();
    };
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
    if (this.mode === "end") this.lastKnownManualAnchor = null;
    this.setScrollTop(target, "smooth");
  }

  public scrollToEnd(options: { smooth?: boolean } = {}): void {
    this.assertLive();
    this.clearSubmittedPromptAnchor();
    this.mode = "end";
    this.lastKnownManualAnchor = null;
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
    this.submittedPromptAnchor = null;
    this.submittedPromptSpacer.remove();
    this.submittedPromptSpacerHeight = 0;
    this.programmaticTarget = null;
    this.lastKnownManualAnchor = null;
    this.layoutMutation = null;
    this.geometryFrameIncludesContentResize = false;
  }

  private readonly handleScroll = (): void => {
    if (this.destroyed) return;
    const current = finite(this.viewport.scrollTop);
    if (this.programmaticTarget !== null) {
      if (Math.abs(current - this.programmaticTarget) <= 1) {
        this.programmaticTarget = null;
      }
      this.updateScrollButton();
      return;
    }
    if (this.isNearEnd()) {
      this.mode = "end";
      this.lastKnownManualAnchor = null;
    } else {
      this.mode = "manual";
    }
    this.updateScrollButton();
  };

  private readonly handleScrollIntent = (): void => {
    if (this.destroyed) return;
    this.programmaticTarget = null;
    this.scrollIntentVersion += 1;
    this.lastKnownManualAnchor = null;
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

  private readonly handleGeometryChange: ResizeObserverCallback = (entries): void => {
    if (this.destroyed) return;
    const includesContentResize = entries.length === 0
      || entries.some((entry) => entry.target === this.content);
    if (includesContentResize && !this.geometryFrameIncludesContentResize) {
      this.geometryFrameIncludesContentResize = true;
      this.geometryFrameContentScrollIntentVersion = this.scrollIntentVersion;
    }
    if (this.geometryFrame !== null) return;
    this.geometryFrame = requestSurfaceAnimationFrame(this.viewport, () => {
      this.geometryFrame = null;
      if (this.destroyed) return;
      const restoreManualAnchor = this.geometryFrameIncludesContentResize;
      const resizeScrollIntentVersion = this.geometryFrameContentScrollIntentVersion;
      this.geometryFrameIncludesContentResize = false;
      if (this.layoutMutation?.disclosureAnchor) {
        this.updateScrollButton();
        return;
      }
      if (this.mode === "end") {
        this.lastKnownManualAnchor = null;
        this.maintainFollowPosition("auto");
        return;
      }
      if (
        restoreManualAnchor
        && !this.layoutMutation
        && resizeScrollIntentVersion === this.scrollIntentVersion
      ) {
        this.restoreLayoutMutationAnchor(this.lastKnownManualAnchor);
        this.refreshLastKnownManualAnchor(this.lastKnownManualAnchor);
      }
      this.updateScrollButton();
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

  private firstVisibleRow(): RegisteredRow | null {
    const viewportTop = finite(this.viewport.scrollTop);
    const viewportBottom = viewportTop + Math.max(0, finite(this.viewport.clientHeight));
    let firstVisible: RegisteredRow | null = null;
    let firstVisibleTop = Number.POSITIVE_INFINITY;
    for (const row of this.rows.values()) {
      if (!this.isRegisteredRowAvailable(row)) continue;
      const top = this.rowTop(row);
      if (
        top >= firstVisibleTop
        || this.rowBottom(row) <= viewportTop
        || top >= viewportBottom
      ) {
        continue;
      }
      firstVisible = row;
      firstVisibleTop = top;
    }
    return firstVisible;
  }

  private refreshLastKnownManualAnchor(
    preferredAnchor?: LayoutMutationAnchor | null,
  ): void {
    if (this.mode !== "manual") {
      this.lastKnownManualAnchor = null;
      return;
    }
    const preferredRow = preferredAnchor
      ? this.rows.get(preferredAnchor.rowId)
      : null;
    if (preferredRow && this.isRegisteredRowAvailable(preferredRow) && this.isRowVisible(preferredRow)) {
      const preferredPart = preferredAnchor?.partKey
        ? this.keyedPart(preferredRow, preferredAnchor.partKey)
        : null;
      const preferredPartOffset = preferredPart
        ? this.visibleElementViewportOffset(preferredPart)
        : null;
      this.lastKnownManualAnchor = this.captureRowLayoutMutationAnchor(
        preferredRow,
        preferredPartOffset === null || !preferredAnchor?.partKey
          ? this.firstVisibleKeyedPart(preferredRow)
          : {
            key: preferredAnchor.partKey,
            offsetFromViewportTop: preferredPartOffset,
          },
      );
      return;
    }
    this.lastKnownManualAnchor = this.captureLayoutMutationAnchor();
  }

  private captureLayoutMutationAnchor(target?: HTMLElement): LayoutMutationAnchor | null {
    const targetAnchor = target
      ? this.captureTargetLayoutMutationAnchor(target)
      : null;
    if (targetAnchor) return targetAnchor;
    const row = this.firstVisibleRow();
    if (!row) return null;
    return this.captureRowLayoutMutationAnchor(row, this.firstVisibleKeyedPart(row));
  }

  private captureTargetLayoutMutationAnchor(
    target: HTMLElement,
  ): LayoutMutationAnchor | null {
    if (!target.isConnected || !this.content.contains(target)) return null;
    const row = this.registeredRowContaining(target) ?? this.registeredRowWithin(target);
    if (!row || !this.isRowVisible(row)) return null;
    const containingPart = target.closest<HTMLElement>("[data-part-key]");
    if (containingPart && row.element.contains(containingPart)) {
      const key = containingPart.dataset.partKey?.trim();
      const offsetFromViewportTop = this.visibleElementViewportOffset(containingPart);
      if (key && offsetFromViewportTop !== null) {
        return this.captureRowLayoutMutationAnchor(row, {
          key,
          offsetFromViewportTop,
        });
      }
    }
    return this.captureRowLayoutMutationAnchor(row, this.firstVisibleKeyedPart(row));
  }

  private captureDisclosureLayoutMutationAnchor(
    control: HTMLElement,
  ): DisclosureLayoutMutationAnchor {
    const row = this.registeredRowContaining(control);
    const containingPart = row
      ? control.closest<HTMLElement>("[data-part-key]")
      : null;
    const fallback = row
      ? this.captureRowLayoutMutationAnchor(
        row,
        containingPart && row.element.contains(containingPart)
          ? {
            key: containingPart.dataset.partKey?.trim() ?? "",
            offsetFromViewportTop: this.elementViewportOffset(containingPart)
              ?? this.rowTop(row) - finite(this.viewport.scrollTop),
          }
          : null,
      )
      : this.captureLayoutMutationAnchor();
    return Object.freeze({
      control,
      focusKey: control.dataset.focusKey?.trim() || null,
      tagName: control.tagName,
      offsetFromViewportTop: this.visibleElementViewportOffset(control),
      fallback,
    });
  }

  private captureRowLayoutMutationAnchor(
    row: RegisteredRow,
    part: Readonly<{ key: string; offsetFromViewportTop: number }> | null,
  ): LayoutMutationAnchor {
    const viewportTop = finite(this.viewport.scrollTop);
    const rowOffsetFromViewportTop = this.rowTop(row) - viewportTop;
    return Object.freeze({
      rowId: row.id,
      partKey: part?.key || null,
      offsetFromViewportTop: part?.offsetFromViewportTop ?? rowOffsetFromViewportTop,
      rowOffsetFromViewportTop,
    });
  }

  private registeredRowContaining(element: HTMLElement): RegisteredRow | null {
    const rowElement = element.closest<HTMLElement>("[data-agent-row-id]");
    const rowId = rowElement?.dataset.agentRowId?.trim();
    if (!rowElement || !rowId) return null;
    const row = this.rows.get(rowId);
    return row?.element === rowElement && this.isRegisteredRowAvailable(row) ? row : null;
  }

  private registeredRowWithin(element: HTMLElement): RegisteredRow | null {
    const rows = Array.from(
      element.querySelectorAll<HTMLElement>("[data-agent-row-id]"),
    ).map((rowElement) => {
      const rowId = rowElement.dataset.agentRowId?.trim();
      const row = rowId ? this.rows.get(rowId) : null;
      return row?.element === rowElement && this.isRegisteredRowAvailable(row) ? row : null;
    }).filter((row): row is RegisteredRow => row !== null);
    return rows.length === 1 ? rows[0]! : null;
  }

  private restoreDisclosureLayoutMutationAnchor(
    anchor: DisclosureLayoutMutationAnchor,
  ): boolean {
    if (anchor.offsetFromViewportTop === null) return false;
    const control = this.resolveDisclosureControl(anchor);
    if (!control) return false;
    const currentOffset = this.elementViewportOffset(control);
    if (currentOffset === null) return false;
    this.setScrollTop(
      finite(this.viewport.scrollTop) + currentOffset - anchor.offsetFromViewportTop,
      "auto",
    );
    return true;
  }

  private resolveDisclosureControl(
    anchor: DisclosureLayoutMutationAnchor,
  ): HTMLElement | null {
    if (this.content.contains(anchor.control)) return anchor.control;
    if (!anchor.focusKey || !anchor.fallback) return null;
    const row = this.rows.get(anchor.fallback.rowId);
    if (!row || !this.isRegisteredRowAvailable(row)) return null;
    const part = anchor.fallback.partKey
      ? this.keyedPart(row, anchor.fallback.partKey)
      : null;
    const scope = part ?? row.element;
    const matches = Array.from(
      scope.querySelectorAll<HTMLElement>("[data-focus-key]"),
    ).filter((candidate) =>
      candidate.dataset.focusKey === anchor.focusKey
      && candidate.tagName === anchor.tagName,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  private restoreLayoutMutationAnchor(anchor: LayoutMutationAnchor | null): boolean {
    const row = anchor ? this.rows.get(anchor.rowId) : null;
    if (!anchor || !row || !this.isRegisteredRowAvailable(row)) return false;
    const partOffset = anchor.partKey
      ? this.keyedPartViewportOffset(row, anchor.partKey)
      : null;
    const target = partOffset === null
      ? this.rowTop(row) - finite(anchor.rowOffsetFromViewportTop)
      : finite(this.viewport.scrollTop)
        + partOffset
        - finite(anchor.offsetFromViewportTop);
    this.setScrollTop(target, "auto");
    return true;
  }

  private elementViewportOffset(element: HTMLElement): number | null {
    const rect = element.getBoundingClientRect();
    const top = rect.top;
    const bottom = finite(rect.bottom, top + Math.max(0, finite(rect.height)));
    const viewportTop = this.viewport.getBoundingClientRect().top;
    if (!Number.isFinite(top) || !Number.isFinite(viewportTop) || bottom <= top) return null;
    return top - viewportTop;
  }

  private isConnectedTargetStrictlyBelowViewport(
    target: HTMLElement | undefined,
  ): boolean {
    if (!target?.isConnected || !this.content.contains(target)) return false;
    try {
      const targetTop = target.getBoundingClientRect().top;
      const viewportBottom = this.viewport.getBoundingClientRect().bottom;
      return Number.isFinite(targetTop)
        && Number.isFinite(viewportBottom)
        && targetTop > viewportBottom;
    } catch {
      return false;
    }
  }

  private isRowVisible(row: RegisteredRow): boolean {
    const viewportTop = finite(this.viewport.scrollTop);
    const viewportBottom = viewportTop + Math.max(0, finite(this.viewport.clientHeight));
    const rowTop = this.rowTop(row);
    return this.rowBottom(row) > viewportTop && rowTop < viewportBottom;
  }

  private visibleElementViewportOffset(element: HTMLElement): number | null {
    const offset = this.elementViewportOffset(element);
    if (offset === null) return null;
    const height = Math.max(0, finite(element.getBoundingClientRect().height));
    const viewportHeight = Math.max(0, finite(this.viewport.clientHeight));
    return offset + height > 0 && offset < viewportHeight ? offset : null;
  }

  private firstVisibleKeyedPart(
    row: RegisteredRow,
  ): Readonly<{ key: string; offsetFromViewportTop: number }> | null {
    const viewportRect = this.viewport.getBoundingClientRect();
    const viewportTop = finite(viewportRect.top);
    const viewportBottom = viewportTop + Math.max(0, finite(this.viewport.clientHeight));
    let first: Readonly<{
      key: string;
      offsetFromViewportTop: number;
    }> | null = null;
    let firstTop = Number.POSITIVE_INFINITY;
    for (const part of row.element.querySelectorAll<HTMLElement>("[data-part-key]")) {
      const key = part.dataset.partKey?.trim();
      if (!key) continue;
      const rect = part.getBoundingClientRect();
      const top = finite(rect.top, Number.POSITIVE_INFINITY);
      const bottom = finite(rect.bottom, top + Math.max(0, finite(rect.height)));
      if (
        top >= firstTop
        || bottom <= top
        || bottom <= viewportTop
        || top >= viewportBottom
      ) {
        continue;
      }
      first = {
        key,
        offsetFromViewportTop: top - viewportTop,
      };
      firstTop = top;
    }
    return first;
  }

  private keyedPartViewportOffset(row: RegisteredRow, partKey: string): number | null {
    const part = this.keyedPart(row, partKey);
    if (!part || !row.element.contains(part)) return null;
    const rect = part.getBoundingClientRect();
    const top = finite(rect.top, Number.POSITIVE_INFINITY);
    const bottom = finite(rect.bottom, top + Math.max(0, finite(rect.height)));
    if (bottom <= top) return null;
    return top - finite(this.viewport.getBoundingClientRect().top);
  }

  private keyedPart(row: RegisteredRow, partKey: string): HTMLElement | null {
    return Array.from(
      row.element.querySelectorAll<HTMLElement>("[data-part-key]"),
    ).find((candidate) => candidate.dataset.partKey === partKey) ?? null;
  }

  private isRegisteredRowAvailable(row: RegisteredRow): boolean {
    return row.element.isConnected || row.element.parentElement === this.content;
  }

  private maximumScrollTop(): number {
    return Math.max(0, finite(this.viewport.scrollHeight) - Math.max(0, finite(this.viewport.clientHeight)));
  }

  private maintainFollowPosition(behavior: ScrollBehavior): void {
    const anchor = this.submittedPromptAnchor;
    const row = anchor ? this.rows.get(anchor.rowId) : null;
    if (!anchor || !row || !this.isRegisteredRowAvailable(row)) {
      this.setScrollTop(this.maximumScrollTop(), behavior);
      return;
    }
    const promptTarget = Math.max(0, this.rowTop(row) - anchor.offset);
    const viewportHeight = Math.max(0, finite(this.viewport.clientHeight));
    const realScrollHeight = Math.max(
      0,
      finite(this.viewport.scrollHeight) - this.submittedPromptSpacerHeight,
    );
    const realMaximum = Math.max(0, realScrollHeight - viewportHeight);
    this.setSubmittedPromptSpacerHeight(
      Math.max(0, promptTarget + viewportHeight - realScrollHeight),
    );
    this.setScrollTop(Math.max(promptTarget, realMaximum), behavior);
  }

  private setSubmittedPromptSpacerHeight(height: number): void {
    const next = Math.max(0, finite(height));
    if (Math.abs(next - this.submittedPromptSpacerHeight) <= 1) return;
    this.submittedPromptSpacerHeight = next;
    this.submittedPromptSpacer.setAttribute("height", String(next));
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
    if (
      this.programmaticTarget !== null
      && Math.abs(this.programmaticTarget - target) <= 1
    ) {
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
