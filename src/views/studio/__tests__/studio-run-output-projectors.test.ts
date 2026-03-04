import {
  STUDIO_PROJECT_SCHEMA_V1,
  type StudioNodeInstance,
  type StudioProjectV1,
} from "../../../studio/types";
import {
  MANAGED_TEXT_OWNER,
  MANAGED_TEXT_OWNER_KEY,
  MANAGED_TEXT_SOURCE_NODE_ID_KEY,
} from "../StudioManagedOutputNodes";
import {
  materializeManagedOutputNodesForNodeOutput,
  materializeManagedOutputNodesFromCacheEntries,
  materializeManagedOutputPlaceholdersForStartedNode,
  syncDatasetOutputFieldsToProjectNodeConfig,
  syncInlineTextOutputToProjectNodeConfig,
} from "../systemsculpt-studio-view/StudioRunOutputProjectors";

function nodeFixture(
  kind: string,
  config: StudioNodeInstance["config"] = {},
  id = `node_${kind.replace(/[^\w]+/g, "_")}`
): StudioNodeInstance {
  return {
    id,
    kind,
    version: "1.0.0",
    title: kind,
    position: { x: 120, y: 140 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function projectFixture(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    schema: STUDIO_PROJECT_SCHEMA_V1,
    projectId: "project_test",
    name: "Test Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes,
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: ".systemsculpt/policy.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 25,
        maxArtifactsMb: 100,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

describe("StudioRunOutputProjectors", () => {
  it("syncs text output into editable text-generation config when unlocked", () => {
    const node = nodeFixture("studio.text_generation", { value: "old", lockOutput: false }, "node_text");
    const project = projectFixture([node]);

    const changed = syncInlineTextOutputToProjectNodeConfig({
      project,
      event: {
        type: "node.output",
        runId: "run_1",
        nodeId: node.id,
        outputRef: "ref_1",
        outputs: { text: "new text output" },
        at: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(changed).toBe(true);
    expect(node.config.value).toBe("new text output");
  });

  it("skips text output sync when text-generation output is locked", () => {
    const node = nodeFixture("studio.text_generation", { value: "old", lockOutput: true }, "node_text");
    const project = projectFixture([node]);

    const changed = syncInlineTextOutputToProjectNodeConfig({
      project,
      event: {
        type: "node.output",
        runId: "run_1",
        nodeId: node.id,
        outputRef: "ref_1",
        outputs: { text: "new text output" },
        at: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(changed).toBe(false);
    expect(node.config.value).toBe("old");
  });

  it("syncs dataset-derived output fields into dataset config", () => {
    const node = nodeFixture("studio.dataset", {}, "node_dataset");
    const project = projectFixture([node]);

    const changed = syncDatasetOutputFieldsToProjectNodeConfig({
      project,
      event: {
        type: "node.output",
        runId: "run_2",
        nodeId: node.id,
        outputRef: "ref_2",
        outputs: {
          text: "tabular summary",
          rows: [{ id: "1" }],
          total: 1,
        },
        at: "2026-01-01T00:01:00.000Z",
      },
    });

    expect(changed).toBe(true);
    expect(node.config.outputFields).toEqual(["rows", "total"]);
  });

  it("materializes pending image placeholders when an image node starts", () => {
    const source = nodeFixture("studio.image_generation", { count: 2 }, "node_image");
    const project = projectFixture([source]);

    const changed = materializeManagedOutputPlaceholdersForStartedNode({
      project,
      event: {
        type: "node.started",
        runId: "run_3",
        nodeId: source.id,
        at: "2026-01-01T00:02:00.000Z",
      },
      createNodeId: jest.fn().mockReturnValueOnce("node_placeholder_1").mockReturnValueOnce("node_placeholder_2"),
      createEdgeId: jest.fn().mockReturnValueOnce("edge_placeholder_1").mockReturnValueOnce("edge_placeholder_2"),
    });

    expect(changed).toBe(true);
    expect(project.graph.nodes.some((node) => node.id === "node_placeholder_1")).toBe(true);
    expect(project.graph.nodes.some((node) => node.id === "node_placeholder_2")).toBe(true);
  });

  it("removes stale managed text outputs for text-generation node output events", () => {
    const source = nodeFixture("studio.text_generation", {}, "node_text_source");
    const managedText = nodeFixture(
      "studio.text",
      {
        [MANAGED_TEXT_OWNER_KEY]: MANAGED_TEXT_OWNER,
        [MANAGED_TEXT_SOURCE_NODE_ID_KEY]: source.id,
        value: "old generated text",
      },
      "node_managed_text"
    );
    const project = projectFixture([source, managedText]);

    const changed = materializeManagedOutputNodesForNodeOutput({
      project,
      event: {
        type: "node.output",
        runId: "run_4",
        nodeId: source.id,
        outputRef: "ref_4",
        outputs: { text: "fresh generated text" },
        at: "2026-01-01T00:03:00.000Z",
      },
      createNodeId: jest.fn(),
      createEdgeId: jest.fn(),
    });

    expect(changed).toBe(true);
    expect(project.graph.nodes.some((node) => node.id === managedText.id)).toBe(false);
  });

  it("materializes managed image outputs from cache entries", () => {
    const source = nodeFixture("studio.image_generation", { count: 1 }, "node_image_source");
    const project = projectFixture([source]);

    const changed = materializeManagedOutputNodesFromCacheEntries({
      project,
      entries: {
        [source.id]: {
          outputs: {
            images: [{ path: "Assets/generated-one.png" }],
          },
        },
      },
      createNodeId: jest.fn().mockReturnValue("node_media_1"),
      createEdgeId: jest.fn().mockReturnValue("edge_media_1"),
    });

    expect(changed).toBe(true);
    expect(project.graph.nodes.some((node) => node.id === "node_media_1")).toBe(true);
  });
});
