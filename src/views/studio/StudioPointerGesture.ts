import { getStudioOwnerWindow } from "./StudioDomContext";

/** The latest sample in a coalesced pointer event, retaining the original when unsupported. */
export function latestStudioPointerEvent(event: PointerEvent): PointerEvent {
  if (typeof event.getCoalescedEvents !== "function") return event;
  const samples = event.getCoalescedEvents();
  return Array.isArray(samples) && samples.length > 0 ? samples[samples.length - 1] : event;
}

/**
 * One captured pointer and one pending frame. Finishing flushes the last move;
 * disposal drops it. Both release every listener before notifying the owner.
 */
export function startStudioPointerGesture(options: {
  element: HTMLElement;
  event: PointerEvent;
  onMove: (event: PointerEvent) => void;
  onFrame: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onKeyChange?: (event: KeyboardEvent) => boolean;
}): () => void {
  const { element, event, onMove, onFrame, onFinish, onCancel, onKeyChange } = options;
  const ownerWindow = getStudioOwnerWindow(element);
  const pointerId = event.pointerId;
  let frame: number | null = null;
  let active = true;
  const flush = (): void => {
    frame = null;
    if (active) onFrame();
  };
  const schedule = (): void => {
    if (!active || frame !== null) return;
    if (typeof ownerWindow.requestAnimationFrame !== "function") { flush(); return; }
    let synchronous = false;
    const id = ownerWindow.requestAnimationFrame(() => { synchronous = true; flush(); });
    if (!synchronous) frame = id;
  };
  const move = (next: PointerEvent): void => {
    if (!active || next.pointerId !== pointerId) return;
    onMove(next);
    schedule();
  };
  const key = (next: KeyboardEvent): void => { if (onKeyChange?.(next)) schedule(); };
  const cleanup = (): void => {
    active = false;
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    frame = null;
    ownerWindow.removeEventListener("pointermove", move);
    ownerWindow.removeEventListener("pointerup", finish);
    ownerWindow.removeEventListener("pointercancel", finish);
    ownerWindow.removeEventListener("keydown", key);
    ownerWindow.removeEventListener("keyup", key);
    try { element.releasePointerCapture?.(pointerId); } catch { /* Detached pointer. */ }
  };
  const finish = (next: PointerEvent): void => {
    if (!active || next.pointerId !== pointerId) return;
    try {
      if (frame !== null) {
        ownerWindow.cancelAnimationFrame(frame);
        flush();
      }
    } finally { cleanup(); }
    onFinish();
  };
  try { element.setPointerCapture?.(pointerId); } catch { /* Window listeners are the fallback. */ }
  ownerWindow.addEventListener("pointermove", move);
  ownerWindow.addEventListener("pointerup", finish);
  ownerWindow.addEventListener("pointercancel", finish);
  if (onKeyChange) {
    ownerWindow.addEventListener("keydown", key);
    ownerWindow.addEventListener("keyup", key);
  }
  return () => {
    if (!active) return;
    cleanup();
    onCancel();
  };
}
