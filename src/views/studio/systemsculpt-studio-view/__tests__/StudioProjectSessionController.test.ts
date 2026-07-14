/** @jest-environment jsdom */

import { readAllStudioNotePaths, serializeStudioNoteItems } from "../../../../studio/StudioNoteConfig";
import type { StudioNodeCacheSnapshotV1, StudioNodeInstance, StudioProjectV1 } from "../../../../studio/types";
import { STUDIO_GRAPH_DEFAULT_ZOOM } from "../../StudioGraphInteractionTypes";
import { StudioProjectSessionController } from "../StudioProjectSessionController";

function noteNodeFixture(path: string): StudioNodeInstance {
  return {
    id: "note_1",
    kind: "studio.note",
    version: "1.0.0",
    title: "Old",
    position: { x: 0, y: 0 },
    config: {
      notes: serializeStudioNoteItems([{ path, enabled: true }]),
    },
    continueOnError: false,
    disabled: false,
  };
}

function projectFixture(node: StudioNodeInstance): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "project_vault_sync",
    name: "Vault Sync",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes: [node],
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 10,
        maxArtifactsMb: 128,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

function createControllerHarness(project: StudioProjectV1) {
  const cacheSnapshot: StudioNodeCacheSnapshotV1 | null = null;
  const session = {
    hasPendingLocalSaveWork: jest.fn(() => false),
    hasDeferredExternalSync: jest.fn(() => false),
    consumeDeferredExternalSync: jest.fn(() => false),
    flushPendingSaveWork: jest.fn(async () => {}),
    markAcceptedProjectSignature: jest.fn(),
    clearLiveSyncState: jest.fn(),
    schedulePersist: jest.fn(),
    getProject: jest.fn(() => project),
    mutate: jest.fn((_: string, mutator: (currentProject: StudioProjectV1) => boolean | void) => {
      return mutator(project) !== false;
    }),
    mutateAsync: jest.fn(async (_: string, mutator: (currentProject: StudioProjectV1) => Promise<boolean | void>) => {
      return (await mutator(project)) !== false;
    }),
  } as any;
  const service = {
    getProjectNodeCache: jest.fn(async () => cacheSnapshot),
    releaseProjectSession: jest.fn(async () => {}),
    retainProjectSession: jest.fn(),
    lintProjectText: jest.fn(() => ({ ok: true })),
  };
  const host = {
    app: {
      vault: {
        adapter: {},
      },
      workspace: {
        requestSaveLayout: jest.fn(),
      },
    },
    plugin: {
      getStudioService: () => service,
    },
    graphInteraction: {
      clearProjectState: jest.fn(),
      getGraphZoom: jest.fn(() => 1),
      getSelectedNodeIds: jest.fn(() => []),
      setGraphZoom: jest.fn(),
      setSelectedNodeIds: jest.fn(),
    },
    getGraphZoomMode: () => "interactive" as const,
    resetGraphZoomInteractionState: jest.fn(),
    scheduleLayoutSave: jest.fn(),
    requestLayoutSave: jest.fn(),
    getGraphViewportElement: jest.fn(() => null),
    captureProjectHistoryCheckpoint: jest.fn(),
    resetProjectHistory: jest.fn(),
    setHistoryCurrentSnapshot: jest.fn(),
    clearProjectEditorState: jest.fn(),
    clearRunPresentation: jest.fn(),
    disposeTextNodeEditors: jest.fn(),
    hydrateProjectCache: jest.fn(async () => cacheSnapshot),
    materializeManagedOutputNodesFromCache: jest.fn(),
    refreshNoteNodePreviewsFromVault: jest.fn(async () => true),
    setError: jest.fn(),
    setLastError: jest.fn(),
    render: jest.fn(),
    refreshLeafDisplay: jest.fn(),
    isMarkdownVaultFile: jest.fn(() => true),
    isVaultFolder: jest.fn(() => false),
    readAllNotePathsFromConfig: (node: StudioNodeInstance) => readAllStudioNotePaths(node.config),
    normalizeNoteNodeConfig: jest.fn(() => false),
  } as any;
  const controller = new StudioProjectSessionController(host);
  Object.assign(controller as any, {
    currentProject: project,
    currentProjectPath: "Studio/Test.systemsculpt",
    currentProjectSession: session,
  });
  return { controller, host, project, service, session };
}

describe("StudioProjectSessionController", () => {
  it("commits note path renames through the session mutation seam", async () => {
    const node = noteNodeFixture("Notes/Old.md");
    const { controller, host, project } = createControllerHarness(projectFixture(node));

    await controller.handleVaultItemRenamed(
      { path: "Notes/Renamed.md", basename: "Renamed" } as any,
      "Notes/Old.md"
    );

    expect(readAllStudioNotePaths(node.config)).toEqual(["Notes/Renamed.md"]);
    expect(node.title).toBe("Renamed");
    expect(host.refreshNoteNodePreviewsFromVault).toHaveBeenCalledWith(project, {
      onlyNodeIds: new Set([node.id]),
    });
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("commits note deletions through the session mutation seam", async () => {
    const node = noteNodeFixture("Notes/Deleted.md");
    const { controller, host, project } = createControllerHarness(projectFixture(node));

    await controller.handleVaultItemDeleted({ path: "Notes/Deleted.md" } as any);

    expect(host.refreshNoteNodePreviewsFromVault).toHaveBeenCalledWith(project, {
      onlyNodeIds: new Set([node.id]),
    });
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("captures, flushes, releases, and clears project state on close", async () => {
    const node = noteNodeFixture("Notes/Close.md");
    const { controller, host, service, session } = createControllerHarness(projectFixture(node));
    Object.assign(controller as any, {
      retainedProjectPath: "Studio/Test.systemsculpt",
      projectLiveSyncWarning: "pending external sync",
    });

    await controller.close();

    expect(host.requestLayoutSave).toHaveBeenCalledTimes(1);
    expect(host.disposeTextNodeEditors).toHaveBeenCalledTimes(1);
    expect(session.flushPendingSaveWork).toHaveBeenCalledWith({ force: undefined });
    expect(service.releaseProjectSession).toHaveBeenCalledWith("Studio/Test.systemsculpt");
    expect(host.graphInteraction.clearProjectState).toHaveBeenCalledTimes(1);
    expect(host.graphInteraction.setGraphZoom).toHaveBeenCalledWith(STUDIO_GRAPH_DEFAULT_ZOOM);
    expect(controller.getProject()).toBeNull();
    expect(controller.getProjectPath()).toBeNull();
  });
});
