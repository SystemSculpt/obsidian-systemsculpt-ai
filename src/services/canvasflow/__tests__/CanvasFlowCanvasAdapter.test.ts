import { JSDOM } from "jsdom";
import { CanvasFlowCanvasAdapter } from "../CanvasFlowCanvasAdapter";

describe("CanvasFlowCanvasAdapter", () => {
  let dom: JSDOM;
  let adapter: CanvasFlowCanvasAdapter;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;
    adapter = new CanvasFlowCanvasAdapter();
  });

  it("returns DOM canvas node elements even when no internal canvas is available", () => {
    const root = document.createElement("div");
    const node = document.createElement("div");
    node.className = "canvas-node";
    node.setAttribute("data-node-id", "node-1");
    root.appendChild(node);

    const leaf = {
      view: {
        containerEl: root,
      },
    } as any;

    const nodes = adapter.listNodeElements(leaf, root);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeId).toBe("node-1");
    expect(nodes[0].el).toBe(node);
  });

  it("falls back to DOM selection ids when internal canvas selection is absent", () => {
    const root = document.createElement("div");
    const node = document.createElement("div");
    node.className = "canvas-node is-selected";
    node.setAttribute("data-node-id", "selected-node");
    root.appendChild(node);

    const leaf = {
      view: {
        containerEl: root,
        canvas: null,
      },
    } as any;

    expect(adapter.getSelectedNodeIds(leaf, root)).toEqual(["selected-node"]);
  });

  it("is fail-soft when the leaf root is unavailable", () => {
    const leaf = {
      view: {
        containerEl: null,
      },
    } as any;

    expect(adapter.getRoot(leaf)).toBeNull();
    expect(adapter.listNodeElements(leaf)).toEqual([]);
    expect(adapter.getSelectedNodeIds(leaf)).toEqual([]);
  });

  it("clears selection via internal selection manager and DOM fallback", () => {
    const root = document.createElement("div");
    const node = document.createElement("div");
    node.className = "canvas-node is-selected";
    node.setAttribute("data-node-id", "selected-node");
    root.appendChild(node);

    const clearSelection = jest.fn();
    const leaf = {
      view: {
        containerEl: root,
        canvas: {
          selectionManager: {
            clearSelection,
          },
        },
      },
    } as any;

    const cleared = adapter.clearSelection(leaf, root);
    expect(cleared).toBe(true);
    expect(clearSelection).toHaveBeenCalled();
    expect(node.classList.contains("is-selected")).toBe(false);
  });

  it("never calls canvas-level clear while deselecting", () => {
    const root = document.createElement("div");
    const node = document.createElement("div");
    node.className = "canvas-node is-selected";
    node.setAttribute("data-node-id", "selected-node");
    root.appendChild(node);

    const clearSelection = jest.fn();
    const clearCanvas = jest.fn();
    const leaf = {
      view: {
        containerEl: root,
        canvas: {
          clear: clearCanvas,
          selectionManager: {
            clearSelection,
          },
        },
      },
    } as any;

    const cleared = adapter.clearSelection(leaf, root);
    expect(cleared).toBe(true);
    expect(clearSelection).toHaveBeenCalled();
    expect(clearCanvas).not.toHaveBeenCalled();
    expect(node.classList.contains("is-selected")).toBe(false);
  });
});
