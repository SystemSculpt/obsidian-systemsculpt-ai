import {
  dedupeStableStrings,
  getSelectedNodeIdsFromInternalCanvas,
} from "../CanvasFlowSelectionMenuHelpers";

describe("CanvasFlowSelectionMenuHelpers", () => {
  it("dedupes and trims ids while preserving order", () => {
    expect(dedupeStableStrings([" a ", "b", "a", "", " b ", "c"])).toEqual(["a", "b", "c"]);
  });

  it("extracts selected node ids from iterable canvas selections", () => {
    const canvas = {
      selection: [{ id: "node-a" }, { id: "node-b" }, { id: "node-a" }],
    };
    expect(getSelectedNodeIdsFromInternalCanvas(canvas)).toEqual(["node-a", "node-b"]);
  });

  it("falls back to selection manager structures", () => {
    const canvas = {
      selection: null,
      selectionManager: {
        selectedNodes: {
          nodes: [{ node: { id: "node-x" } }, { node: { id: "node-y" } }, { node: { id: "node-x" } }],
        },
      },
    };
    expect(getSelectedNodeIdsFromInternalCanvas(canvas)).toEqual(["node-x", "node-y"]);
  });

  it("returns null when canvas selection is unavailable", () => {
    expect(getSelectedNodeIdsFromInternalCanvas(null)).toBeNull();
    expect(getSelectedNodeIdsFromInternalCanvas({})).toBeNull();
  });
});
