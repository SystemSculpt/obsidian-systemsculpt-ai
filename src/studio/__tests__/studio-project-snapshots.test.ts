import { createEmptyStudioProject } from "../schema";
import { captureStudioProjectSnapshot, cloneStudioProjectSnapshot } from "../StudioProjectSnapshots";

function projectFixture() {
  const project = createEmptyStudioProject({ name: "Snapshots", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  project.graph.nodes.push({ id: "node", kind: "studio.input", version: "1.0.0", title: "Input", config: { value: "Before", list: [1, 2] }, position: { x: 0, y: 0 } });
  return project;
}

it("shares unchanged snapshot branches while detaching changed caller data", () => {
  const project = projectFixture();
  const first = captureStudioProjectSnapshot(project);
  expect(first).toEqual(cloneStudioProjectSnapshot(project));
  expect(captureStudioProjectSnapshot(project, first)).toBe(first);
  project.graph.nodes[0].config.value = "After";
  const second = captureStudioProjectSnapshot(project, first);
  expect(second.graph).not.toBe(first.graph);
  expect(second.graph.nodes[0].config).not.toBe(first.graph.nodes[0].config);
  expect(second.settings).toBe(first.settings);
  expect(second.graph.edges).toBe(first.graph.edges);
  expect(second.graph.nodes[0].position).toBe(first.graph.nodes[0].position);
  expect(second.graph.nodes[0].config.list).toBe(first.graph.nodes[0].config.list);
  project.graph.nodes[0].config.value = "Uncaptured";
  (project.graph.nodes[0].config.list as number[]).push(3);
  expect(first.graph.nodes[0].config.value).toBe("Before");
  expect(second.graph.nodes[0].config.value).toBe("After");
  expect(second.graph.nodes[0].config.list).toEqual([1, 2]);
  project.graph.nodes = [];
  const removed = captureStudioProjectSnapshot(project, second);
  expect(removed.graph.nodes).toEqual([]);
  expect(second.graph.nodes).toHaveLength(1);
});

it("captures JSON key removal, replacement and undefined like a detached JSON snapshot", () => {
  const project = projectFixture();
  const first = captureStudioProjectSnapshot(project);
  delete project.graph.nodes[0].config.value;
  project.graph.nodes[0].config.replacement = { nested: "changed" };
  project.graph.nodes[0].size = undefined;
  project.graph.nodes[0].config.nonfinite = [NaN, Infinity];
  const next = captureStudioProjectSnapshot(project, first);
  expect(next).toEqual(cloneStudioProjectSnapshot(project));
  expect(Object.prototype.hasOwnProperty.call(next.graph.nodes[0], "size")).toBe(false);
  expect(next.graph.nodes[0].config.value).toBeUndefined();
});

it("keeps prototype-named config keys detached without mutating shared prototypes", () => {
  const project = projectFixture();
  const first = captureStudioProjectSnapshot(project);
  project.graph.nodes[0].config = JSON.parse('{"__proto__":{},"constructor":{"value":"safe"},"prototype":1}');
  const next = captureStudioProjectSnapshot(project, first);
  const config = next.graph.nodes[0].config;
  expect(Object.prototype.hasOwnProperty.call(config, "__proto__")).toBe(true);
  expect(config.__proto__).not.toBe(Object.prototype);
  expect(config).toEqual(cloneStudioProjectSnapshot(project).graph.nodes[0].config);
  expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  (project.graph.nodes[0].config.__proto__ as Record<string, string>).polluted = "caller";
  expect(config.__proto__).toEqual({});
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
