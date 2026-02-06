import {
  addEdge,
  addFileNode,
  findIncomingImageFileForNode,
  indexCanvas,
  parseCanvasDocument,
  serializeCanvasDocument,
} from "../CanvasFlowGraph";

describe("CanvasFlowGraph", () => {
  it("parses canvas JSON", () => {
    const raw = JSON.stringify({
      nodes: [{ id: "n1", type: "file", file: "Prompt.md", x: 10, y: 20 }],
      edges: [],
    });

    const doc = parseCanvasDocument(raw);
    expect(doc).not.toBeNull();
    expect(doc?.nodes).toHaveLength(1);
    expect(doc?.nodes[0].id).toBe("n1");
  });

  it("finds incoming image file node", () => {
    const raw = JSON.stringify({
      nodes: [
        { id: "img", type: "file", file: "imgs/in.png", x: 0, y: 0 },
        { id: "prompt", type: "file", file: "Prompt.md", x: 100, y: 0 },
      ],
      edges: [{ id: "e1", fromNode: "img", toNode: "prompt" }],
    });

    const doc = parseCanvasDocument(raw)!;
    const incoming = findIncomingImageFileForNode(doc, "prompt");
    expect(incoming).not.toBeNull();
    expect(incoming?.imagePath).toBe("imgs/in.png");
  });

  it("adds nodes and edges without dropping other keys", () => {
    const raw = JSON.stringify({
      nodes: [],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 0.5 },
    });

    let doc = parseCanvasDocument(raw)!;
    const addedNode = addFileNode(doc, { filePath: "x.md", x: 1, y: 2 });
    doc = addedNode.doc;
    const addedEdge = addEdge(doc, { fromNode: addedNode.nodeId, toNode: addedNode.nodeId, label: "self" });
    doc = addedEdge.doc;

    expect(doc.nodes).toHaveLength(1);
    expect(doc.edges).toHaveLength(1);
    expect((doc as any).viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });

    const text = serializeCanvasDocument(doc);
    expect(text).toContain('"viewport"');
  });

  it("indexes nodes and edges", () => {
    const raw = JSON.stringify({
      nodes: [{ id: "a", type: "file", file: "a.md", x: 0, y: 0 }],
      edges: [{ id: "e", fromNode: "a", toNode: "a" }],
    });
    const doc = parseCanvasDocument(raw)!;
    const idx = indexCanvas(doc);
    expect(idx.nodesById.get("a")?.file).toBe("a.md");
    expect(idx.edgesByToNode.get("a")?.[0].id).toBe("e");
  });
});

