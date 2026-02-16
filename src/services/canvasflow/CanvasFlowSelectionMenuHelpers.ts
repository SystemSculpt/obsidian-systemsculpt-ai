import { getCanvasNodeId } from "./CanvasDomAdapter";

export type CanvasFlowSelectedNodeResolver = {
  getSelectedNodeIdsFromInternalCanvas: (leafViewCanvas: any) => string[] | null;
  getSelectedNodeIdsFromDom: (root: HTMLElement) => string[];
};

export function dedupeStableStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const next = String(value || "").trim();
    if (!next) continue;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

export function getSelectedNodeIdsFromInternalCanvas(canvas: any): string[] | null {
  if (!canvas) return null;

  const tryExtract = (value: any): string[] | null => {
    if (!value) return null;

    const nested = value?.nodes ?? value?.items ?? value?.selected ?? value?.selection ?? null;
    if (nested && nested !== value) {
      const inner = tryExtract(nested);
      if (inner) return inner;
    }

    const ids: string[] = [];
    const pushMaybeId = (item: any) => {
      const id = String(item?.id || item?.node?.id || "").trim();
      if (id) ids.push(id);
    };

    try {
      if (typeof value?.[Symbol.iterator] === "function") {
        for (const item of value as any) {
          pushMaybeId(item);
        }
      } else if (typeof value?.forEach === "function") {
        value.forEach((item: any) => pushMaybeId(item));
      } else if (Array.isArray(value)) {
        value.forEach((item) => pushMaybeId(item));
      }
    } catch {
      return null;
    }

    const deduped = dedupeStableStrings(ids);
    return deduped.length ? deduped : null;
  };

  return (
    tryExtract(canvas.selection) ||
    tryExtract(canvas.selectionManager?.selection) ||
    tryExtract(canvas.selectionManager?.selected) ||
    tryExtract(canvas.selectionManager?.selectedNodes) ||
    null
  );
}

export function getSelectedNodeIdsFromDom(root: HTMLElement): string[] {
  const selectedEls = Array.from(root.querySelectorAll<HTMLElement>(".canvas-node.is-selected"));
  const ids = selectedEls.map(getCanvasNodeId).filter(Boolean) as string[];
  return dedupeStableStrings(ids);
}

export function findCanvasSelectionMenu(root: HTMLElement): HTMLElement | null {
  const doc = root.ownerDocument || document;

  const inRoot =
    root.querySelector<HTMLElement>(".canvas-menu-container .canvas-menu") ||
    root.querySelector<HTMLElement>(".canvas-menu");
  if (inRoot) return inRoot;

  const leafEl = root.closest<HTMLElement>(".workspace-leaf");
  if (leafEl) {
    const inLeaf =
      leafEl.querySelector<HTMLElement>(".canvas-menu-container .canvas-menu") ||
      leafEl.querySelector<HTMLElement>(".canvas-menu");
    if (inLeaf) return inLeaf;
  }

  const all = Array.from(doc.querySelectorAll<HTMLElement>(".canvas-menu"));
  const win = doc.defaultView || window;
  for (const el of all) {
    try {
      const style = win.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return el;
      }
    } catch {}
  }

  return all[0] || null;
}
