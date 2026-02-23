import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import {
  MANAGED_MEDIA_OWNER,
  MANAGED_MEDIA_OWNER_KEY,
  MANAGED_MEDIA_SLOT_INDEX_KEY,
  MANAGED_MEDIA_SOURCE_NODE_ID_KEY,
  materializeImageOutputsAsMediaNodes,
} from "../StudioGeneratedMediaNodes";

function createProject(sourceNode?: StudioNodeInstance): StudioProjectV1 {
  const defaultSource: StudioNodeInstance = sourceNode || {
    id: "image_node",
    kind: "studio.image_generation",
    version: "1.0.0",
    title: "Image Generation",
    position: { x: 100, y: 120 },
    config: {},
    continueOnError: false,
    disabled: false,
  };

  return {
    schema: "studio.project.v1",
    projectId: "project_test",
    name: "Test",
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [defaultSource],
      edges: [],
      entryNodeIds: [defaultSource.id],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "policy.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 10,
        maxArtifactsMb: 512,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

describe("StudioGeneratedMediaNodes", () => {
  it("creates one managed media-ingest node per image output", () => {
    const project = createProject();
    const sourceNode = project.graph.nodes[0];
    let nodeIndex = 0;
    let edgeIndex = 0;

    const result = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [
          {
            path: "SystemSculpt/Assets/a.png",
            mimeType: "image/png",
          },
          {
            path: "SystemSculpt/Assets/b.png",
            mimeType: "image/png",
          },
        ],
      },
      createNodeId: () => `node_media_${nodeIndex++}`,
      createEdgeId: () => `edge_media_${edgeIndex++}`,
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual(["node_media_0", "node_media_1"]);
    expect(result.updatedNodeIds).toEqual([]);
    expect(result.createdEdgeIds).toEqual(["edge_media_0", "edge_media_1"]);
    expect(project.graph.nodes).toHaveLength(3);
    expect(project.graph.edges).toEqual([
      {
        id: "edge_media_0",
        fromNodeId: sourceNode.id,
        fromPortId: "images",
        toNodeId: "node_media_0",
        toPortId: "media",
      },
      {
        id: "edge_media_1",
        fromNodeId: sourceNode.id,
        fromPortId: "images",
        toNodeId: "node_media_1",
        toPortId: "media",
      },
    ]);

    const mediaNode = project.graph.nodes.find((node) => node.id === "node_media_0");
    expect(mediaNode?.kind).toBe("studio.media_ingest");
    expect(mediaNode?.config.sourcePath).toBe("SystemSculpt/Assets/a.png");
    expect(mediaNode?.config[MANAGED_MEDIA_OWNER_KEY]).toBe(MANAGED_MEDIA_OWNER);
    expect(mediaNode?.config[MANAGED_MEDIA_SOURCE_NODE_ID_KEY]).toBe(sourceNode.id);
    expect(mediaNode?.config[MANAGED_MEDIA_SLOT_INDEX_KEY]).toBe(0);
  });

  it("updates existing managed media nodes instead of creating duplicates", () => {
    const sourceNode: StudioNodeInstance = {
      id: "image_node",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image Generation",
      position: { x: 100, y: 120 },
      config: {},
      continueOnError: false,
      disabled: false,
    };
    const existingMediaNode: StudioNodeInstance = {
      id: "media_slot_0",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Image Generation Image",
      position: { x: 460, y: 120 },
      config: {
        sourcePath: "SystemSculpt/Assets/old.png",
        [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
        [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: "image_node",
        [MANAGED_MEDIA_SLOT_INDEX_KEY]: 0,
      },
      continueOnError: false,
      disabled: false,
    };
    const project = createProject(sourceNode);
    project.graph.nodes.push(existingMediaNode);

    const result = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [
          {
            path: "SystemSculpt/Assets/new.png",
            mimeType: "image/png",
          },
        ],
      },
      createNodeId: () => "should_not_create",
      createEdgeId: () => "edge_created",
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.updatedNodeIds).toEqual(["media_slot_0"]);
    expect(result.createdEdgeIds).toEqual(["edge_created"]);
    expect(project.graph.nodes).toHaveLength(2);
    expect(project.graph.edges).toEqual([
      {
        id: "edge_created",
        fromNodeId: sourceNode.id,
        fromPortId: "images",
        toNodeId: existingMediaNode.id,
        toPortId: "media",
      },
    ]);
    expect(existingMediaNode.config.sourcePath).toBe("SystemSculpt/Assets/new.png");
  });

  it("adopts connected media nodes when metadata is missing", () => {
    const sourceNode: StudioNodeInstance = {
      id: "image_node",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image Generation",
      position: { x: 100, y: 120 },
      config: {},
      continueOnError: false,
      disabled: false,
    };
    const connectedMediaNode: StudioNodeInstance = {
      id: "media_existing",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Image Generation Image",
      position: { x: 460, y: 120 },
      config: {
        sourcePath: "SystemSculpt/Assets/existing.png",
      },
      continueOnError: false,
      disabled: false,
    };
    const project = createProject(sourceNode);
    project.graph.nodes.push(connectedMediaNode);
    project.graph.edges.push({
      id: "edge_existing",
      fromNodeId: sourceNode.id,
      fromPortId: "images",
      toNodeId: connectedMediaNode.id,
      toPortId: "media",
    });

    const result = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [
          {
            path: "SystemSculpt/Assets/existing.png",
            mimeType: "image/png",
          },
        ],
      },
      createNodeId: () => "should_not_create",
      createEdgeId: () => "edge_should_not_create",
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.updatedNodeIds).toEqual([connectedMediaNode.id]);
    expect(result.createdEdgeIds).toEqual([]);
    expect(project.graph.nodes).toHaveLength(2);
    expect(project.graph.edges).toHaveLength(1);
    expect(connectedMediaNode.config[MANAGED_MEDIA_OWNER_KEY]).toBe(MANAGED_MEDIA_OWNER);
    expect(connectedMediaNode.config[MANAGED_MEDIA_SOURCE_NODE_ID_KEY]).toBe(sourceNode.id);
    expect(connectedMediaNode.config[MANAGED_MEDIA_SLOT_INDEX_KEY]).toBe(0);
  });

  it("ignores first_image-only outputs", () => {
    const project = createProject();
    const sourceNode = project.graph.nodes[0];

    const result = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        first_image: {
          path: "SystemSculpt/Assets/single.png",
          mimeType: "image/png",
        },
      },
      createNodeId: () => "node_media_0",
      createEdgeId: () => "edge_media_0",
    });

    expect(result.changed).toBe(false);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.updatedNodeIds).toEqual([]);
    expect(result.createdEdgeIds).toEqual([]);
    expect(project.graph.nodes).toHaveLength(1);
    expect(project.graph.edges).toHaveLength(0);
  });

  it("returns unchanged when image outputs are missing", () => {
    const project = createProject();
    const sourceNode = project.graph.nodes[0];

    const result = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {},
      createNodeId: () => "node_media_0",
      createEdgeId: () => "edge_media_0",
    });

    expect(result.changed).toBe(false);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.updatedNodeIds).toEqual([]);
    expect(result.createdEdgeIds).toEqual([]);
    expect(project.graph.nodes).toHaveLength(1);
  });
});
