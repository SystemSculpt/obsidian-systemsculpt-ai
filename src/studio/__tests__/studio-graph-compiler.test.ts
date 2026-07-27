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

describe("StudioGraphCompiler document validation mode", () => {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);
  const compiler = new StudioGraphCompiler();

  function pendingManagedMediaProject(): StudioProjectV1 {
    // The exact shape Studio persists while an image-generation run is in
    // flight: a managed media placeholder with an empty sourcePath fed by an
    // edge from the generation node.
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "image",
        kind: "studio.image_generation",
        version: "1.0.0",
        title: "Image Generation",
        position: { x: 0, y: 0 },
        config: { prompt: "a fox", count: 1, aspectRatio: "1:1" },
      },
      {
        id: "media",
        kind: "studio.media_ingest",
        version: "1.0.0",
        title: "Image Generation Image 1",
        position: { x: 320, y: 0 },
        config: {
          sourcePath: "",
          __studio_managed_by: "studio.image_generation_output.v1",
          __studio_source_node_id: "image",
          __studio_source_output_index: 0,
          __studio_pending: true,
        },
      },
    );
    project.graph.edges.push({
      id: "e1",
      fromNodeId: "image",
      fromPortId: "images",
      toNodeId: "media",
      toPortId: "media",
    });
    return project;
  }

  it("accepts Studio-persisted placeholder states that run mode also accepts", () => {
    const project = pendingManagedMediaProject();
    expect(compiler.compile(project, registry, { validation: "document" }).executionOrder).toEqual(["image", "media"]);
    // sourcePath is intentionally not a required config field, so run mode
    // accepts the edge-fed placeholder too.
    expect(compiler.compile(project, registry).executionOrder).toEqual(["image", "media"]);
  });

  it("accepts unfinished required configs in document mode but rejects them in run mode", () => {
    const project = baseProject();
    // A freshly inserted CLI node is saved with its empty defaults before the
    // user fills in the command; the document gate must accept it.
    project.graph.nodes.push({
      id: "cli",
      kind: "studio.cli_command",
      version: "1.0.0",
      title: "CLI",
      position: { x: 0, y: 0 },
      config: { command: "", args: [], cwd: "" },
    });

    expect(() => compiler.compile(project, registry, { validation: "document" })).not.toThrow();
    expect(() => compiler.compile(project, registry)).toThrow("invalid config");
  });

  it("accepts unwired required inputs in document mode but rejects them in run mode", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "text",
      kind: "studio.text_generation",
      version: "1.0.0",
      title: "Text",
      position: { x: 0, y: 0 },
      config: {},
    });

    expect(() => compiler.compile(project, registry, { validation: "document" })).not.toThrow();
    expect(() => compiler.compile(project, registry)).toThrow('required input "prompt" missing');
  });

  it("still rejects structural corruption in document mode", () => {
    const dangling = baseProject();
    dangling.graph.nodes.push({
      id: "a",
      kind: "studio.text",
      version: "1.0.0",
      title: "A",
      position: { x: 0, y: 0 },
      config: { value: "A" },
    });
    dangling.graph.edges.push({ id: "e1", fromNodeId: "a", fromPortId: "text", toNodeId: "missing", toPortId: "text" });
    expect(() => new StudioGraphCompiler().compile(dangling, registry, { validation: "document" })).toThrow("target node missing");

    const unknownKind = baseProject();
    unknownKind.graph.nodes.push({
      id: "x",
      kind: "studio.not_registered",
      version: "1.0.0",
      title: "X",
      position: { x: 0, y: 0 },
      config: {},
    });
    expect(() => new StudioGraphCompiler().compile(unknownKind, registry, { validation: "document" })).toThrow("missing node definition");

    const cyclic = baseProject();
    cyclic.graph.nodes.push(
      { id: "a", kind: "studio.text_output", version: "1.0.0", title: "A", position: { x: 0, y: 0 }, config: { value: "A" } },
      { id: "b", kind: "studio.text_output", version: "1.0.0", title: "B", position: { x: 200, y: 0 }, config: { value: "B" } },
    );
    cyclic.graph.edges.push(
      { id: "e1", fromNodeId: "a", fromPortId: "text", toNodeId: "b", toPortId: "text" },
      { id: "e2", fromNodeId: "b", fromPortId: "text", toNodeId: "a", toPortId: "text" },
    );
    expect(() => new StudioGraphCompiler().compile(cyclic, registry, { validation: "document" })).toThrow("cycle");
  });
});
