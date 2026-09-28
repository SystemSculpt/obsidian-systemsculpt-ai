import { createEmptyStudioProject } from "../../../studio/schema";
import { StudioGraphHistory } from "../StudioGraphHistory";

describe("Studio graph history for project-file edits", () => {
  it("keeps the pending canvas as the next Undo after loading the file", () => {
    const canvasProject = createEmptyStudioProject({
      name: "Pending canvas",
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.0.2",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    const fileProject = JSON.parse(JSON.stringify(canvasProject));
    fileProject.name = "Current file";

    const history = new StudioGraphHistory();
    history.reset(fileProject);
    history.preserve(canvasProject, []);

    expect(history.undo()?.project.name).toBe("Pending canvas");
  });
});

it("bounds history while keeping snapshots independent of later caller mutations", () => {
  const project = createEmptyStudioProject({
    name: "Original", policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
    minPluginVersion: "6.0.2", maxRuns: 100, maxArtifactsMb: 1024,
  });
  const history = new StudioGraphHistory(2);
  history.reset(project, [" a ", "a"]);
  for (const name of ["First", "Second", "Third"]) {
    project.name = name;
    history.checkpoint(project, ["a"]);
  }
  project.name = "Uncaptured mutation";
  const second = history.undo()!;
  expect(second.project.name).toBe("Second");
  expect(second.selectedNodeIds).toEqual(["a"]);
  second.project.name = "Mutated returned snapshot";
  const first = history.undo()!;
  expect(first.project.name).toBe("First");
  expect(history.undo()).toBeNull();
  expect(history.redo()?.project.name).toBe("Second");
});

it("keeps redo when checkpointing an unchanged graph, and resets both branches when closed", () => {
  const project = createEmptyStudioProject({
    name: "Original", policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
    minPluginVersion: "6.0.2", maxRuns: 100, maxArtifactsMb: 1024,
  });
  const history = new StudioGraphHistory();
  history.reset(project);
  project.name = "Edited";
  history.checkpoint(project, []);
  const original = history.undo()!;
  history.checkpoint(original.project, []);
  expect(history.redo()?.project.name).toBe("Edited");
  history.reset(null);
  expect(history.undo()).toBeNull();
  expect(history.redo()).toBeNull();
});

it("owns consecutive undo and redo transitions without a caller synchronization step", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "A", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  history.reset(project);
  for (const name of ["B", "C"]) { project.name = name; history.checkpoint(project, []); }
  expect(history.undo()?.project.name).toBe("B");
  expect(history.undo()?.project.name).toBe("A");
  expect(history.redo()?.project.name).toBe("B");
  expect(history.redo()?.project.name).toBe("C");
});

it("preserves both branches when restoration rejects or throws, and records the actual restored snapshot", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "A", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  history.reset(project);
  project.name = "B";
  history.checkpoint(project, []);
  expect(history.undo(() => null)).toBeNull();
  expect(() => history.undo(candidate => { candidate.project.name = "Unaccepted"; throw new Error("restore failed"); })).toThrow("restore failed");
  expect(history.undo(candidate => ({ ...candidate, project: { ...candidate.project, name: "Normalized A" } }))?.project.name).toBe("Normalized A");
  expect(history.redo(() => null)).toBeNull();
  expect(history.redo()?.project.name).toBe("B");
  expect(history.undo()?.project.name).toBe("Normalized A");
});

it("records removal without reentrant checkpoints, retaining redo for a net-zero edit", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "A", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  history.reset(project);
  project.name = "B";
  history.checkpoint(project, []);
  const original = history.undo()!;
  expect(history.completeRemoval(() => ({ project: original.project, selectedNodeIds: [] }))).toBe(true);
  expect(history.redo()?.project.name).toBe("B");
  expect(history.completeRemoval(() => ({ project: { ...project, name: "C" }, selectedNodeIds: [] }))).toBe(true);
  expect(history.undo()?.project.name).toBe("B");
  expect(history.redo()?.project.name).toBe("C");
});

it("leaves history available after a rejected, failed, or nested removal", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "A", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  history.reset(project);
  project.name = "B";
  history.checkpoint(project, []);
  expect(history.completeRemoval(() => null)).toBe(false);
  expect(() => history.completeRemoval(() => { throw new Error("removal failed"); })).toThrow("removal failed");
  expect(() => history.completeRemoval(() => { history.checkpoint(project, []); return null; })).toThrow("History cannot change");
  expect(history.undo()?.project.name).toBe("A");
  expect(history.redo()?.project.name).toBe("B");
});

it("undoes each completed local edit without inferring ownership from the live canvas", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "2", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  history.reset(project);
  for (const name of ["3", "4"]) {
    const before = { project: { ...project }, selectedNodeIds: [] };
    project.name = name;
    history.recordEdit(before, { project, selectedNodeIds: [] });
  }
  expect(history.undo(undefined, { project, selectedNodeIds: [] })?.project.name).toBe("3");
  expect(history.undo()?.project.name).toBe("2");
  expect(history.redo()?.project.name).toBe("3");
  expect(history.redo()?.project.name).toBe("4");
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe history capacity %s", capacity => {
  expect(() => new StudioGraphHistory(capacity)).toThrow(RangeError);
});

it("abandons the old redo branch after a successful new local edit", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "A", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  history.reset(project);
  for (const name of ["B", "C"]) { project.name = name; history.checkpoint(project, []); }
  const before = history.undo()!;
  const after = { project: { ...before.project, name: "D" }, selectedNodeIds: [] };
  history.recordEdit(before, after);
  expect(history.undo()?.project.name).toBe("B");
  expect(history.redo()?.project.name).toBe("D");
  expect(history.redo()).toBeNull();
});

it("rebases local undo and redo without restoring a peer's independently deleted node", () => {
  const history = new StudioGraphHistory();
  const project = createEmptyStudioProject({ name: "A", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  project.graph.nodes = ["own", "peer"].map(id => ({ id, kind: "studio.input", version: "1.0.0", title: id, config: { value: "" }, position: { x: 0, y: 0 }, disabled: false, continueOnError: false }));
  history.reset(project);
  const before = { project, selectedNodeIds: [] };
  const after = { project: { ...project, name: "B" }, selectedNodeIds: [] };
  history.recordEdit(before, after);
  const peerCanvas = { project: { ...after.project, graph: { ...after.project.graph, nodes: after.project.graph.nodes.filter(node => node.id !== "peer") } }, selectedNodeIds: [] };
  const undo = history.undo(undefined, peerCanvas)!;
  expect(undo.project.name).toBe("A");
  expect(undo.project.graph.nodes.map(node => node.id)).toEqual(["own"]);
  const redo = history.redo(undefined, undo)!;
  expect(redo.project.name).toBe("B");
  expect(redo.project.graph.nodes.map(node => node.id)).toEqual(["own"]);
});
