import { cancelStudioAnimationFrame, getStudioOwnerDocument, getStudioOwnerWindow, requestStudioAnimationFrame } from "./StudioDomContext";

/** Owns the visible lifetime of an anchored menu, including its owner-window resources. */
export class StudioMenuLifecycle {
  private frame: number | null = null;
  private listenerWindow: Window | null = null;
  private revision = 0;

  constructor(private readonly root: HTMLElement, private readonly dismiss: () => void) {
    this.hide();
  }

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
    this.listenerWindow = null;
  }
}
