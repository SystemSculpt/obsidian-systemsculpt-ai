import { serializeStudioProjectSnapshot } from "../StudioProjectSnapshots";
import { createEmptyStudioProject, parseStudioProject, serializeStudioProject } from "../schema";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import type { StudioNodeInstance } from "../types";

const node = (id: string): StudioNodeInstance => ({ id, kind: "studio.text", title: id, version: "1.0.0", position: { x: 99, y: 99 }, config: { value: id } });
const project = () => createEmptyStudioProject({ name: "Layout", policyPath: "layout/grants.json", minPluginVersion: "0", maxRuns: 10, maxArtifactsMb: 10 });

function legacyDocument() {
  const p = project();
  p.graph.nodes = [node("a"), node("b"), node("c")];
  const document = JSON.parse(serializeStudioProject(p));
  document.canvas.layout = { mode: "managed" };
  for (const item of document.canvas.nodes) { delete item.x; delete item.y; }
  return document;
}

describe("manual Studio placement and legacy import", () => {
  it("defaults to manual placement and preserves all positions through save and content growth", () => {
    const p = project(); p.graph.nodes = [node("a"), node("b")];
    p.graph.nodes[1].position = { x: -137, y: 500 };
    expect(p.graph.layout?.mode).toBe("manual");
    const saved = serializeStudioProject(p);
    assertValidStudioProjectAgentDocumentStructure(JSON.parse(saved));
    const reopened = parseStudioProject(saved);
    expect(reopened.graph.nodes.map(n => n.position)).toEqual(p.graph.nodes.map(n => n.position));
    reopened.graph.nodes[0].config.value = "Long content\n".repeat(500);
    expect(parseStudioProject(serializeStudioProject(reopened)).graph.nodes.map(n => n.position)).toEqual(p.graph.nodes.map(n => n.position));
    expect(serializeStudioProject(parseStudioProject(saved))).toBe(saved);
  });

  it("records coordinate changes in undo snapshots even for an old managed project", () => {
    const p = project(); p.graph.layout = { mode: "managed" }; p.graph.nodes = [node("a")];
    const before = serializeStudioProjectSnapshot(p);
    p.graph.nodes[0].position.x = 200;
    expect(serializeStudioProjectSnapshot(p)).not.toBe(before);
    expect(JSON.parse(serializeStudioProject(p)).canvas.nodes[0].x).toBe(200);
  });

  it("recovers omitted legacy positions once and saves them as stable manual coordinates", () => {
    const document = legacyDocument();
    const parsed = parseStudioProject(JSON.stringify(document));
    expect(parsed.graph.layout).toEqual({ mode: "manual" });
    expect(new Set(parsed.graph.nodes.map(n => `${n.position.x},${n.position.y}`)).size).toBe(3);
    const saved = serializeStudioProject(parsed);
    expect(serializeStudioProject(parseStudioProject(saved))).toBe(saved);
  });

  it("preserves explicitly authored legacy coordinates, including mixed groups and drawings", () => {
    const document = legacyDocument();
    document.canvas.nodes[0].x = -400; document.canvas.nodes[0].y = 200;
    document.canvas.groups = [{ id: "g", name: "Group", nodes: ["a", "b"] }];
    document.canvas.shapes = [{ id: "s", shape: "rectangle", x: 0, y: 0, width: 500, height: 400, label: "" }];
    const parsed = parseStudioProject(JSON.stringify(document));
    expect(parsed.graph.nodes[0].position).toEqual({ x: -400, y: 200 });
    expect(parsed.graph.nodes[1].position).not.toEqual({ x: 0, y: 0 });
    expect(parsed.diagram?.shapes[0].position).toEqual({ x: 0, y: 0 });
    expect(parsed.graph.groups?.[0].nodeIds).toEqual(["a", "b"]);
  });

  it("never rearranges a managed file with existing coordinates", () => {
    const p = project(); p.graph.nodes = [node("a"), node("b")];
    const document = JSON.parse(serializeStudioProject(p)); document.canvas.layout.mode = "managed";
    expect(parseStudioProject(JSON.stringify(document)).graph.nodes.map(n => n.position)).toEqual(p.graph.nodes.map(n => n.position));
  });

  it("recovers v1 positions without overwriting explicitly placed nodes", () => {
    const p = project(); p.graph.nodes = [node("a"), node("b")]; p.graph.layout = { mode: "managed" };
    const document = JSON.parse(JSON.stringify(p)); delete document.graph.nodes[1].position;
    const parsed = parseStudioProject(JSON.stringify(document));
    expect(parsed.graph.nodes[0].position).toEqual({ x: 99, y: 99 });
    expect(parsed.graph.nodes[1].position).not.toEqual({ x: 0, y: 0 });
  });

  it("normalizes malformed legacy node collections without an incidental migration error", () => {
    const document = legacyDocument(); document.canvas.nodes = {};
    expect(parseStudioProject(JSON.stringify(document)).graph.nodes).toEqual([]);
    document.canvas.nodes = [null];
    expect(() => parseStudioProject(JSON.stringify(document))).toThrow("Invalid node entry");
  });

  it("bounds recovery of pathological old input without limiting ordinary manual canvases", () => {
    const document = legacyDocument();
    document.canvas.nodes = Array.from({ length: 2501 }, (_, i) => ({ ...document.canvas.nodes[0], id: String(i) }));
    expect(() => parseStudioProject(JSON.stringify(document))).toThrow(/2500/);
    for (const item of document.canvas.nodes) { item.x = 0; item.y = 0; }
    expect(parseStudioProject(JSON.stringify(document)).graph.nodes).toHaveLength(2501);
  });
});
