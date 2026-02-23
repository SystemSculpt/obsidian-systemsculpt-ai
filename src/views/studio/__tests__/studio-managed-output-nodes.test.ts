import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import {
  cleanupStaleManagedOutputPlaceholders,
  isManagedOutputPlaceholderNode,
  MANAGED_OUTPUT_PENDING_KEY,
  MANAGED_OUTPUT_PENDING_RUN_ID_KEY,
  MANAGED_MEDIA_OWNER,
  MANAGED_MEDIA_OWNER_KEY,
  MANAGED_MEDIA_SLOT_INDEX_KEY,
  MANAGED_MEDIA_SOURCE_NODE_ID_KEY,
  MANAGED_TEXT_OWNER,
  MANAGED_TEXT_OWNER_KEY,
  MANAGED_TEXT_OUTPUT_HASH_KEY,
  MANAGED_TEXT_SLOT_INDEX_KEY,
  MANAGED_TEXT_SOURCE_NODE_ID_KEY,
  materializePendingImageOutputPlaceholders,
  materializePendingTextOutputPlaceholder,
  materializeImageOutputsAsMediaNodes,
  materializeTextOutputsAsTextNodes,
  removeManagedTextOutputNodes,
  removePendingManagedOutputNodes,
} from "../StudioManagedOutputNodes";

function createProject(
  sourceNode: StudioNodeInstance,
  options?: { groups?: StudioProjectV1["graph"]["groups"] }
): StudioProjectV1 {
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
      nodes: [sourceNode],
      edges: [],
      entryNodeIds: [sourceNode.id],
      ...(options?.groups ? { groups: options.groups } : {}),
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

function createImageSourceNode(): StudioNodeInstance {
  return {
    id: "image_node",
    kind: "studio.image_generation",
    version: "1.0.0",
    title: "Image Generation",
    position: { x: 100, y: 120 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

function createTextSourceNode(): StudioNodeInstance {
  return {
    id: "text_gen_node",
    kind: "studio.text_generation",
    version: "1.0.0",
    title: "Title Generation",
    position: { x: 140, y: 160 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

describe("StudioManagedOutputNodes media outputs", () => {
  it("creates one managed media-ingest node per image output", () => {
    const sourceNode = createImageSourceNode();
    const project = createProject(sourceNode);
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

  it("appends new media nodes for new output paths instead of replacing prior runs", () => {
    const sourceNode = createImageSourceNode();
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
      createNodeId: () => "media_slot_1",
      createEdgeId: () => "edge_created",
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual(["media_slot_1"]);
    expect(result.updatedNodeIds).toEqual([]);
    expect(result.createdEdgeIds).toEqual(["edge_created"]);
    expect(project.graph.nodes).toHaveLength(3);
    expect(project.graph.edges).toEqual([
      {
        id: "edge_created",
        fromNodeId: sourceNode.id,
        fromPortId: "images",
        toNodeId: "media_slot_1",
        toPortId: "media",
      },
    ]);
    expect(existingMediaNode.config.sourcePath).toBe("SystemSculpt/Assets/old.png");
  });

  it("is append-only across runs and idempotent for already-materialized paths", () => {
    const sourceNode = createImageSourceNode();
    const project = createProject(sourceNode);
    let nodeIndex = 0;
    let edgeIndex = 0;

    const first = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [{ path: "SystemSculpt/Assets/a.png", mimeType: "image/png" }],
      },
      createNodeId: () => `node_media_${nodeIndex++}`,
      createEdgeId: () => `edge_media_${edgeIndex++}`,
    });
    const second = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [{ path: "SystemSculpt/Assets/b.png", mimeType: "image/png" }],
      },
      createNodeId: () => `node_media_${nodeIndex++}`,
      createEdgeId: () => `edge_media_${edgeIndex++}`,
    });
    const third = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [{ path: "SystemSculpt/Assets/b.png", mimeType: "image/png" }],
      },
      createNodeId: () => `node_media_${nodeIndex++}`,
      createEdgeId: () => `edge_media_${edgeIndex++}`,
    });

    expect(first.changed).toBe(true);
    expect(first.createdNodeIds).toEqual(["node_media_0"]);
    expect(second.changed).toBe(true);
    expect(second.createdNodeIds).toEqual(["node_media_1"]);
    expect(third.changed).toBe(false);
    expect(third.createdNodeIds).toEqual([]);
    expect(third.updatedNodeIds).toEqual([]);
    expect(project.graph.nodes).toHaveLength(3);
    expect(project.graph.edges).toHaveLength(2);
    expect(
      project.graph.nodes.filter((node) => node.kind === "studio.media_ingest").map((node) => node.config.sourcePath)
    ).toEqual(["SystemSculpt/Assets/a.png", "SystemSculpt/Assets/b.png"]);
  });

  it("adopts connected media nodes when metadata is missing", () => {
    const sourceNode = createImageSourceNode();
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
    const sourceNode = createImageSourceNode();
    const project = createProject(sourceNode);

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
    const sourceNode = createImageSourceNode();
    const project = createProject(sourceNode);

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

  it("adds managed media output nodes into the same group as the source node", () => {
    const sourceNode = createImageSourceNode();
    const project = createProject(sourceNode, {
      groups: [
        {
          id: "group_1",
          name: "Group 1",
          nodeIds: [sourceNode.id],
        },
      ],
    });

    const result = materializeImageOutputsAsMediaNodes({
      project,
      sourceNode,
      outputs: {
        images: [{ path: "SystemSculpt/Assets/a.png", mimeType: "image/png" }],
      },
      createNodeId: () => "node_media_0",
      createEdgeId: () => "edge_media_0",
    });

    expect(result.changed).toBe(true);
    expect(project.graph.groups?.[0]?.nodeIds).toEqual([sourceNode.id, "node_media_0"]);
  });
});

describe("StudioManagedOutputNodes text outputs", () => {
  it("creates one managed text node for text-generation output", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode);

    const result = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: {
        text: "Title Option A",
      },
      createNodeId: () => "node_text_0",
      createEdgeId: () => "edge_text_0",
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual(["node_text_0"]);
    expect(result.updatedNodeIds).toEqual([]);
    expect(result.createdEdgeIds).toEqual(["edge_text_0"]);

    const textNode = project.graph.nodes.find((node) => node.id === "node_text_0");
    expect(textNode?.kind).toBe("studio.text");
    expect(textNode?.config.value).toBe("Title Option A");
    expect(textNode?.config[MANAGED_TEXT_OWNER_KEY]).toBe(MANAGED_TEXT_OWNER);
    expect(textNode?.config[MANAGED_TEXT_SOURCE_NODE_ID_KEY]).toBe(sourceNode.id);
    expect(textNode?.config[MANAGED_TEXT_SLOT_INDEX_KEY]).toBe(0);
    expect(typeof textNode?.config[MANAGED_TEXT_OUTPUT_HASH_KEY]).toBe("string");
    expect(project.graph.edges).toEqual([
      {
        id: "edge_text_0",
        fromNodeId: sourceNode.id,
        fromPortId: "text",
        toNodeId: "node_text_0",
        toPortId: "text",
      },
    ]);
  });

  it("is append-only across runs and idempotent for already-materialized text", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode);
    let nodeIndex = 0;
    let edgeIndex = 0;

    const first = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Title Option A" },
      createNodeId: () => `node_text_${nodeIndex++}`,
      createEdgeId: () => `edge_text_${edgeIndex++}`,
    });
    const second = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Title Option B" },
      createNodeId: () => `node_text_${nodeIndex++}`,
      createEdgeId: () => `edge_text_${edgeIndex++}`,
    });
    const third = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Title Option B" },
      createNodeId: () => `node_text_${nodeIndex++}`,
      createEdgeId: () => `edge_text_${edgeIndex++}`,
    });

    expect(first.changed).toBe(true);
    expect(first.createdNodeIds).toEqual(["node_text_0"]);
    expect(second.changed).toBe(true);
    expect(second.createdNodeIds).toEqual(["node_text_1"]);
    expect(third.changed).toBe(false);
    expect(third.createdNodeIds).toEqual([]);
    expect(project.graph.nodes.filter((node) => node.kind === "studio.text")).toHaveLength(2);
    expect(project.graph.edges).toHaveLength(2);
  });

  it("preserves user-edited text when matching managed output is seen again", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode);

    const first = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Original output" },
      createNodeId: () => "node_text_0",
      createEdgeId: () => "edge_text_0",
    });

    expect(first.createdNodeIds).toEqual(["node_text_0"]);
    const textNode = project.graph.nodes.find((node) => node.id === "node_text_0");
    expect(textNode).toBeDefined();
    textNode!.config.value = "Edited by user";

    const second = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Original output" },
      createNodeId: () => "node_text_1",
      createEdgeId: () => "edge_text_1",
    });

    expect(second.changed).toBe(false);
    expect(second.createdNodeIds).toEqual([]);
    expect(second.updatedNodeIds).toEqual([]);
    expect(textNode?.config.value).toBe("Edited by user");
    expect(project.graph.nodes).toHaveLength(2);
    expect(project.graph.edges).toHaveLength(1);
  });

  it("adopts connected text nodes when metadata is missing", () => {
    const sourceNode = createTextSourceNode();
    const connectedTextNode: StudioNodeInstance = {
      id: "text_existing",
      kind: "studio.text",
      version: "1.0.0",
      title: "Title Note",
      position: { x: 500, y: 160 },
      config: {
        value: "Title Option A",
      },
      continueOnError: false,
      disabled: false,
    };

    const project = createProject(sourceNode);
    project.graph.nodes.push(connectedTextNode);
    project.graph.edges.push({
      id: "edge_existing",
      fromNodeId: sourceNode.id,
      fromPortId: "text",
      toNodeId: connectedTextNode.id,
      toPortId: "text",
    });

    const result = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Title Option A" },
      createNodeId: () => "should_not_create",
      createEdgeId: () => "edge_should_not_create",
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.updatedNodeIds).toEqual([connectedTextNode.id]);
    expect(result.createdEdgeIds).toEqual([]);
    expect(connectedTextNode.config[MANAGED_TEXT_OWNER_KEY]).toBe(MANAGED_TEXT_OWNER);
    expect(connectedTextNode.config[MANAGED_TEXT_SOURCE_NODE_ID_KEY]).toBe(sourceNode.id);
    expect(connectedTextNode.config[MANAGED_TEXT_SLOT_INDEX_KEY]).toBe(0);
    expect(typeof connectedTextNode.config[MANAGED_TEXT_OUTPUT_HASH_KEY]).toBe("string");
  });

  it("returns unchanged when text outputs are missing", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode);

    const result = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: {},
      createNodeId: () => "node_text_0",
      createEdgeId: () => "edge_text_0",
    });

    expect(result.changed).toBe(false);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.updatedNodeIds).toEqual([]);
    expect(result.createdEdgeIds).toEqual([]);
    expect(project.graph.nodes).toHaveLength(1);
    expect(project.graph.edges).toHaveLength(0);
  });

  it("adds managed text output nodes into the same group as the source node", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode, {
      groups: [
        {
          id: "group_1",
          name: "Group 1",
          nodeIds: [sourceNode.id],
        },
      ],
    });

    const result = materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Title Option A" },
      createNodeId: () => "node_text_0",
      createEdgeId: () => "edge_text_0",
    });

    expect(result.changed).toBe(true);
    expect(project.graph.groups?.[0]?.nodeIds).toEqual([sourceNode.id, "node_text_0"]);
  });
});

describe("StudioManagedOutputNodes pending placeholders", () => {
  it("materializes pending media placeholders from image count", () => {
    const sourceNode = createImageSourceNode();
    sourceNode.config = { count: 2 };
    const project = createProject(sourceNode);
    let nodeIndex = 0;
    let edgeIndex = 0;

    const result = materializePendingImageOutputPlaceholders({
      project,
      sourceNode,
      runId: "run_1",
      createdAt: "2026-02-23T00:00:00.000Z",
      createNodeId: () => `pending_media_${nodeIndex++}`,
      createEdgeId: () => `pending_media_edge_${edgeIndex++}`,
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual(["pending_media_0", "pending_media_1"]);
    expect(project.graph.nodes).toHaveLength(3);
    const pendingNodes = project.graph.nodes.filter((node) => node.id.startsWith("pending_media_"));
    expect(pendingNodes.every((node) => isManagedOutputPlaceholderNode(node))).toBe(true);
    for (const node of pendingNodes) {
      expect(node.kind).toBe("studio.media_ingest");
      expect(node.disabled).toBe(true);
      expect(node.config[MANAGED_OUTPUT_PENDING_KEY]).toBe(true);
      expect(node.config[MANAGED_OUTPUT_PENDING_RUN_ID_KEY]).toBe("run_1");
      expect(node.config.sourcePath).toBe("");
    }
  });

  it("materializes one pending text placeholder", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode);

    const result = materializePendingTextOutputPlaceholder({
      project,
      sourceNode,
      runId: "run_2",
      createNodeId: () => "pending_text_0",
      createEdgeId: () => "pending_text_edge_0",
    });

    expect(result.changed).toBe(true);
    expect(result.createdNodeIds).toEqual(["pending_text_0"]);
    const pendingText = project.graph.nodes.find((node) => node.id === "pending_text_0");
    expect(pendingText).toBeDefined();
    expect(pendingText?.kind).toBe("studio.text");
    expect(pendingText?.disabled).toBe(true);
    expect(pendingText?.config[MANAGED_OUTPUT_PENDING_KEY]).toBe(true);
    expect(pendingText?.config[MANAGED_OUTPUT_PENDING_RUN_ID_KEY]).toBe("run_2");
    expect(isManagedOutputPlaceholderNode(pendingText!)).toBe(true);
  });

  it("removes pending placeholders by source + run", () => {
    const sourceNode = createImageSourceNode();
    sourceNode.config = { count: 1 };
    const project = createProject(sourceNode);

    materializePendingImageOutputPlaceholders({
      project,
      sourceNode,
      runId: "run_cleanup",
      createNodeId: () => "pending_media_0",
      createEdgeId: () => "pending_media_edge_0",
    });
    expect(project.graph.nodes).toHaveLength(2);

    const removed = removePendingManagedOutputNodes({
      project,
      sourceNodeId: sourceNode.id,
      runId: "run_cleanup",
    });

    expect(removed.changed).toBe(true);
    expect(removed.removedNodeIds).toEqual(["pending_media_0"]);
    expect(project.graph.nodes).toHaveLength(1);
    expect(project.graph.edges).toHaveLength(0);
  });

  it("cleans up stale placeholders without source/run filters", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode);

    materializePendingTextOutputPlaceholder({
      project,
      sourceNode,
      runId: "run_stale",
      createNodeId: () => "pending_text_0",
      createEdgeId: () => "pending_text_edge_0",
    });
    expect(project.graph.nodes).toHaveLength(2);

    const cleaned = cleanupStaleManagedOutputPlaceholders(project);
    expect(cleaned.changed).toBe(true);
    expect(cleaned.removedNodeIds).toEqual(["pending_text_0"]);
    expect(project.graph.nodes).toHaveLength(1);
    expect(project.graph.edges).toHaveLength(0);
  });

  it("removes legacy managed text output nodes", () => {
    const sourceNode = createTextSourceNode();
    const project = createProject(sourceNode, {
      groups: [
        {
          id: "group_1",
          name: "Group 1",
          nodeIds: [sourceNode.id],
        },
      ],
    });

    materializeTextOutputsAsTextNodes({
      project,
      sourceNode,
      outputs: { text: "Title Option A" },
      createNodeId: () => "managed_text_0",
      createEdgeId: () => "managed_text_edge_0",
    });
    expect(project.graph.nodes.some((node) => node.id === "managed_text_0")).toBe(true);
    expect(project.graph.edges.some((edge) => edge.id === "managed_text_edge_0")).toBe(true);
    expect(project.graph.groups?.[0]?.nodeIds.includes("managed_text_0")).toBe(true);

    const removed = removeManagedTextOutputNodes({
      project,
      sourceNodeId: sourceNode.id,
    });

    expect(removed.changed).toBe(true);
    expect(removed.removedNodeIds).toEqual(["managed_text_0"]);
    expect(removed.removedEdgeIds).toEqual(["managed_text_edge_0"]);
    expect(project.graph.nodes.some((node) => node.id === "managed_text_0")).toBe(false);
    expect(project.graph.edges.some((edge) => edge.id === "managed_text_edge_0")).toBe(false);
    expect(project.graph.groups?.[0]?.nodeIds.includes("managed_text_0")).toBe(false);
  });
});
