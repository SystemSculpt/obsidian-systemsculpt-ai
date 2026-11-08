import { cancelStudioAnimationFrame, getStudioOwnerDocument, getStudioOwnerWindow, requestStudioAnimationFrame } from "./StudioDomContext";

/** Owns the visible lifetime of an anchored menu, including its owner-window resources. */
export class StudioMenuLifecycle {
  private frame: number | null = null;
  private listenerWindow: Window | null = null;
  private listenerVisualViewport: VisualViewport | null = null;
  private viewportObserver: ResizeObserver | null = null;
  private revision = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly dismiss: () => void,
    private readonly relayout?: () => void
  ) {
    this.hide();
  }

  private readonly onViewportResize = (): void => {
    if (this.relayout) this.relayout();
    else this.dismiss();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.root.contains(event.target as Node | null)) this.dismiss();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.dismiss();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.root.contains(event.target as Node | null)) event.preventDefault();
    else this.dismiss();
  };

  show(afterPaint: () => void): void {
    this.clearResources();
    const revision = this.revision;
    this.root.setCssStyles({ display: "flex" });
    this.root.removeAttribute("inert");
    this.root.setAttribute("aria-hidden", "false");
    const ownerWindow = getStudioOwnerWindow(this.root);
    this.listenerWindow = ownerWindow;
    ownerWindow.addEventListener("pointerdown", this.onPointerDown, true);
    ownerWindow.addEventListener("keydown", this.onKeyDown, true);
    ownerWindow.addEventListener("contextmenu", this.onContextMenu, true);
    ownerWindow.addEventListener("resize", this.onViewportResize);
    this.listenerVisualViewport = ownerWindow.visualViewport;
    this.listenerVisualViewport?.addEventListener("resize", this.onViewportResize);
    const viewport = this.root.parentElement;
    const Observer = (ownerWindow as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (viewport && typeof Observer === "function") {
      let previousSize = { width: viewport.clientWidth, height: viewport.clientHeight };
      this.viewportObserver = new Observer(() => {
        if (revision !== this.revision) return;
        const size = { width: viewport.clientWidth, height: viewport.clientHeight };
        // Ignore the matching initial delivery, but not a resize before it arrives.
        const changed = size.width !== previousSize.width || size.height !== previousSize.height;
        previousSize = size;
        if (changed) this.onViewportResize();
      });
      this.viewportObserver.observe(viewport);
    }
    this.frame = requestStudioAnimationFrame(this.root, () => {
      if (revision !== this.revision) return;
      this.frame = null;
      afterPaint();
    });
  }

  hide(): void {
    this.clearResources();
    const activeElement = getStudioOwnerDocument(this.root).activeElement as HTMLElement | null;
    if (activeElement && this.root.contains(activeElement)) activeElement.blur?.();
    this.root.setCssStyles({ display: "none" });
    this.root.setAttribute("inert", "");
    this.root.setAttribute("aria-hidden", "true");
  }

  private clearResources(): void {
    this.revision += 1;
    if (this.frame !== null) cancelStudioAnimationFrame(this.root, this.frame);
    this.frame = null;
    this.listenerWindow?.removeEventListener("pointerdown", this.onPointerDown, true);
    this.listenerWindow?.removeEventListener("keydown", this.onKeyDown, true);
    this.listenerWindow?.removeEventListener("contextmenu", this.onContextMenu, true);
    this.listenerWindow?.removeEventListener("resize", this.onViewportResize);
    this.listenerVisualViewport?.removeEventListener("resize", this.onViewportResize);
    this.listenerVisualViewport = null;
    this.viewportObserver?.disconnect();
    this.viewportObserver = null;
    this.listenerWindow = null;
  }
}
