import { reconcileStudioProject } from "../StudioProjectReconciliation";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import { serializeStudioProject, createEmptyStudioProject } from "../schema";
import { cloneStudioProjectSnapshot } from "../StudioProjectSnapshots";

function fixture() {
  const project = createEmptyStudioProject({ name: "Workspace", policyPath: "Studio/Workspace.systemsculpt-assets/policy/grants.json", minPluginVersion: "6.7.2", maxRuns: 100, maxArtifactsMb: 1024 });
  project.graph.layout = undefined;
  project.graph.nodes = ["a", "b"].map(id => ({ id, kind: "studio.text", version: "1.0.0", title: id, position: { x: 0, y: 0 }, config: { value: "original", fontSize: 22 } }));
  return project;
}

describe("Studio workspace reconciliation", () => {
  it("combines independent fields on the same node and changes on different nodes", () => {
    const base = fixture(), local = cloneStudioProjectSnapshot(base), external = cloneStudioProjectSnapshot(base);
    local.graph.nodes[0].position.x = 300;
    local.graph.nodes[0].config.value = "local text";
    external.graph.nodes[0].config.fontSize = 30;
    external.graph.nodes[1].title = "external title";
    const merged = reconcileStudioProject(base, local, external);
    expect(merged.conflicts).toEqual([]);
    expect(merged.project.graph.nodes[0]).toMatchObject({ position: { x: 300 }, config: { value: "local text", fontSize: 30 } });
    expect(merged.project.graph.nodes[1].title).toBe("external title");
    expect(merged.project.permissionsRef).toEqual(base.permissionsRef);
  });

  it("combines additions and preserves an independent deletion without resurrecting connections", () => {
    const base = fixture(), local = cloneStudioProjectSnapshot(base), external = cloneStudioProjectSnapshot(base);
    local.graph.nodes.splice(1, 1);
    external.graph.nodes.push({ ...external.graph.nodes[0], id: "c" });
    external.graph.edges.push({ id: "edge", fromNodeId: "a", fromPortId: "text", toNodeId: "b", toPortId: "text" });
    const merged = reconcileStudioProject(base, local, external);
    expect(merged.project.graph.nodes.map(node => node.id)).toEqual(["a", "c"]);
    expect(merged.project.graph.edges).toEqual([]);
  });

  it("discards retired layout pins during reconciliation and leaves a valid manual document", () => {
    const base = fixture(), local = cloneStudioProjectSnapshot(base), external = cloneStudioProjectSnapshot(base);
    local.graph.nodes = local.graph.nodes.filter(node => node.id !== "b");
    external.graph.layout = { mode: "managed", pinnedNodeIds: ["a", "b"] };
    const merged = reconcileStudioProject(base, local, external);
    expect(merged.project.graph.layout).toEqual({ mode: "manual" });
    expect(() => assertValidStudioProjectAgentDocumentStructure(JSON.parse(serializeStudioProject(merged.project)))).not.toThrow();
  });

  it("localizes same-field conflicts while retaining unrelated local edits", () => {
    const base = fixture(), local = cloneStudioProjectSnapshot(base), external = cloneStudioProjectSnapshot(base);
    local.graph.nodes[0].config.value = "local";
    local.graph.nodes[1].position.y = 500;
    external.graph.nodes[0].config.value = "external";
    const merged = reconcileStudioProject(base, local, external);
    expect(merged.conflicts).toEqual(["canvas.nodes[a].config.value"]);
    expect(merged.project.graph.nodes[0].config.value).toBe("external");
    expect(merged.project.graph.nodes[1].position.y).toBe(500);
    expect(local.graph.nodes[0].config.value).toBe("local");
  });

  it("rebases keystrokes made during a save without replaying earlier edits", () => {
    const base = fixture(), pending = cloneStudioProjectSnapshot(base), saved = cloneStudioProjectSnapshot(base);
    pending.graph.nodes[0].config.value = "newer keystrokes";
    saved.graph.nodes[1].title = "external change";
    const merged = reconcileStudioProject(base, pending, saved, { preferLocalConflicts: true });
    expect(merged.project.graph.nodes[0].config.value).toBe("newer keystrokes");
    expect(merged.project.graph.nodes[1].title).toBe("external change");
  });
});
