export type CanvasNodeElementInfo = {
  el: HTMLElement;
  nodeId: string;
};

function readAttr(el: HTMLElement, name: string): string | null {
  const v = el.getAttribute(name);
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getCanvasNodeId(el: HTMLElement): string | null {
  const ds: any = (el as any).dataset || {};
  const fromDataset = typeof ds.nodeId === "string" ? ds.nodeId.trim() : "";
  if (fromDataset) return fromDataset;

  const dataNodeId = readAttr(el, "data-node-id");
  if (dataNodeId) return dataNodeId;

  const dataId = readAttr(el, "data-id");
  if (dataId) return dataId;

  const idAttr = readAttr(el, "id");
  if (idAttr && idAttr.startsWith("canvas-node-")) {
    return idAttr.slice("canvas-node-".length);
  }

  return null;
}

export function findCanvasNodeElements(root: HTMLElement): CanvasNodeElementInfo[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(".canvas-node"));
  const out: CanvasNodeElementInfo[] = [];
  for (const el of candidates) {
    const nodeId = getCanvasNodeId(el);
    if (!nodeId) continue;
    out.push({ el, nodeId });
  }
  return out;
}

export function findCanvasNodeContentHost(nodeEl: HTMLElement): HTMLElement {
  // Obsidian Canvas DOM isn't stable public API. Keep these selectors centralized.
  const content =
    nodeEl.querySelector<HTMLElement>(".canvas-node-content") ||
    nodeEl.querySelector<HTMLElement>(".canvas-node-container") ||
    nodeEl;
  return content;
}

