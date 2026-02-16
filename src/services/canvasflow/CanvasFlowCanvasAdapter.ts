import type { WorkspaceLeaf } from "obsidian";
import {
  findCanvasNodeContentHost,
  findCanvasNodeElements,
  findCanvasNodeElementsFromInternalCanvas,
  trySetInternalCanvasNodeSize,
  type CanvasNodeElementInfo,
} from "./CanvasDomAdapter";
import { getSelectedNodeIdsFromDom, getSelectedNodeIdsFromInternalCanvas } from "./CanvasFlowSelectionMenuHelpers";

function isHTMLElement(value: unknown): value is HTMLElement {
  const v: any = value as any;
  return !!v && typeof v === "object" && v.nodeType === 1 && typeof v.classList !== "undefined";
}

function dedupeNodeInfos(items: CanvasNodeElementInfo[]): CanvasNodeElementInfo[] {
  const seen = new Set<string>();
  const out: CanvasNodeElementInfo[] = [];
  for (const item of items) {
    const id = String(item?.nodeId || "").trim();
    if (!id || seen.has(id)) continue;
    if (!isHTMLElement(item?.el)) continue;
    seen.add(id);
    out.push({ el: item.el, nodeId: id });
  }
  return out;
}

function tryCall(obj: any, methodName: string): boolean {
  try {
    const fn = obj?.[methodName];
    if (typeof fn !== "function") return false;
    fn.apply(obj);
    return true;
  } catch {
    return false;
  }
}

function tryClearSelectionCollection(collection: any): boolean {
  if (!collection) return false;
  try {
    if (collection instanceof Set || collection instanceof Map) {
      if (collection.size > 0) {
        collection.clear();
        return true;
      }
      return false;
    }
  } catch {}

  try {
    if (Array.isArray(collection)) {
      if (collection.length > 0) {
        collection.length = 0;
        return true;
      }
      return false;
    }
  } catch {}

  try {
    if (typeof collection?.clear === "function" && typeof collection?.size === "number" && collection.size > 0) {
      collection.clear();
      return true;
    }
  } catch {}

  return false;
}

export class CanvasFlowCanvasAdapter {
  getRoot(leaf: WorkspaceLeaf): HTMLElement | null {
    try {
      const root = (leaf.view as any)?.containerEl ?? null;
      return isHTMLElement(root) ? root : null;
    } catch {
      return null;
    }
  }

  getInternalCanvas(leaf: WorkspaceLeaf): any | null {
    try {
      return (leaf.view as any)?.canvas ?? null;
    } catch {
      return null;
    }
  }

  findNodeContentHost(nodeEl: HTMLElement): HTMLElement {
    try {
      return findCanvasNodeContentHost(nodeEl);
    } catch {
      return nodeEl;
    }
  }

  listNodeElements(leaf: WorkspaceLeaf, root?: HTMLElement | null): CanvasNodeElementInfo[] {
    const resolvedRoot = root || this.getRoot(leaf);
    if (!resolvedRoot) return [];

    const out: CanvasNodeElementInfo[] = [];

    try {
      const internalCanvas = this.getInternalCanvas(leaf);
      if (internalCanvas) {
        out.push(...findCanvasNodeElementsFromInternalCanvas(internalCanvas, resolvedRoot));
      }
    } catch {
      // fail-soft: internal canvas shape is not stable across Obsidian builds.
    }

    try {
      out.push(...findCanvasNodeElements(resolvedRoot));
    } catch {
      // fail-soft: if DOM probing fails, return whatever we already have.
    }

    return dedupeNodeInfos(out);
  }

  getSelectedNodeIds(leaf: WorkspaceLeaf, root?: HTMLElement | null): string[] {
    const resolvedRoot = root || this.getRoot(leaf);
    if (!resolvedRoot) return [];

    try {
      const internalCanvas = this.getInternalCanvas(leaf);
      const fromInternal = getSelectedNodeIdsFromInternalCanvas(internalCanvas);
      if (fromInternal && fromInternal.length) {
        return fromInternal;
      }
    } catch {
      // fail-soft; fall through to DOM selection.
    }

    try {
      return getSelectedNodeIdsFromDom(resolvedRoot);
    } catch {
      return [];
    }
  }

  trySetPromptNodeSize(leaf: WorkspaceLeaf, nodeId: string, width: number, height: number): boolean {
    try {
      const internalCanvas = this.getInternalCanvas(leaf);
      if (!internalCanvas) return false;
      return trySetInternalCanvasNodeSize(internalCanvas, nodeId, width, height);
    } catch {
      return false;
    }
  }

  clearSelection(leaf: WorkspaceLeaf, root?: HTMLElement | null): boolean {
    const resolvedRoot = root || this.getRoot(leaf);
    let cleared = false;

    try {
      const internalCanvas = this.getInternalCanvas(leaf);
      const selectionManager = internalCanvas?.selectionManager;
      if (selectionManager) {
        cleared = tryCall(selectionManager, "clearSelection") || cleared;
        cleared = tryCall(selectionManager, "clearSelections") || cleared;
        cleared = tryCall(selectionManager, "deselectAll") || cleared;
        cleared = tryCall(selectionManager, "unselectAll") || cleared;
        cleared = tryCall(selectionManager, "selectNone") || cleared;
      }

      const selectionCollections = [
        selectionManager?.selection,
        selectionManager?.selected,
        selectionManager?.selectedNodes,
        internalCanvas?.selection,
      ];
      for (const collection of selectionCollections) {
        cleared = tryClearSelectionCollection(collection) || cleared;
      }
    } catch {
      // fail-soft.
    }

    if (resolvedRoot) {
      try {
        const selected = Array.from(resolvedRoot.querySelectorAll<HTMLElement>(".canvas-node.is-selected"));
        if (selected.length > 0) {
          for (const el of selected) {
            el.classList.remove("is-selected");
          }
          cleared = true;
        }
      } catch {
        // fail-soft.
      }
    }

    return cleared;
  }
}
