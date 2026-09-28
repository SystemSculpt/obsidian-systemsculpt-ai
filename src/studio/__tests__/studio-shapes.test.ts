import {
  STUDIO_SHAPE_KINDS,
  connectStudioShapes,
  convertLegacyShapeNodesToDiagram,
  createStudioShape,
  readStudioDiagram,
  readStudioDiagramFromProject,
  resolveStudioShapeKind,
  removeStudioShape,
  removeStudioShapeArrow,
  removeStudioArrowsForItems,
  setStudioShapeArrowLabel,
} from "../StudioShapes";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import { buildGraphClipboardPayload, parseGraphClipboardPayload } from "../../views/studio/systemsculpt-studio-view/StudioGraphClipboardModel";
import { materializeGraphClipboardPaste } from "../../views/studio/systemsculpt-studio-view/StudioGraphClipboardPasteMaterializer";
import { parseStudioProject, serializeStudioProject } from "../schema";
import type { StudioProjectV1 } from "../types";

function projectFixture(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_shapes",
    name: "Shapes",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "0.0.0" },
    graph: { nodes: [], edges: [], entryNodeIds: [], groups: [] },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/Shapes.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: { maxRuns: 100, maxArtifactsMb: 1024 },
    },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

describe("Studio shapes", () => {

  it("keeps node and mixed visual arrows across both saved formats without graph edges", () => {
    const project = projectFixture();
    project.graph.nodes = ["n1", "n2"].map((id) => ({
      id, kind: "studio.text", version: "1.0.0", title: id,
      position: { x: 0, y: 0 }, config: {},
    }));
    const shape = createStudioShape({ shape: "rectangle", position: { x: 200, y: 0 } });
    project.diagram = { shapes: [shape], arrows: [] };
    expect(connectStudioShapes(project, "n1", "n2")).toBe(true);
    expect(connectStudioShapes(project, "n2", shape.id)).toBe(true);
    expect(connectStudioShapes(project, shape.id, "n1")).toBe(true);
    expect(connectStudioShapes(project, "n1", "n2")).toBe(false);
    expect(connectStudioShapes(project, "n1", "n1")).toBe(false);
    expect(connectStudioShapes(project, "n1", "missing")).toBe(false);
    setStudioShapeArrowLabel(project, project.diagram.arrows[0].id, "visual only");

    for (const serialized of [JSON.stringify(project), serializeStudioProject(project)]) {
      expect(() => assertValidStudioProjectAgentDocumentStructure(JSON.parse(serialized))).not.toThrow();
      const restored = parseStudioProject(serialized);
      expect(restored.diagram?.arrows.map(({ fromShapeId, toShapeId, label }) => ({ fromShapeId, toShapeId, label })))
        .toEqual(project.diagram.arrows.map(({ fromShapeId, toShapeId, label }) => ({ fromShapeId, toShapeId, label })));
      expect(restored.graph.edges).toEqual([]);
    }

    project.graph.nodes = project.graph.nodes.filter((node) => node.id !== "n2");
    expect(() => assertValidStudioProjectAgentDocumentStructure(project)).toThrow('missing canvas item "n2"');
    expect(readStudioDiagram(project.diagram, ["n1"]).arrows).toEqual([project.diagram.arrows[2]]);
    expect(removeStudioArrowsForItems(project, new Set(["n2"]))).toBe(true);
    expect(removeStudioArrowsForItems(project, new Set(["n2"]))).toBe(false);
    expect(project.diagram.arrows).toEqual([expect.objectContaining({ fromShapeId: shape.id, toShapeId: "n1" })]);
  });

  it("copies and remaps arrows only when both node or shape endpoints are copied", () => {
    const project = projectFixture();
    project.graph.nodes = ["n1", "n2", "n3"].map((id) => ({
      id, kind: "studio.text", version: "1.0.0", title: id,
      position: { x: 0, y: 0 }, config: {},
    }));
    const shape = createStudioShape({ shape: "ellipse", position: { x: 200, y: 0 } });
    project.diagram = { shapes: [shape], arrows: [] };
    connectStudioShapes(project, "n1", "n2");
    connectStudioShapes(project, "n2", shape.id);
    connectStudioShapes(project, shape.id, "n1");
    connectStudioShapes(project, "n1", "n3");
    setStudioShapeArrowLabel(project, project.diagram.arrows[0].id, "diagram");
    const payload = buildGraphClipboardPayload({ project, selectedNodeIds: ["n1", "n2"], selectedShapeIds: [shape.id] })!;
    expect(payload.arrows).toHaveLength(3);
    const nodeOnly = buildGraphClipboardPayload({ project, selectedNodeIds: ["n1", "n2"] })!;
    expect(nodeOnly.arrows).toHaveLength(1);
    let nodeIndex = 0;
    let arrowIndex = 0;
    const pasted = materializeGraphClipboardPaste({
      payload: parseGraphClipboardPayload(JSON.stringify(payload))!,
      anchor: { x: 400, y: 300 }, pasteCount: 0,
      normalizeNodePosition: (position) => position,
      nextNodeId: () => `copy_n${++nodeIndex}`,
      nextEdgeId: () => "copy_edge", nextGroupId: () => "copy_group",
      nextShapeId: () => "copy_shape", nextArrowId: () => `copy_arrow${++arrowIndex}`,
    })!;
    expect(pasted.newArrows).toEqual([
      { id: "copy_arrow1", fromShapeId: "copy_n1", toShapeId: "copy_n2", label: "diagram" },
      { id: "copy_arrow2", fromShapeId: "copy_n2", toShapeId: "copy_shape" },
      { id: "copy_arrow3", fromShapeId: "copy_shape", toShapeId: "copy_n1" },
    ]);
    expect(pasted.newEdges).toEqual([]);
    expect(project.diagram.arrows).toHaveLength(4);
  });

  it("keeps every drawable kind and falls back for anything it cannot draw", () => {
    expect(STUDIO_SHAPE_KINDS).toEqual([
      "rectangle",
      "ellipse",
      "diamond",
      "pill",
      "cylinder",
      "note",
      "hexagon",
    ]);
    for (const kind of STUDIO_SHAPE_KINDS) {
      expect(resolveStudioShapeKind(kind)).toBe(kind);
    }
    expect(resolveStudioShapeKind("triangle")).toBe("rectangle");
  });

  it("clamps a drawn shape into the shape bounds", () => {
    const tiny = createStudioShape({ shape: "ellipse", position: { x: 4.6, y: -3.2 }, size: { width: 5, height: 9000 } });

    expect(tiny.shape).toBe("ellipse");
    expect(tiny.position).toEqual({ x: 5, y: -3 });
    expect(tiny.size).toEqual({ width: 48, height: 4000 });
    expect(tiny.label).toBe("");
  });

  it("drops arrows whose shapes are gone and keeps the rest", () => {
    const project = projectFixture();
    const a = createStudioShape({ shape: "rectangle", position: { x: 0, y: 0 } });
    const b = createStudioShape({ shape: "rectangle", position: { x: 400, y: 0 } });
    project.diagram = { shapes: [a, b], arrows: [] };

    expect(connectStudioShapes(project, a.id, b.id)).toBe(true);
    // Same pair twice, and a shape can never connect to itself.
    expect(connectStudioShapes(project, a.id, b.id)).toBe(false);
    expect(connectStudioShapes(project, a.id, a.id)).toBe(false);
    expect(readStudioDiagramFromProject(project).arrows).toHaveLength(1);

    expect(removeStudioShape(project, a.id)).toBe(true);
    expect(readStudioDiagramFromProject(project)).toEqual({ shapes: [b], arrows: [] });
  });

  it("sets and clears an arrow label", () => {
    const project = projectFixture();
    const a = createStudioShape({ shape: "rectangle", position: { x: 0, y: 0 } });
    const b = createStudioShape({ shape: "ellipse", position: { x: 300, y: 0 } });
    project.diagram = { shapes: [a, b], arrows: [] };
    connectStudioShapes(project, a.id, b.id);
    const arrowId = readStudioDiagramFromProject(project).arrows[0].id;

    expect(setStudioShapeArrowLabel(project, arrowId, "yes\nno")).toBe(true);
    expect(readStudioDiagramFromProject(project).arrows[0].label).toBe("yes\nno");
    // Same value and unknown arrow are both no-ops.
    expect(setStudioShapeArrowLabel(project, arrowId, "yes\nno")).toBe(false);
    expect(setStudioShapeArrowLabel(project, "missing", "x")).toBe(false);
    // Clearing removes the field outright instead of persisting "".
    expect(setStudioShapeArrowLabel(project, arrowId, "")).toBe(true);
    expect(readStudioDiagramFromProject(project).arrows[0]).not.toHaveProperty("label");
  });

  it("removes a single arrow without touching its shapes", () => {
    const project = projectFixture();
    const a = createStudioShape({ shape: "rectangle", position: { x: 0, y: 0 } });
    const b = createStudioShape({ shape: "ellipse", position: { x: 300, y: 120 } });
    project.diagram = { shapes: [a, b], arrows: [] };
    connectStudioShapes(project, a.id, b.id);
    const arrowId = readStudioDiagramFromProject(project).arrows[0].id;

    expect(removeStudioShapeArrow(project, arrowId)).toBe(true);
    expect(removeStudioShapeArrow(project, arrowId)).toBe(false);
    expect(readStudioDiagramFromProject(project).shapes).toHaveLength(2);
  });

  it("heals unreadable diagram data instead of throwing", () => {
    const diagram = readStudioDiagram({
      shapes: [
        { id: "s1", shape: "triangle", position: { x: "12" }, size: {}, label: 7, style: { fill: "#fff" } },
        null,
        { id: "s1", shape: "rectangle", position: { x: 0, y: 0 }, size: { width: 60, height: 60 } },
      ],
      arrows: [
        { id: "a1", fromShapeId: "s1", toShapeId: "missing" },
        { id: "a2", fromShapeId: "s1", toShapeId: "s1" },
      ],
    });

    // First entry wins the duplicate ID; its unreadable fields fall back.
    expect(diagram.shapes).toHaveLength(1);
    expect(diagram.shapes[0]).toEqual({
      id: "s1",
      shape: "rectangle",
      position: { x: 12, y: 0 },
      size: { width: 180, height: 120 },
      label: "",
      style: { fill: "#fff" },
    });
    expect(diagram.arrows).toEqual([]);
  });

  it("lifts legacy studio.shape nodes out of the graph and keeps shape-to-shape edges", () => {
    const lifted = convertLegacyShapeNodesToDiagram({
      nodes: [
        {
          id: "n1",
          kind: "studio.shape",
          version: "1.0.0",
          title: "Shape",
          position: { x: 10, y: 20 },
          size: { width: 200, height: 90 },
          config: { shape: "ellipse", label: "Start" },
        },
        {
          id: "n2",
          kind: "studio.shape",
          version: "1.0.0",
          title: "Shape",
          position: { x: 400, y: 20 },
          config: {},
        },
        { id: "n3", kind: "studio.text", version: "1.0.0", title: "Text", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: "e1", fromNodeId: "n1", fromPortId: "out", toNodeId: "n2", toPortId: "in" },
        { id: "e2", fromNodeId: "n2", fromPortId: "out", toNodeId: "n3", toPortId: "in" },
      ],
    });

    expect(lifted).not.toBeNull();
    expect(lifted?.nodes.map((node) => node.id)).toEqual(["n3"]);
    // The straddling edge goes with them: the two layers no longer connect.
    expect(lifted?.edges).toEqual([]);
    expect(lifted?.diagram.shapes[0]).toEqual({
      id: "n1",
      shape: "ellipse",
      position: { x: 10, y: 20 },
      size: { width: 200, height: 90 },
      label: "Start",
    });
    expect(lifted?.diagram.shapes[1].size).toEqual({ width: 180, height: 120 });
    expect(lifted?.diagram.arrows).toEqual([
      { id: "e1", fromShapeId: "n1", toShapeId: "n2" },
    ]);
  });

  it("leaves a graph with no shape nodes alone", () => {
    expect(
      convertLegacyShapeNodesToDiagram({
        nodes: [{ id: "n1", kind: "studio.text", version: "1.0.0", title: "T", position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      })
    ).toBeNull();
  });

  it("round-trips the diagram through serialize and parse", () => {
    const project = projectFixture();
    const a = createStudioShape({ shape: "rectangle", position: { x: 40, y: 60 }, label: "A" });
    const b = createStudioShape({ shape: "ellipse", position: { x: 320, y: 60 }, label: "B" });
    project.diagram = { shapes: [a, b], arrows: [] };
    connectStudioShapes(project, a.id, b.id);

    const reloaded = parseStudioProject(serializeStudioProject(project));

    // Arrow ids derive from their endpoints in the v2 dialect, so only the
    // endpoints (not the session-local id) survive the round trip.
    expect(reloaded.diagram).toEqual({
      shapes: project.diagram.shapes,
      arrows: [{ id: `${a.id}->${b.id}`, fromShapeId: a.id, toShapeId: b.id }],
    });
    expect(reloaded.graph.nodes).toEqual([]);
  });

  it("round-trips a labeled arrow as the { from, to, label } object form", () => {
    const project = projectFixture();
    const a = createStudioShape({ shape: "rectangle", position: { x: 40, y: 60 }, label: "A" });
    const b = createStudioShape({ shape: "ellipse", position: { x: 320, y: 60 }, label: "B" });
    project.diagram = { shapes: [a, b], arrows: [] };
    connectStudioShapes(project, a.id, b.id);
    const arrowId = readStudioDiagramFromProject(project).arrows[0].id;
    setStudioShapeArrowLabel(project, arrowId, "approved\nby ops");

    const serialized = serializeStudioProject(project);
    const document = JSON.parse(serialized) as {
      canvas: { arrows: unknown[] };
    };
    // Only labeled arrows pay for the object form; unlabeled ones stay strings.
    expect(document.canvas.arrows).toEqual([
      { from: a.id, to: b.id, label: "approved\nby ops" },
    ]);

    const reloaded = parseStudioProject(serialized);
    expect(reloaded.diagram?.arrows).toEqual([
      { id: `${a.id}->${b.id}`, fromShapeId: a.id, toShapeId: b.id, label: "approved\nby ops" },
    ]);
  });

  it("migrates a persisted legacy shape node on load", () => {
    const project = projectFixture();
    project.graph.nodes.push({
      id: "n1",
      kind: "studio.shape",
      version: "1.0.0",
      title: "Shape",
      position: { x: 12, y: 8 },
      size: { width: 150, height: 150 },
      config: { shape: "ellipse", label: "Legacy" },
    });

    const reloaded = parseStudioProject(JSON.stringify(project));

    expect(reloaded.graph.nodes).toEqual([]);
    expect(reloaded.diagram?.shapes).toEqual([
      {
        id: "n1",
        shape: "ellipse",
        position: { x: 12, y: 8 },
        size: { width: 150, height: 150 },
        label: "Legacy",
      },
    ]);
  });
});
