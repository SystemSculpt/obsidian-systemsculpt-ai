export type CanvasNodeElementInfo = {
  el: HTMLElement;
  nodeId: string;
};

function isHTMLElement(value: unknown): value is HTMLElement {
  const v: any = value as any;
  return !!v && typeof v === "object" && v.nodeType === 1 && typeof v.classList !== "undefined";
}

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
  const contentEl = nodeEl.querySelector<HTMLElement>(".canvas-node-content") || null;
  const containerEl = nodeEl.querySelector<HTMLElement>(".canvas-node-container") || null;

  // Obsidian 1.11+ file nodes render as a `markdown-embed` inside `.canvas-node-content`.
  // Markdown embed CSS can hide unexpected direct children, so inject into the outer container when present.
  if (containerEl && contentEl?.classList?.contains?.("markdown-embed")) {
    return containerEl;
  }

  return contentEl || containerEl || nodeEl;
}

function toNodeList(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return Array.from(value.values());

  try {
    if (typeof value?.values === "function") {
      const vals = Array.from(value.values());
      if (vals.length) return vals;
    }
  } catch {}

  try {
    if (typeof value?.[Symbol.iterator] === "function") {
      const vals = Array.from(value as any);
      if (vals.length) return vals;
    }
  } catch {}

  if (typeof value === "object") {
    try {
      return Object.values(value);
    } catch {}
  }

  return [];
}

function findAnyHTMLElementInObject(obj: any): HTMLElement | null {
  if (!obj || typeof obj !== "object") return null;
  try {
    for (const value of Object.values(obj)) {
      if (isHTMLElement(value)) return value;
    }
  } catch {}
  return null;
}

function extractCanvasNodes(canvas: any): any[] {
  const candidates = [
    canvas?.nodes,
    canvas?.nodeMap,
    canvas?.nodesMap,
    canvas?.data?.nodes,
    canvas?.store?.nodes,
    canvas?.renderer?.nodes,
    canvas?.view?.nodes,
    canvas?.graph?.nodes,
  ];

  for (const candidate of candidates) {
    const nodes = toNodeList(candidate);
    if (!nodes.length) continue;
    const hasId = nodes.some((n) => String(n?.id || n?.node?.id || n?.data?.id || "").trim());
    if (hasId) return nodes;
  }

  return [];
}

function guessInternalNodeId(node: any): string {
  return String(node?.id || node?.node?.id || node?.data?.id || "").trim();
}

function guessInternalNodeElement(node: any): HTMLElement | null {
  const candidates = [
    node?.nodeEl,
    node?.el,
    node?.containerEl,
    node?.contentEl,
    node?.outerEl,
    node?.domEl,
    node?.node?.nodeEl,
    node?.node?.el,
    node?.node?.containerEl,
    node?.node?.contentEl,
  ];

  for (const candidate of candidates) {
    if (isHTMLElement(candidate)) return candidate;
  }

  try {
    if (typeof node?.getEl === "function") {
      const el = node.getEl();
      if (isHTMLElement(el)) return el;
    }
  } catch {}

  return findAnyHTMLElementInObject(node) || findAnyHTMLElementInObject(node?.dom) || findAnyHTMLElementInObject(node?.view);
}

export function findCanvasNodeElementsFromInternalCanvas(canvas: any, root?: HTMLElement): CanvasNodeElementInfo[] {
  const nodes = extractCanvasNodes(canvas);
  if (!nodes.length) return [];

  const out: CanvasNodeElementInfo[] = [];
  for (const node of nodes) {
    const nodeId = guessInternalNodeId(node);
    if (!nodeId) continue;

    const rawEl = guessInternalNodeElement(node);
    if (!rawEl) continue;

    const nodeEl =
      rawEl.classList?.contains?.("canvas-node") ? rawEl : ((rawEl.closest?.(".canvas-node") as HTMLElement | null) || null);
    if (!nodeEl) continue;
    if (root && !root.contains(nodeEl)) continue;

    out.push({ el: nodeEl, nodeId });
  }

  const deduped = new Map<string, CanvasNodeElementInfo>();
  for (const item of out) {
    if (!deduped.has(item.nodeId)) {
      deduped.set(item.nodeId, item);
    }
  }
  return Array.from(deduped.values());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tryCall(obj: any, methodName: string, ...args: any[]): boolean {
  try {
    const fn = obj?.[methodName];
    if (typeof fn !== "function") return false;
    fn.apply(obj, args);
    return true;
  } catch {
    return false;
  }
}

export function trySetInternalCanvasNodeSize(canvas: any, nodeId: string, width: number, height: number): boolean {
  const id = String(nodeId || "").trim();
  if (!id) return false;
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;

  const nodes = extractCanvasNodes(canvas);
  const internal = nodes.find((n) => guessInternalNodeId(n) === id) || null;
  if (!internal) return false;

  const targets: any[] = [internal];
  const nestedKeys = ["node", "data", "model", "view", "store", "graphNode", "inner", "state", "props"];
  for (const key of nestedKeys) {
    const v = (internal as any)?.[key];
    if (isRecord(v)) targets.push(v);
  }

  let didSomething = false;
  for (const t of targets) {
    // Common method shapes for internal Canvas node objects.
    didSomething = tryCall(t, "setSize", w, h) || didSomething;
    didSomething = tryCall(t, "setDimensions", w, h) || didSomething;
    didSomething = tryCall(t, "resize", w, h) || didSomething;
    didSomething = tryCall(t, "setRect", w, h) || didSomething;
    didSomething = tryCall(t, "setBounds", w, h) || didSomething;

    didSomething = tryCall(t, "setSize", { width: w, height: h }) || didSomething;
    didSomething = tryCall(t, "setDimensions", { width: w, height: h }) || didSomething;
    didSomething = tryCall(t, "resize", { width: w, height: h }) || didSomething;

    // Property assignment fallbacks.
    try {
      if (typeof t?.width === "number") {
        t.width = w;
        didSomething = true;
      }
    } catch {}
    try {
      if (typeof t?.height === "number") {
        t.height = h;
        didSomething = true;
      }
    } catch {}
    try {
      if (typeof t?.w === "number") {
        t.w = w;
        didSomething = true;
      }
    } catch {}
    try {
      if (typeof t?.h === "number") {
        t.h = h;
        didSomething = true;
      }
    } catch {}
    try {
      if (isRecord(t?.size)) {
        (t.size as any).width = w;
        (t.size as any).height = h;
        didSomething = true;
      }
    } catch {}
  }

  // Nudge a re-render/save if the internal Canvas implementation exposes hooks.
  const canvasTargets: any[] = [canvas, canvas?.renderer, canvas?.view, canvas?.store, canvas?.graph];
  for (const ct of canvasTargets) {
    if (!ct) continue;
    tryCall(ct, "requestRender");
    tryCall(ct, "requestFrame");
    tryCall(ct, "render");
    tryCall(ct, "requestSave");
    tryCall(ct, "save");
    tryCall(ct, "scheduleSave");
  }

  return didSomething;
}
