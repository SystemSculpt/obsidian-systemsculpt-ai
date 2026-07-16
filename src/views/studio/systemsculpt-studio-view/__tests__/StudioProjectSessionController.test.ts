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
    blockProjectFileWrites: jest.fn(),
    waitForInFlightSave: jest.fn(async () => {}),
    matchesLastAcceptedProjectText: jest.fn(() => false),
    resumeProjectFileWrites: jest.fn(),
    flushPendingSaveWork: jest.fn(async () => {}),
    resolveProjectFileTextUpdate: jest.fn(() => ({
      signature: "external-signature",
      decision: { kind: "evaluate" },
    })),
    markAcceptedProjectSignature: jest.fn(),
    markRejectedProjectSignature: jest.fn(),
    clearProjectFileState: jest.fn(),
    schedulePersist: jest.fn(),
    getProjectPath: jest.fn(() => "Studio/Test.systemsculpt"),
    getProject: jest.fn(() => project),
    getProjectSnapshot: jest.fn(() => JSON.parse(JSON.stringify(project))),
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
    preserveProjectRecovery: jest.fn(async () => {}),
    consumeBlockedProjectRecovery: jest.fn(async () => null),
    lintProjectText: jest.fn(() => ({ ok: true })),
    adoptVisibleProjectRename: jest.fn(async (oldPath: string, newPath: string) => ({
      oldPath,
      newPath,
      project: { ...project, name: "Renamed" },
      replacedCanvasProject: null,
    })),
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
      fitSelectedNodesInViewport: jest.fn(),
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
    preserveProjectAsUndo: jest.fn(),
    setHistoryCurrentSnapshot: jest.fn(),
    clearProjectEditorState: jest.fn(),
    clearRunPresentation: jest.fn(),
    disposeTextNodeEditors: jest.fn(),
    scheduleProjectFileRetry: jest.fn(),
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

  it("adopts an ordinary project-file rename instead of reopening stale history", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Project rename.md"));
    const { controller, host, service } = createControllerHarness(project);
    Object.assign(controller as any, { retainedProjectPath: "Studio/Test.systemsculpt" });

    await controller.handleVaultItemRenamed(
      { path: "Studio/Renamed.systemsculpt", basename: "Renamed" } as any,
      "Studio/Test.systemsculpt"
    );

    expect(service.adoptVisibleProjectRename).toHaveBeenCalledWith(
      "Studio/Test.systemsculpt",
      "Studio/Renamed.systemsculpt"
    );
    expect(controller.getProjectPath()).toBe("Studio/Renamed.systemsculpt");
    expect(controller.getProject()?.name).toBe("Renamed");
    expect(controller.getProjectFileWarning()).toBeNull();
    expect(host.refreshLeafDisplay).toHaveBeenCalledTimes(1);
  });

  it("keeps the current binding and surfaces a failed project-file rename adoption", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Project rename failure.md"));
    const { controller, service } = createControllerHarness(project);
    service.adoptVisibleProjectRename.mockRejectedValueOnce(new Error("rename raced another edit"));

    await controller.handleVaultItemRenamed(
      { path: "Studio/Renamed.systemsculpt", basename: "Renamed" } as any,
      "Studio/Test.systemsculpt"
    );

    expect(controller.getProjectPath()).toBe("Studio/Test.systemsculpt");
    expect(controller.getProject()).toBe(project);
    expect(controller.getProjectFileWarning()).toContain("rename raced another edit");
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
      projectFileWarning: "file warning",
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

  it("finishes an observed file edit before close flushes and releases the project", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before close.md"));
    const fileProject = projectFixture(noteNodeFixture("Notes/Agent edit.md"));
    fileProject.name = "Agent edit loaded before close";
    const { controller, host, service, session } = createControllerHarness(originalProject);
    Object.assign(controller as any, { retainedProjectPath: "Studio/Test.systemsculpt" });
    const rawText = '{"schema":"studio.project.v1","name":"Agent edit loaded before close"}';
    host.app.vault.adapter.read = jest.fn(async () => rawText);
    session.hasPendingLocalSaveWork.mockReturnValue(true);
    session.waitForInFlightSave.mockRejectedValue(new Error("project file changed"));
    const reload = jest.spyOn(controller, "loadProjectFromPath").mockImplementation(async () => {
      Object.assign(controller as any, { currentProject: fileProject });
      return true;
    });

    const modified = controller.handleVaultItemModified({ path: "Studio/Test.systemsculpt" } as any);
    const closed = controller.close();
    await Promise.all([modified, closed]);

    expect(session.waitForInFlightSave).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("Studio/Test.systemsculpt", {
      notifyOnError: false,
      forceReload: true,
      consumeBlockedRecovery: false,
    });
    expect(host.preserveProjectAsUndo).toHaveBeenCalledWith(originalProject, []);
    expect(service.preserveProjectRecovery).toHaveBeenCalledWith(originalProject);
    expect(reload.mock.invocationCallOrder[0]).toBeLessThan(
      service.releaseProjectSession.mock.invocationCallOrder[0]
    );
  });

  it("loads a valid project-file edit and keeps pending canvas work available through Undo", async () => {
    const node = noteNodeFixture("Notes/Before.md");
    const originalProject = projectFixture(node);
    const addedNode = { ...noteNodeFixture("Notes/Added.md"), id: "note_added" };
    const fileProject = projectFixture(addedNode);
    fileProject.graph.nodes.unshift(node);
    const { controller, host, service, session } = createControllerHarness(originalProject);
    const viewport = document.createElement("div");
    host.getGraphViewportElement.mockReturnValue(viewport);
    const animationFrame = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    session.hasPendingLocalSaveWork.mockReturnValue(true);
    const load = jest.spyOn(controller, "loadProjectFromPath").mockImplementation(async () => {
      Object.assign(controller as any, { currentProject: fileProject });
      return true;
    });

    await (controller as any).processCurrentProjectFileMutation('{"schema":"studio.project.v1"}');

    expect(session.blockProjectFileWrites).toHaveBeenCalledTimes(1);
    expect(session.waitForInFlightSave).toHaveBeenCalledTimes(1);
    expect(host.disposeTextNodeEditors).toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith("Studio/Test.systemsculpt", {
      notifyOnError: false,
      forceReload: true,
      consumeBlockedRecovery: false,
    });
    expect(controller.getProject()).toBe(fileProject);
    expect(controller.getProjectFileWarning()).toBeNull();
    expect(service.preserveProjectRecovery).toHaveBeenCalledWith(originalProject);
    expect(host.preserveProjectAsUndo).toHaveBeenCalledWith(originalProject, []);
    expect(host.graphInteraction.setSelectedNodeIds).toHaveBeenCalledWith(["note_added"]);
    expect(host.graphInteraction.fitSelectedNodesInViewport).toHaveBeenCalledTimes(1);
    animationFrame.mockRestore();
  });

  it("refreshes a delayed view when another view already accepted the same file edit", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before.md"));
    const sharedSessionProject = projectFixture(noteNodeFixture("Notes/From file.md"));
    sharedSessionProject.name = "Accepted by another Studio view";
    const { controller, host, session } = createControllerHarness(originalProject);
    session.getProject.mockReturnValue(sharedSessionProject);
    session.resolveProjectFileTextUpdate.mockReturnValue({
      signature: "accepted-by-other-view",
      decision: { kind: "ignore", reason: "duplicate_accepted" },
    });

    await (controller as any).processCurrentProjectFileMutation(
      '{"schema":"studio.project.v1","name":"Accepted by another Studio view"}'
    );

    expect(controller.getProject()).toBe(sharedSessionProject);
    expect(controller.getProject()?.name).toBe("Accepted by another Studio view");
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("continues loading the file when a competing in-flight canvas save rejects", async () => {
    const node = noteNodeFixture("Notes/Before.md");
    const originalProject = projectFixture(node);
    const fileProject = projectFixture({ ...node, title: "File wins" });
    const { controller, host, service, session } = createControllerHarness(originalProject);
    let hasPendingWork = false;
    session.hasPendingLocalSaveWork.mockImplementation(() => hasPendingWork);
    session.waitForInFlightSave.mockRejectedValue(new Error("project file changed"));
    host.disposeTextNodeEditors.mockImplementation(() => {
      originalProject.name = "Final editor text preserved";
      hasPendingWork = true;
    });
    const rawText = '{"schema":"studio.project.v1","name":"File wins"}';
    host.app.vault.adapter.read = jest.fn(async () => rawText);
    jest.spyOn(controller, "loadProjectFromPath").mockImplementation(async () => {
      Object.assign(controller as any, { currentProject: fileProject });
      return true;
    });

    await (controller as any).processCurrentProjectFileMutation(rawText);

    expect(controller.getProject()).toBe(fileProject);
    expect(controller.getProjectFileWarning()).toBeNull();
    expect(host.preserveProjectAsUndo).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Final editor text preserved" }),
      []
    );
    expect(service.preserveProjectRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Final editor text preserved" })
    );
    expect(host.setError).not.toHaveBeenCalled();
  });

  it("keeps the canvas bound and does not load the file until durable recovery succeeds", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before recovery failure.md"));
    const fileProject = projectFixture(noteNodeFixture("Notes/File still wins.md"));
    const { controller, host, service, session } = createControllerHarness(originalProject);
    session.hasPendingLocalSaveWork.mockReturnValue(true);
    service.preserveProjectRecovery.mockRejectedValue(new Error("recovery storage unavailable"));
    const rawText = '{"schema":"studio.project.v1","name":"File still wins"}';
    host.app.vault.adapter.read = jest.fn(async () => rawText);
    const load = jest.spyOn(controller, "loadProjectFromPath").mockImplementation(async () => {
      Object.assign(controller as any, { currentProject: fileProject });
      return true;
    });

    await (controller as any).processCurrentProjectFileMutation(rawText);

    expect(controller.getProject()).toBe(originalProject);
    expect(controller.getProjectFileWarning()).toContain("couldn't preserve the current canvas");
    expect(service.preserveProjectRecovery).toHaveBeenCalledWith(originalProject);
    expect(load).not.toHaveBeenCalled();
    expect(host.preserveProjectAsUndo).not.toHaveBeenCalled();
    expect(host.scheduleProjectFileRetry).toHaveBeenCalledTimes(1);
  });

  it("restores the retained session binding and rejects close when recovery cannot be stored", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Close recovery.md"));
    const { controller, service, session } = createControllerHarness(originalProject);
    Object.assign(controller as any, {
      retainedProjectPath: "Studio/Test.systemsculpt",
      currentProjectSession: session,
    });
    service.releaseProjectSession.mockRejectedValueOnce(new Error("recovery storage unavailable"));

    await expect(controller.close()).rejects.toThrow("recovery storage unavailable");

    expect((controller as any).retainedProjectPath).toBe("Studio/Test.systemsculpt");
    expect((controller as any).currentProjectSession).toBe(session);
    expect(controller.getProject()).toBe(originalProject);
  });

  it("keeps a successfully loaded file current when optional preview hydration fails", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before.md"));
    const fileProject = projectFixture(noteNodeFixture("Notes/From file.md"));
    fileProject.name = "Loaded from file";
    const { controller, host, service, session } = createControllerHarness(originalProject);
    Object.assign(controller as any, { retainedProjectPath: "Studio/Test.systemsculpt" });
    session.getProject.mockReturnValue(fileProject);
    service.retainProjectSession.mockResolvedValue(session);
    host.refreshNoteNodePreviewsFromVault.mockRejectedValue(new Error("preview unavailable"));

    const loaded = await controller.loadProjectFromPath("Studio/Test.systemsculpt", {
      notifyOnError: false,
      forceReload: true,
    });

    expect(loaded).toBe(true);
    expect(controller.getProject()).toBe(fileProject);
    expect(controller.getProject()?.name).toBe("Loaded from file");
    expect(host.resetProjectHistory).toHaveBeenCalledWith(fileProject);
    expect(host.setError).not.toHaveBeenCalled();
  });

  it("serializes overlapping project-file modify events in observed order", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Queue.md"));
    const { controller, host } = createControllerHarness(project);
    host.app.vault.adapter.read = jest
      .fn()
      .mockResolvedValueOnce("first file bytes")
      .mockResolvedValueOnce("second file bytes");
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];
    jest.spyOn(controller as any, "processCurrentProjectFileMutation").mockImplementation(async (rawText: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push(rawText);
      if (seen.length === 1) await firstMayFinish;
      active -= 1;
    });

    const first = controller.handleVaultItemModified({ path: "Studio/Test.systemsculpt" } as any);
    const second = controller.handleVaultItemModified({ path: "Studio/Test.systemsculpt" } as any);
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    expect(seen).toEqual(["first file bytes", "second file bytes"]);
    expect(maxActive).toBe(1);
  });

  it("finishes an observed file edit before a path switch advances the binding", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Before switch.md"));
    const { controller, host, service, session } = createControllerHarness(project);
    Object.assign(controller as any, { retainedProjectPath: "Studio/Test.systemsculpt" });
    host.app.vault.adapter.read = jest.fn(async () => "agent file bytes");
    const processFileEdit = jest
      .spyOn(controller as any, "processCurrentProjectFileMutation")
      .mockResolvedValue(undefined);

    const modified = controller.handleVaultItemModified({ path: "Studio/Test.systemsculpt" } as any);
    const switched = controller.loadProjectFromPath("Notes/Not a Studio project.md", {
      notifyOnError: false,
    });
    const [, loaded] = await Promise.all([modified, switched]);

    expect(loaded).toBe(false);
    expect(processFileEdit).toHaveBeenCalledWith("agent file bytes");
    expect(processFileEdit.mock.invocationCallOrder[0]).toBeLessThan(
      host.disposeTextNodeEditors.mock.invocationCallOrder[0]
    );
    expect(processFileEdit.mock.invocationCallOrder[0]).toBeLessThan(
      session.flushPendingSaveWork.mock.invocationCallOrder[0]
    );
    expect(processFileEdit.mock.invocationCallOrder[0]).toBeLessThan(
      service.releaseProjectSession.mock.invocationCallOrder[0]
    );
  });

  it("keeps a duplicate rejected file blocked and repeats its validation warning", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Still invalid.md"));
    const { controller, host, service, session } = createControllerHarness(project);
    session.resolveProjectFileTextUpdate.mockReturnValue({
      signature: "same-invalid-file",
      decision: { kind: "ignore", reason: "duplicate_rejected" },
    });
    service.lintProjectText.mockReturnValue({ ok: false, error: "Unexpected token" });

    await (controller as any).processCurrentProjectFileMutation("{");

    expect(session.blockProjectFileWrites).toHaveBeenCalledTimes(1);
    expect(controller.getProjectFileWarning()).toContain("Unexpected token");
    expect(controller.getProjectFileWarning()).toContain("Fix the file");
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("retries a transient null read without allowing a canvas overwrite", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Retry.md"));
    const { controller, host, session } = createControllerHarness(project);
    const retryCallbacks: Array<() => void> = [];
    host.scheduleProjectFileRetry.mockImplementation((callback: () => void) => {
      retryCallbacks.push(callback);
    });
    host.app.vault.adapter.read = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("recovered file bytes");
    const processFileEdit = jest
      .spyOn(controller as any, "processCurrentProjectFileMutation")
      .mockResolvedValue(undefined);

    await controller.handleVaultItemModified({ path: "Studio/Test.systemsculpt" } as any);

    expect(session.blockProjectFileWrites).toHaveBeenCalledTimes(1);
    expect(controller.getProjectFileWarning()).toContain("retry automatically");
    expect(retryCallbacks).toHaveLength(1);

    retryCallbacks[0]();
    await (controller as any).projectFileMutationTail;

    expect(processFileEdit).toHaveBeenCalledWith("recovered file bytes");
  });

  it("explains an invalid project file without sync bookkeeping language", async () => {
    const node = noteNodeFixture("Notes/Invalid.md");
    const { controller, host, project, service, session } = createControllerHarness(projectFixture(node));
    service.lintProjectText.mockReturnValue({ ok: false, error: "Unexpected token" });

    await (controller as any).processCurrentProjectFileMutation("{");

    expect(controller.getProject()).toBe(project);
    expect(session.markRejectedProjectSignature).toHaveBeenCalledWith("external-signature");
    expect(session.blockProjectFileWrites).toHaveBeenCalledTimes(1);
    expect(controller.getProjectFileWarning()).toContain("Fix the file");
    expect(controller.getProjectFileWarning()).not.toMatch(
      /external|sync|projection|authority|generation|candidate|marker|revision|hash/i
    );
    expect(host.render).toHaveBeenCalledTimes(1);
  });
});
