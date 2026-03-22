import {
  MANAGED_MEDIA_OWNER,
  MANAGED_MEDIA_OWNER_KEY,
  MANAGED_MEDIA_SLOT_INDEX_KEY,
  MANAGED_MEDIA_SOURCE_NODE_ID_KEY,
  MANAGED_OUTPUT_PENDING_KEY,
  MANAGED_OUTPUT_PENDING_RUN_ID_KEY,
  MANAGED_TEXT_OWNER,
  MANAGED_TEXT_OWNER_KEY,
  MANAGED_TEXT_SLOT_INDEX_KEY,
  MANAGED_TEXT_SOURCE_NODE_ID_KEY,
} from "../StudioManagedOutputNodes";
import {
  normalizeLegacyMediaNodeTitles,
  repairStudioProjectForLoad,
} from "../StudioProjectRepairs";
import type { StudioNodeInstance, StudioProjectV1 } from "../types";

function createProject(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "project_repairs",
    name: "Repairs",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes,
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/policy.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 10,
        maxArtifactsMb: 32,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

describe("StudioProjectRepairs", () => {
  it("normalizes legacy media ingest titles", () => {
    const mediaNode: StudioNodeInstance = {
      id: "media_1",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Media Ingest",
      position: { x: 100, y: 100 },
      config: { sourcePath: "Assets/input.png" },
      continueOnError: false,
      disabled: false,
    };
    const project = createProject([mediaNode]);

    const changed = normalizeLegacyMediaNodeTitles(project);

    expect(changed).toBe(true);
    expect(project.graph.nodes[0]?.title).toBe("Media");
  });

  it("repairs load-time project state in one core pass", () => {
    const imageSource: StudioNodeInstance = {
      id: "image_source",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Images",
      position: { x: 120, y: 120 },
      config: { count: 1 },
      continueOnError: false,
      disabled: false,
    };
    const textSource: StudioNodeInstance = {
      id: "text_source",
      kind: "studio.text_generation",
      version: "1.0.0",
      title: "Writer",
      position: { x: 120, y: 360 },
      config: {},
      continueOnError: false,
      disabled: false,
    };
    const legacyMedia: StudioNodeInstance = {
      id: "legacy_media",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Media Ingest",
      position: { x: 420, y: 120 },
      config: { sourcePath: "Assets/existing.png" },
      continueOnError: false,
      disabled: false,
    };
    const pendingManagedMedia: StudioNodeInstance = {
      id: "pending_media",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Pending Output",
      position: { x: 420, y: 120 },
      config: {
        sourcePath: "",
        [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
        [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: imageSource.id,
        [MANAGED_MEDIA_SLOT_INDEX_KEY]: 0,
        [MANAGED_OUTPUT_PENDING_KEY]: true,
        [MANAGED_OUTPUT_PENDING_RUN_ID_KEY]: "run_pending",
      },
      continueOnError: false,
      disabled: false,
    };
    const managedText: StudioNodeInstance = {
      id: "managed_text",
      kind: "studio.text",
      version: "1.0.0",
      title: "Managed Text",
      position: { x: 420, y: 360 },
      config: {
        value: "Generated output",
        [MANAGED_TEXT_OWNER_KEY]: MANAGED_TEXT_OWNER,
        [MANAGED_TEXT_SOURCE_NODE_ID_KEY]: textSource.id,
        [MANAGED_TEXT_SLOT_INDEX_KEY]: 0,
      },
      continueOnError: false,
      disabled: false,
    };
    const project = createProject([
      imageSource,
      textSource,
      legacyMedia,
      pendingManagedMedia,
      managedText,
    ]);
    project.graph.edges = [
      {
        id: "edge_pending_media",
        fromNodeId: imageSource.id,
        fromPortId: "images",
        toNodeId: pendingManagedMedia.id,
        toPortId: "media",
      },
      {
        id: "edge_managed_text",
        fromNodeId: textSource.id,
        fromPortId: "text",
        toNodeId: managedText.id,
        toPortId: "text",
      },
    ];
    project.graph.groups = [
      {
        id: "group_1",
        name: "Primary",
        nodeIds: [imageSource.id, pendingManagedMedia.id, "missing_node", imageSource.id],
      },
      {
        id: "group_1",
        name: "Duplicate",
        nodeIds: [managedText.id],
      },
    ];

    const changed = repairStudioProjectForLoad(project);

    expect(changed).toBe(true);
    expect(project.graph.nodes.map((node) => node.id)).toEqual([
      imageSource.id,
      textSource.id,
      legacyMedia.id,
    ]);
    expect(project.graph.edges).toEqual([]);
    expect(project.graph.nodes.find((node) => node.id === legacyMedia.id)?.title).toBe("Media");
    expect(project.graph.groups).toEqual([
      {
        id: "group_1",
        name: "Primary",
        nodeIds: [imageSource.id],
      },
    ]);
  });
});
