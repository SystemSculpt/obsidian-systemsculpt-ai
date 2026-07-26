import { StudioGraphCompiler } from "../StudioGraphCompiler";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import type { StudioProjectV1 } from "../types";

function baseProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_1",
    name: "Test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "0.0.0" },
    graph: { nodes: [], edges: [], entryNodeIds: [] },
    permissionsRef: { policyVersion: 1, policyPath: "Test.systemsculpt-assets/policy/grants.json" },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: { maxRuns: 100, maxArtifactsMb: 1024 },
    },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

describe("StudioGraphCompiler managed node graph", () => {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);
  const compiler = new StudioGraphCompiler();

  it("compiles a valid managed text graph", () => {
    const project = baseProject();
    project.graph.nodes.push(
      { id: "input", kind: "studio.input", version: "1.0.0", title: "Input", position: { x: 0, y: 0 }, config: { value: "hello" } },
      { id: "text", kind: "studio.text_generation", version: "1.0.0", title: "Text", position: { x: 220, y: 0 }, config: {} },
    );
    project.graph.edges.push({ id: "e1", fromNodeId: "input", fromPortId: "text", toNodeId: "text", toPortId: "prompt" });

    expect(compiler.compile(project, registry).executionOrder).toEqual(["input", "text"]);
  });

  it("compiles a minimal text node into an image-generation prompt", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "prompt",
        kind: "studio.text",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 0, y: 0 },
        config: { value: "Portrait of a fox in amber light", fontSize: 14 },
      },
      {
        id: "image",
        kind: "studio.image_generation",
        version: "1.0.0",
        title: "Image Generation",
        position: { x: 320, y: 0 },
        config: { count: 1, aspectRatio: "1:1" },
      },
    );
    project.graph.edges.push({
      id: "prompt-edge",
      fromNodeId: "prompt",
      fromPortId: "text",
      toNodeId: "image",
      toPortId: "prompt",
    });

    const compiled = compiler.compile(project, registry);
    expect(compiled.executionOrder).toEqual(["prompt", "image"]);
    expect(compiled.nodesById.get("image")?.dependencyNodeIds).toEqual(["prompt"]);
  });

  it("rejects a minimal text output connected to an incompatible JSON input", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "prompt",
        kind: "studio.text",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 0, y: 0 },
        config: { value: "Not image data", fontSize: 14 },
      },
      {
        id: "json",
        kind: "studio.json",
        version: "1.0.0",
        title: "JSON",
        position: { x: 320, y: 0 },
        config: {},
      },
    );
    project.graph.edges.push({
      id: "invalid-edge",
      fromNodeId: "prompt",
      fromPortId: "text",
      toNodeId: "json",
      toPortId: "json",
    });

    expect(() => compiler.compile(project, registry)).toThrow(
      "type mismatch on edge"
    );
  });

  it("rejects cyclic graphs", () => {
    const project = baseProject();
    project.graph.nodes.push(
      { id: "a", kind: "studio.text_output", version: "1.0.0", title: "A", position: { x: 0, y: 0 }, config: { value: "A" } },
      { id: "b", kind: "studio.text_output", version: "1.0.0", title: "B", position: { x: 200, y: 0 }, config: { value: "B" } },
    );
    project.graph.edges.push(
      { id: "e1", fromNodeId: "a", fromPortId: "text", toNodeId: "b", toPortId: "text" },
      { id: "e2", fromNodeId: "b", fromPortId: "text", toNodeId: "a", toPortId: "text" },
    );

    expect(() => compiler.compile(project, registry)).toThrow("cycle");
  });

  it("rejects retired HTTP request nodes", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "http",
      kind: "studio.http_request",
      version: "1.0.0",
      title: "Retired HTTP",
      position: { x: 0, y: 0 },
      config: { url: "https://example.com" },
    });

    expect(() => compiler.compile(project, registry)).toThrow('missing node definition for "studio.http_request@1.0.0"');
  });
});
