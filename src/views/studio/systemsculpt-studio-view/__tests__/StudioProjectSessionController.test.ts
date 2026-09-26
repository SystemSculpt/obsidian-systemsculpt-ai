/** @jest-environment jsdom */

import { StudioGraphHistory } from "../../StudioGraphHistory";
import { StudioProjectSession } from "../../../../studio/StudioProjectSession";
import { TFile } from "obsidian";
import { StudioVaultNotes } from "../../StudioVaultNotes";
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
    subscribe: jest.fn(() => () => undefined),
    getConflictRecovery: jest.fn(() => null),
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
    reconcileProjectFile: jest.fn(async () => ({ conflicts: [] })),
    reconcileProjectClock: jest.fn(async (): Promise<{ conflicts: string[] } | null> => null),
    adoptVisibleProjectRename: jest.fn(async (oldPath: string, newPath: string) => ({
      oldPath,
      newPath,
      project: { ...project, name: "Renamed" },
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
    history: new StudioGraphHistory(),
    resetProjectHistory: jest.fn(),
    preserveProjectAsUndo: jest.fn(),
    setHistoryCurrentSnapshot: jest.fn(),
    clearProjectEditorState: jest.fn(),
    clearRunPresentation: jest.fn(),
    disposeTextNodeEditors: jest.fn(),
    scheduleProjectFileRetry: jest.fn(),
    hydrateProjectCache: jest.fn(async () => cacheSnapshot),
    materializeManagedOutputNodesFromCache: jest.fn(),
    setError: jest.fn(),
    setLastError: jest.fn(),
    render: jest.fn(),
    refreshLeafDisplay: jest.fn(),
  } as any;
  host.vaultNotes = new StudioVaultNotes(host.app.vault, { primeNodeOutput: jest.fn() });
  jest.spyOn(host.vaultNotes, "refresh").mockResolvedValue(true);
  const controller = new StudioProjectSessionController(host);
  Object.assign(controller as any, {
    currentProject: project,
    currentProjectPath: "Studio/Test.systemsculpt",
    currentProjectSession: session,
  });
  return { controller, host, project, service, session };
}

describe("StudioProjectSessionController", () => {
  it("renders peer mutations while an originating asynchronous edit awaits completion", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Shared.md"));
    const session = new StudioProjectSession({ projectPath: "Studio/Test.systemsculpt", project, saveProject: async () => {} });
    const first = createControllerHarness(project);
    const second = createControllerHarness(project);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    try {
      for (const harness of [first, second]) {
        await harness.controller.loadProjectFromPath(null);
        harness.service.retainProjectSession.mockResolvedValue(session);
        harness.host.vaultNotes.refresh.mockResolvedValue(false);
        await harness.controller.loadProjectFromPath("Studio/Test.systemsculpt");
        harness.host.render.mockClear();
      }
      const pending = first.controller.commitMutationAsync("node.config", async draft => {
        await waiting;
        draft.graph.nodes[0].config.preface = "Generated text";
        return true;
      }, { captureHistory: false });

      second.controller.commitMutation("node.title", current => { current.graph.nodes[0].title = "Peer typing"; });
      expect(first.host.render).toHaveBeenCalledTimes(1);
      expect(second.host.render).not.toHaveBeenCalled();
      expect(first.controller.getProject()?.graph.nodes[0].title).toBe("Peer typing");

      release();
      await pending;
      expect(first.host.render).toHaveBeenCalledTimes(2);
      expect(second.host.render).toHaveBeenCalledTimes(1);
      for (const harness of [first, second]) {
        expect(harness.controller.getProject()?.graph.nodes[0].title).toBe("Peer typing");
        expect(harness.controller.getProject()?.graph.nodes[0].config.preface).toBe("Generated text");
      }
    } finally {
      release();
      await first.controller.close();
      await second.controller.close();
      await session.close();
    }
  });

  it("commits note path renames through the session mutation seam", async () => {
    const node = noteNodeFixture("Notes/Old.md");
    const { controller, host, project } = createControllerHarness(projectFixture(node));

    await controller.handleVaultItemRenamed(
      Object.assign(new TFile(), { path: "Notes/Renamed.md", basename: "Renamed", extension: "md" }),
      "Notes/Old.md"
    );

    expect(readAllStudioNotePaths(node.config)).toEqual(["Notes/Renamed.md"]);
    expect(node.title).toBe("Renamed");
    expect(host.vaultNotes.refresh).toHaveBeenCalledWith(project, {
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

    await controller.handleVaultItemDeleted(Object.assign(new TFile(), { path: "Notes/Deleted.md", extension: "md" }));

    expect(host.vaultNotes.refresh).toHaveBeenCalledWith(project, {
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

  it("finishes central file reconciliation before close releases the project", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before close.md"));
    const { controller, host, service, session } = createControllerHarness(originalProject);
    Object.assign(controller as any, { retainedProjectPath: "Studio/Test.systemsculpt" });
    const rawText = '{"schema":"studio.project.v1","name":"Agent edit loaded before close"}';
    host.app.vault.adapter.read = jest.fn(async () => rawText);
    let finishReconciliation!: () => void;
    service.reconcileProjectFile.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishReconciliation = resolve; });
      return { conflicts: [] };
    });

    const modified = controller.handleVaultItemModified({ path: "Studio/Test.systemsculpt" } as any);
    while (service.reconcileProjectFile.mock.calls.length === 0) await Promise.resolve();
    const closed = controller.close();
    finishReconciliation();
    await Promise.all([modified, closed]);

    expect(service.reconcileProjectFile).toHaveBeenCalledWith("Studio/Test.systemsculpt", rawText);
    expect(service.reconcileProjectFile.mock.invocationCallOrder[0]).toBeLessThan(
      service.releaseProjectSession.mock.invocationCallOrder[0]
    );
    expect(host.disposeTextNodeEditors).toHaveBeenCalledTimes(1); // close only
  });

  it("reconciles a valid project-file edit without disposing editors or reloading the view", async () => {
    const node = noteNodeFixture("Notes/Before.md");
    const originalProject = projectFixture(node);
    const addedNode = { ...noteNodeFixture("Notes/Added.md"), id: "note_added" };
    const fileProject = projectFixture(addedNode);
    fileProject.graph.nodes.unshift(node);
    const { controller, host, service, session } = createControllerHarness(originalProject);
    session.getProject.mockReturnValue(fileProject);
    const load = jest.spyOn(controller, "loadProjectFromPath");

    await (controller as any).processCurrentProjectFileMutation('{"schema":"studio.project.v1"}');

    expect(service.reconcileProjectFile).toHaveBeenCalledWith("Studio/Test.systemsculpt", '{"schema":"studio.project.v1"}');
    expect(load).not.toHaveBeenCalled();
    expect(host.disposeTextNodeEditors).not.toHaveBeenCalled();
    expect(controller.getProject()).toBe(fileProject);
    expect(controller.getProjectFileWarning()).toBeNull();
    expect(service.preserveProjectRecovery).not.toHaveBeenCalled();
    expect(host.preserveProjectAsUndo).not.toHaveBeenCalled();
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("settles merges that waited for another device's clock when a clock file beside the project appears or changes", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Before.md"));
    const { controller, host, service, session } = createControllerHarness(project);
    const settled = projectFixture(noteNodeFixture("Notes/After.md"));
    session.getProject.mockReturnValue(settled);
    const restored = "Studio restored changes from this device that an older copy of this file from another device had replaced.";
    service.reconcileProjectClock.mockResolvedValueOnce({ conflicts: [restored] });
    const clock = "Studio/Test.systemsculpt-assets/clock/bbbbbbbbbbbb.json";

    await controller.handleVaultItemCreated({ path: clock } as any);
    expect(service.reconcileProjectClock).toHaveBeenCalledWith("Studio/Test.systemsculpt");
    expect(controller.getProject()).toBe(settled);
    expect(controller.getProjectFileWarning()).toBe(restored);
    expect(host.render).toHaveBeenCalledTimes(1);

    // A clock change that finds nothing waiting leaves the view alone.
    await controller.handleVaultItemModified({ path: clock } as any);
    expect(service.reconcileProjectClock).toHaveBeenCalledTimes(2);
    expect(host.render).toHaveBeenCalledTimes(1);
    expect(service.reconcileProjectFile).not.toHaveBeenCalled();

    // Other support files are not clocks.
    await controller.handleVaultItemCreated({ path: "Studio/Test.systemsculpt-assets/runs/run.json" } as any);
    expect(service.reconcileProjectClock).toHaveBeenCalledTimes(2);
  });

  it("ignores a duplicate file event already accepted by the shared session", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before.md"));
    const sharedSessionProject = projectFixture(noteNodeFixture("Notes/From file.md"));
    sharedSessionProject.name = "Accepted by another Studio view";
    const { controller, host, service, session } = createControllerHarness(originalProject);
    session.getProject.mockReturnValue(sharedSessionProject);
    session.resolveProjectFileTextUpdate.mockReturnValue({
      signature: "accepted-by-other-view",
      decision: { kind: "ignore", reason: "duplicate_accepted" },
    });

    await (controller as any).processCurrentProjectFileMutation(
      '{"schema":"studio.project.v1","name":"Accepted by another Studio view"}'
    );

    expect(controller.getProject()).toBe(originalProject);
    expect(service.reconcileProjectFile).not.toHaveBeenCalled();
    expect(host.render).not.toHaveBeenCalled();
  });

  it("accepts the service's reconciled shared session state without view teardown", async () => {
    const node = noteNodeFixture("Notes/Before.md");
    const originalProject = projectFixture(node);
    const fileProject = projectFixture({ ...node, title: "File wins" });
    const { controller, host, service, session } = createControllerHarness(originalProject);
    session.getProject.mockReturnValue(fileProject);
    const rawText = '{"schema":"studio.project.v1","name":"File wins"}';
    host.app.vault.adapter.read = jest.fn(async () => rawText);

    await (controller as any).processCurrentProjectFileMutation(rawText);

    expect(controller.getProject()).toBe(fileProject);
    expect(controller.getProjectFileWarning()).toBeNull();
    expect(service.reconcileProjectFile).toHaveBeenCalledWith("Studio/Test.systemsculpt", rawText);
    expect(host.disposeTextNodeEditors).not.toHaveBeenCalled();
    expect(host.preserveProjectAsUndo).not.toHaveBeenCalled();
    expect(service.preserveProjectRecovery).not.toHaveBeenCalled();
    expect(host.setError).not.toHaveBeenCalled();
  });

  it("keeps the canvas and interactions bound when invalid bytes cannot be imported", async () => {
    const originalProject = projectFixture(noteNodeFixture("Notes/Before recovery failure.md"));
    const { controller, host, service, session } = createControllerHarness(originalProject);
    service.reconcileProjectFile.mockRejectedValueOnce(new Error("Studio couldn't read this project file: Unexpected token"));
    const rawText = '{"schema":"studio.project.v1","name":"File still wins"}';
    host.app.vault.adapter.read = jest.fn(async () => rawText);
    const load = jest.spyOn(controller, "loadProjectFromPath");

    await (controller as any).processCurrentProjectFileMutation(rawText);

    expect(controller.getProject()).toBe(originalProject);
    expect(controller.getProjectFileWarning()).toContain("couldn't read this project file");
    expect(load).not.toHaveBeenCalled();
    expect(host.disposeTextNodeEditors).not.toHaveBeenCalled();
    expect(session.blockProjectFileWrites).not.toHaveBeenCalled();
    expect(host.preserveProjectAsUndo).not.toHaveBeenCalled();
    expect(host.render).toHaveBeenCalledTimes(1);
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
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const originalProject = projectFixture(noteNodeFixture("Notes/Before.md"));
    const fileProject = projectFixture(noteNodeFixture("Notes/From file.md"));
    fileProject.name = "Loaded from file";
    const { controller, host, service, session } = createControllerHarness(originalProject);
    Object.assign(controller as any, { retainedProjectPath: "Studio/Test.systemsculpt" });
    session.getProject.mockReturnValue(fileProject);
    service.retainProjectSession.mockResolvedValue(session);
    host.vaultNotes.refresh.mockRejectedValue(new Error("preview unavailable"));

    const loaded = await controller.loadProjectFromPath("Studio/Test.systemsculpt", {
      notifyOnError: false,
      forceReload: true,
    });

    expect(loaded).toBe(true);
    expect(controller.getProject()).toBe(fileProject);
    expect(controller.getProject()?.name).toBe("Loaded from file");
    expect(host.resetProjectHistory).toHaveBeenCalledWith(fileProject);
    expect(host.setError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[SystemSculpt Studio] Unable to refresh note previews on project load",
      {
        projectPath: "Studio/Test.systemsculpt",
        error: "preview unavailable",
      },
    );
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

  it("routes a duplicate rejected file through the service and repeats its warning", async () => {
    const project = projectFixture(noteNodeFixture("Notes/Still invalid.md"));
    const { controller, host, service, session } = createControllerHarness(project);
    session.resolveProjectFileTextUpdate.mockReturnValue({
      signature: "same-invalid-file",
      decision: { kind: "ignore", reason: "duplicate_rejected" },
    });
    service.reconcileProjectFile.mockRejectedValueOnce(new Error("Studio couldn't read this project file: Unexpected token"));

    await (controller as any).processCurrentProjectFileMutation("{");

    expect(service.reconcileProjectFile).toHaveBeenCalledWith("Studio/Test.systemsculpt", "{");
    expect(session.blockProjectFileWrites).not.toHaveBeenCalled();
    expect(controller.getProjectFileWarning()).toContain("Unexpected token");
    expect(controller.getProjectFileWarning()).toContain("Studio couldn't read this project file");
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("retries a transient null read while leaving durable transaction writes enabled", async () => {
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

    expect(session.blockProjectFileWrites).not.toHaveBeenCalled();
    expect(session.resumeProjectFileWrites).toHaveBeenCalledTimes(1);
    expect(controller.getProjectFileWarning()).toContain("retry automatically");
    expect(retryCallbacks).toHaveLength(1);

    retryCallbacks[0]();
    await (controller as any).projectFileMutationTail;

    expect(processFileEdit).toHaveBeenCalledWith("recovered file bytes");
  });

  it("explains an invalid project file without blocking the shared session", async () => {
    const node = noteNodeFixture("Notes/Invalid.md");
    const { controller, host, project, service, session } = createControllerHarness(projectFixture(node));
    service.reconcileProjectFile.mockRejectedValueOnce(new Error("Studio couldn't read this project file: Unexpected token"));

    await (controller as any).processCurrentProjectFileMutation("{");

    expect(controller.getProject()).toBe(project);
    expect(session.markRejectedProjectSignature).not.toHaveBeenCalled();
    expect(session.blockProjectFileWrites).not.toHaveBeenCalled();
    expect(controller.getProjectFileWarning()).toContain("Studio couldn't read this project file");
    expect(controller.getProjectFileWarning()).not.toMatch(
      /external|sync|projection|authority|generation|candidate|marker|revision|hash/i
    );
    expect(host.render).toHaveBeenCalledTimes(1);
  });
});
