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
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [],
      edges: [],
      entryNodeIds: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Test.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 100,
        maxArtifactsMb: 1024,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

describe("StudioGraphCompiler", () => {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);
  const compiler = new StudioGraphCompiler();

  it("compiles a valid linear graph", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "input",
        kind: "studio.input",
        version: "1.0.0",
        title: "Input",
        position: { x: 0, y: 0 },
        config: { value: "hello" },
      },
      {
        id: "text",
        kind: "studio.text_generation",
        version: "1.0.0",
        title: "Text",
        position: { x: 220, y: 0 },
        config: { modelId: "openai/gpt-5-mini" },
      }
    );
    project.graph.edges.push({
      id: "e1",
      fromNodeId: "input",
      fromPortId: "text",
      toNodeId: "text",
      toPortId: "prompt",
    });

    const compiled = compiler.compile(project, registry);
    expect(compiled.executionOrder).toEqual(["input", "text"]);
  });

  it("rejects incompatible port types", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "http",
        kind: "studio.http_request",
        version: "1.0.0",
        title: "HTTP",
        position: { x: 0, y: 0 },
        config: { method: "GET", url: "https://api.systemsculpt.com" },
      },
      {
        id: "text",
        kind: "studio.text_generation",
        version: "1.0.0",
        title: "Text",
        position: { x: 250, y: 0 },
        config: { modelId: "openai/gpt-5-mini" },
      }
    );
    project.graph.edges.push({
      id: "e1",
      fromNodeId: "http",
      fromPortId: "status",
      toNodeId: "text",
      toPortId: "prompt",
    });

    expect(() => compiler.compile(project, registry)).toThrow("type mismatch");
  });

  it("rejects cyclic graphs", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "a",
        kind: "studio.text",
        version: "1.0.0",
        title: "A",
        position: { x: 0, y: 0 },
        config: { value: "A" },
      },
      {
        id: "b",
        kind: "studio.text",
        version: "1.0.0",
        title: "B",
        position: { x: 200, y: 0 },
        config: { value: "B" },
      }
    );
    project.graph.edges.push(
      {
        id: "e1",
        fromNodeId: "a",
        fromPortId: "text",
        toNodeId: "b",
        toPortId: "text",
      },
      {
        id: "e2",
        fromNodeId: "b",
        fromPortId: "text",
        toNodeId: "a",
        toPortId: "text",
      }
    );

    expect(() => compiler.compile(project, registry)).toThrow("cycle");
  });
});
