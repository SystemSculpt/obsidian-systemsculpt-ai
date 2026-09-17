import { repairStudioProjectForLoad } from "../StudioProjectRepairs";
import { reconcileStudioProject } from "../StudioProjectReconciliation";
import { detachOrphanedManagedMediaOutputs } from "../StudioManagedOutputNodes";
import { assignNodesToGroup, createGroupFromSelection, sanitizeGraphGroups } from "../StudioGraphGroupModel";
import { createEmptyStudioProject, parseStudioProject, serializeStudioProject } from "../schema";
import { arrangeManagedOutputContainers, materializeImageOutputsAsMediaNodes, materializePendingImageOutputPlaceholders, removePendingManagedOutputNodes } from "../StudioManagedOutputNodes";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";

function fixture() {
  const project = createEmptyStudioProject({ name: "Outputs", policyPath: "policy.json", minPluginVersion: "0", maxRuns: 1, maxArtifactsMb: 1 });
  const source = { id: "gen", kind: "studio.image_generation", version: "1.0.0", title: "Portraits", position: { x: 50, y: 90 }, config: { count: 4 } };
  project.graph.nodes = [source, { ...source, id: "unrelated", position: { x: 999, y: -100 } }];
  project.graph.groups = [{ id: "workflow", name: "Workflow", nodeIds: [source.id] }];
  let id = 0;
  const options = { project, sourceNode: source, createNodeId: () => `output_${++id}`, createEdgeId: () => `edge_${++id}` };
  const outputs = (paths: string[]) => ({ images: paths.map(path => ({path})) });
  return { project, source, options, outputs };
}

it("creates a separate owned container to the right and appends runs without moving ordinary nodes", () => {
  const { project, source, options, outputs } = fixture();
  materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["a.png", "b.png", "c.png", "d.png"]) });
  const group = project.graph.groups?.find(g => g.outputForNodeId === source.id);
  expect(group?.name).toBe("Portraits Outputs");
  expect(group?.nodeIds).toHaveLength(4);
  expect(project.graph.groups?.find(g => g.id === "workflow")?.nodeIds).toEqual(["gen"]);
  const nodes = group!.nodeIds.map(id => project.graph.nodes.find(n => n.id === id)!);
  expect(nodes[0].position.x).toBeGreaterThan(source.position.x);
  expect(nodes[0].position.y).toBe(90);
  expect(nodes[1].position.x).toBeGreaterThan(nodes[0].position.x);
  expect(nodes[1].position.y).toBe(nodes[0].position.y);
  expect(nodes[3].position.x).toBe(nodes[0].position.x);
  expect(nodes[3].position.y).toBeGreaterThan(nodes[0].position.y);
  materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["e.png"]) });
  expect(group?.nodeIds).toHaveLength(5);
  expect(source.position).toEqual({ x: 50, y: 90 });
  expect(project.graph.nodes[1].position).toEqual({ x: 999, y: -100 });
  const saved = serializeStudioProject(project);
  assertValidStudioProjectAgentDocumentStructure(JSON.parse(saved));
  expect(parseStudioProject(saved).graph.groups).toEqual(project.graph.groups);
});

it("reuses run placeholders as completed cards and keeps other concurrent runs intact", () => {
  const { project, source, options, outputs } = fixture(); source.config.count = 1;
  const first = materializePendingImageOutputPlaceholders({ ...options, runId: "first" });
  const second = materializePendingImageOutputPlaceholders({ ...options, runId: "second" });
  materializeImageOutputsAsMediaNodes({ ...options, runId: "second", outputs: outputs(["second.png"]) });
  removePendingManagedOutputNodes({ project, runId: "second" });
  expect(project.graph.nodes.find(n => n.id === second.createdNodeIds[0])?.config.sourcePath).toBe("second.png");
  expect(project.graph.nodes.find(n => n.id === first.createdNodeIds[0])?.disabled).toBe(true);
});

it("keeps a moved container's anchor when new runs append", () => {
  const { project, source, options, outputs } = fixture();
  materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["a.png"]) });
  const first = project.graph.nodes[2]; const initialX = first.position.x;
  project.graph.groups!.find(group => group.outputForNodeId === source.id)!.outputOffset = { x: 296, y: 810 };
  materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["b.png"]) });
  expect(first.position).toEqual({ x: initialX + 200, y: 900 });
  expect(project.graph.nodes[3].position.y).toBe(900);
  expect(source.position).toEqual({ x: 50, y: 90 });
});

it("starts beyond the source's measured right edge and removes an empty failed container", () => {
  const { project, options } = fixture();
  materializePendingImageOutputPlaceholders({ ...options, runId: "failed", measure: () => ({ width: 600, height: 400 }) });
  expect(project.graph.nodes[2].position.x).toBe(50 + 600 + 96);
  removePendingManagedOutputNodes({ project, runId: "failed" });
  expect(project.graph.nodes).toHaveLength(2);
  expect(project.graph.groups).toHaveLength(1);
});

it("follows the producer right edge and repairs individual-card displacement without moving other nodes", () => {
  const { project, source, options, outputs } = fixture();
  materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["a.png", "b.png"]) });
  source.position.x = 1000; source.position.y = 300;
  project.graph.nodes[2].position = { x: -999, y: -999 };
  arrangeManagedOutputContainers(project, () => ({ width: 400, height: 200 }));
  expect(project.graph.nodes[2].position).toEqual({ x: 1496, y: 300 });
  expect(project.graph.nodes[3].position).toEqual({ x: 1944, y: 300 });
  expect(project.graph.nodes[1].position).toEqual({ x: 999, y: -100 });
});

it("keeps run identity distinct when two runs return the same path, while cache replay is idempotent", () => {
  const { project, options, outputs } = fixture();
  materializeImageOutputsAsMediaNodes({ ...options, runId: "one", outputs: outputs(["same.png"]) });
  materializeImageOutputsAsMediaNodes({ ...options, runId: "two", outputs: outputs(["same.png"]) });
  expect(project.graph.nodes).toHaveLength(4);
  expect(materializeImageOutputsAsMediaNodes({ ...options, runId: "two", outputs: outputs(["same.png"]) }).changed).toBe(false);
  expect(materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["same.png"]) }).changed).toBe(false);
  expect(project.graph.nodes).toHaveLength(4);
});

it("rejects regrouping owned outputs and validates unique producer ownership", () => {
  const { project, source, options, outputs } = fixture();
  materializeImageOutputsAsMediaNodes({ ...options, outputs: outputs(["a.png", "b.png"]) });
  const group = project.graph.groups!.find(group => group.outputForNodeId === source.id)!;
  expect(assignNodesToGroup(project, "workflow", group.nodeIds)).toBe(false);
  expect(createGroupFromSelection(project, [...group.nodeIds], () => "other")).toBeNull();
  const second = group.nodeIds.pop()!;
  project.graph.groups!.push({ ...group, id: "duplicate", nodeIds: [second] });
  expect(() => assertValidStudioProjectAgentDocumentStructure(JSON.parse(serializeStudioProject(project)))).toThrow(/duplicates an output/);
  expect(sanitizeGraphGroups(project)).toBe(true);
  expect(project.graph.groups?.filter(g => g.outputForNodeId === source.id)).toHaveLength(1);
  expect(group.nodeIds).toHaveLength(1); // Sanitization builds a replacement, leaving old references alone.
  expect(project.graph.groups?.find(g => g.outputForNodeId === source.id)?.nodeIds).toHaveLength(2);
});

it("rejects orphan offsets in both document dialects and discards them on legacy reads", () => {
  const { project } = fixture();
  project.graph.groups![0].outputOffset = { x: 96, y: 0 };
  expect(() => assertValidStudioProjectAgentDocumentStructure(JSON.parse(JSON.stringify(project)))).toThrow(/requires outputForNodeId/);
  expect(parseStudioProject(JSON.stringify(project)).graph.groups![0].outputOffset).toBeUndefined();
  const doc = JSON.parse(serializeStudioProject(project));
  expect(doc.canvas.groups[0].outputOffset).toBeUndefined();
  doc.canvas.groups[0].outputOffset = { x: 96, y: 0 };
  expect(() => assertValidStudioProjectAgentDocumentStructure(doc)).toThrow(/requires outputFor/);
  expect(parseStudioProject(JSON.stringify(doc)).graph.groups![0].outputOffset).toBeUndefined();
});

it.each(["deletion", "load", "reconciliation"])("preserves completed outputs as independent cards after producer %s", mode => {
  const { project, source, options, outputs } = fixture();
  materializeImageOutputsAsMediaNodes({ ...options, runId: "finished", outputs: outputs(["keep.png"]) });
  const base = JSON.parse(JSON.stringify(project));
  const output = project.graph.nodes[2];
  const position = { ...output.position };
  project.graph.nodes = project.graph.nodes.filter(node => node.id !== source.id);
  project.graph.edges = project.graph.edges.filter(edge => edge.fromNodeId !== source.id && edge.toNodeId !== source.id);
  let result = project;
  if (mode === "deletion") {
    expect(detachOrphanedManagedMediaOutputs(project)).toBe(true);
  } else if (mode === "load") {
    expect(repairStudioProjectForLoad(project)).toBe(true);
  } else {
    result = reconcileStudioProject(base, base, project).project;
  }
  const kept = result.graph.nodes.find(node => node.id === output.id)!;
  expect(kept.position).toEqual(position);
  expect(kept.config.sourcePath).toBe("keep.png");
  for (const key of ["__studio_managed_by", "__studio_source_node_id", "__studio_source_output_index", "__studio_output_run_id"]) {
    expect(kept.config[key]).toBeUndefined();
  }
  expect(detachOrphanedManagedMediaOutputs(result)).toBe(false);
  expect(parseStudioProject(serializeStudioProject(result)).graph.nodes.find(node => node.id === kept.id)?.config).toEqual(kept.config);
});
