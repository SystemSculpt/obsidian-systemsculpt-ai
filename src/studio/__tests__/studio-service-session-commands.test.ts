import { StudioProjectSession } from "../StudioProjectSession";
import { StudioService } from "../StudioService";
import { serializeStudioProject } from "../schema";
import type { StudioProjectV1 } from "../types";
import { createManagedCapabilityGraphStub, getManagedStudioTestVaultName } from "./managed-capability-graph.stub";

function createPluginStub(): any {
  const adapter = {
    exists: jest.fn(async () => false),
    mkdir: jest.fn(async () => {}),
    write: jest.fn(async () => {}),
    read: jest.fn(async () => ""),
  };
  return {
    app: {
      vault: {
        adapter,
        getName: getManagedStudioTestVaultName,
        configDir: ".obsidian",
      },
    },
    manifest: {
      id: "systemsculpt-ai",
      version: "9.9.9",
      dir: "/tmp/systemsculpt-ai",
    },
    settings: {
      studioDefaultProjectsFolder: "SystemSculpt/Studio",
      studioRunRetentionMaxRuns: 100,
      studioRunRetentionMaxArtifactsMb: 1024,
      licenseKey: "test-license-key",
      serverUrl: "https://systemsculpt.com",
    },
    getLogger: () => ({
      warn: jest.fn(),
      error: jest.fn(),
    }),
    getManagedCapabilityGraph: createManagedCapabilityGraphStub,
  };
}

function projectFixture(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_test",
    name: "Test Project",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes: [],
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

function createSession(
  projectPath = "Studio/Test.systemsculpt",
  project: StudioProjectV1 = projectFixture()
): StudioProjectSession {
  return new StudioProjectSession({
    projectPath,
    project,
    saveProject: jest.fn(async () => {}),
    readProjectRawText: jest.fn(async () => "{}"),
  });
}

async function retainExistingSession(service: StudioService, session: StudioProjectSession): Promise<void> {
  await (service as any).projectSessionManager.retainSession(session.getProjectPath(), async () => session);
}

describe("StudioService session-backed mutation commands", () => {
  it("mutates retained sessions by project path", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    await retainExistingSession(service, session);

    const changed = service.mutateProject(session.getProjectPath(), "node.title", (project) => {
      project.name = "Renamed from service";
      return true;
    });

    expect(changed).toBe(true);
    expect(session.getProject().name).toBe("Renamed from service");
    expect(service.getProjectSession(session.getProjectPath())).toBe(session);
  });

  it("refuses mutations for paths without a retained session", () => {
    const service = new StudioService(createPluginStub());

    const changed = service.mutateProject("Studio/Nowhere.systemsculpt", "node.title", (project) => {
      project.name = "Should never run";
      return true;
    });

    expect(changed).toBe(false);
  });

  it("returns defensive project snapshots from retained sessions", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    await retainExistingSession(service, session);

    const snapshot = service.getProjectSession(session.getProjectPath())!.getProjectSnapshot();
    snapshot.name = "Mutated outside service";

    expect(session.getProject().name).toBe("Test Project");
  });

  it("reuses an already-retained session for same-path retains without reloading", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    const loadProjectForSession = jest.spyOn(service as any, "loadProjectForSession");
    await retainExistingSession(service, session);

    const reopened = await service.retainProjectSession(session.getProjectPath());

    expect(reopened).toBe(session);
    expect(loadProjectForSession).not.toHaveBeenCalled();
  });

  it("force reload keeps the same session object but replaces its snapshot", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    const reloadedProject = projectFixture();
    reloadedProject.name = "Reloaded Project";
    const loadProjectForSession = jest
      .spyOn(service as any, "loadProjectForSession")
      .mockResolvedValue({ project: reloadedProject, rawText: '{"name":"Reloaded Project"}' });
    await retainExistingSession(service, session);

    const reopened = await service.retainProjectSession(session.getProjectPath(), { forceReload: true });

    expect(reopened).toBe(session);
    expect(loadProjectForSession).toHaveBeenCalledWith(session.getProjectPath(), { forceReload: true });
    expect(session.getProject().name).toBe("Reloaded Project");
  });

  it("preserves resized media ingest geometry when legacy config is normalized during reload", async () => {
    const service = new StudioService(createPluginStub());
    const reloadedProject = projectFixture();
    reloadedProject.graph.nodes.push({
      id: "media_1",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Media Ingest",
      position: { x: 0, y: 0 },
      config: {
        vaultPath: "/media/input.mp4",
        sourceMode: "local",
        assetMode: "auto",
        mediaKind: "video",
        width: 512,
        height: 356,
        captionBoard: {
          version: 1,
          labels: [],
        },
      },
      continueOnError: false,
      disabled: false,
    });
    const loadProject = jest
      .spyOn((service as any).projectStore, "loadProject")
      .mockResolvedValue(reloadedProject);
    const saveProject = jest
      .spyOn((service as any).projectStore, "saveProject")
      .mockResolvedValue();
    jest.spyOn((service as any).projectStore, "readProjectRawText").mockResolvedValue("{}");
    jest.spyOn(service as any, "ensureDefaultPolicy").mockResolvedValue(undefined);

    const session = await service.retainProjectSession("Studio/Test.systemsculpt", { forceReload: true });
    const mediaNode = session.getProject().graph.nodes.find((node) => node.id === "media_1");

    expect(loadProject).toHaveBeenCalledWith("Studio/Test.systemsculpt", { forceReload: true });
    // Resized geometry survives normalization as first-class node.size;
    // caption edits stay in config and the legacy geometry keys are stripped.
    expect(mediaNode?.size).toEqual({ width: 512, height: 356 });
    expect(mediaNode?.config).toEqual({
      sourcePath: "/media/input.mp4",
      captionBoard: {
        version: 1,
        labels: [],
      },
    });
    expect(saveProject).toHaveBeenCalledWith(
      "Studio/Test.systemsculpt",
      expect.objectContaining({
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "media_1",
              size: { width: 512, height: 356 },
              config: expect.objectContaining({
                sourcePath: "/media/input.mp4",
              }),
            }),
          ]),
        }),
      })
    );
  });

  it("runs a project from its retained session snapshot", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    const flushSpy = jest.spyOn(session, "flushPendingSaveWork").mockResolvedValue();
    session.mutate("project.repair", (project) => {
      project.name = "Live Session Snapshot";
      return true;
    });
    await retainExistingSession(service, session);

    const summary = {
      runId: "run_live",
      status: "success",
      startedAt: "2026-03-22T00:00:00.000Z",
      finishedAt: "2026-03-22T00:00:01.000Z",
      error: null,
      executedNodeIds: [],
      cachedNodeIds: [],
    } as const;
    const runtime = {
      runProjectSnapshot: jest.fn(async () => summary),
      runProject: jest.fn(async () => summary),
    };
    (service as any).runtime = runtime;

    const result = await service.runProject(session.getProjectPath());

    expect(result).toBe(summary);
    expect(flushSpy).toHaveBeenCalledWith({ force: true });
    expect(runtime.runProjectSnapshot).toHaveBeenCalledWith(
      session.getProjectPath(),
      expect.objectContaining({ name: "Live Session Snapshot" }),
      { onEvent: undefined }
    );
    expect(runtime.runProject).not.toHaveBeenCalled();
  });

  it("falls back to a store-backed run when no session is retained for the path", async () => {
    const service = new StudioService(createPluginStub());
    const summary = {
      runId: "run_cold",
      status: "success",
      startedAt: "2026-03-22T00:00:00.000Z",
      finishedAt: "2026-03-22T00:00:01.000Z",
      error: null,
      executedNodeIds: [],
      cachedNodeIds: [],
    } as const;
    const runtime = {
      runProjectSnapshot: jest.fn(async () => summary),
      runProject: jest.fn(async () => summary),
    };
    (service as any).runtime = runtime;

    const result = await service.runProject("Studio/Cold.systemsculpt");

    expect(result).toBe(summary);
    expect(runtime.runProject).toHaveBeenCalledWith("Studio/Cold.systemsculpt", { onEvent: undefined });
    expect(runtime.runProjectSnapshot).not.toHaveBeenCalled();
  });

  it("runs scoped node executions from the retained session snapshot", async () => {
    const project = projectFixture();
    project.graph.nodes.push({
      id: "node_live",
      kind: "studio.text_output",
      version: "1.0.0",
      title: "Live Node",
      position: { x: 0, y: 0 },
      config: { value: "Live" },
      continueOnError: false,
      disabled: false,
    });
    const service = new StudioService(createPluginStub());
    const session = createSession("Studio/Scoped.systemsculpt", project);
    const flushSpy = jest.spyOn(session, "flushPendingSaveWork").mockResolvedValue();
    const loadProjectSpy = jest.spyOn((service as any).projectStore, "loadProject");
    await retainExistingSession(service, session);

    const summary = {
      runId: "run_scoped",
      status: "success",
      startedAt: "2026-03-22T00:00:00.000Z",
      finishedAt: "2026-03-22T00:00:01.000Z",
      error: null,
      executedNodeIds: ["node_live"],
      cachedNodeIds: [],
    } as const;
    const runtime = {
      runProjectSnapshot: jest.fn(async () => summary),
      runProject: jest.fn(async () => summary),
    };
    (service as any).runtime = runtime;

    const result = await service.runProjectFromNode(session.getProjectPath(), "node_live");

    expect(result).toBe(summary);
    expect(flushSpy).toHaveBeenCalledWith({ force: true });
    expect(loadProjectSpy).not.toHaveBeenCalled();
    expect(runtime.runProjectSnapshot).toHaveBeenCalledWith(
      session.getProjectPath(),
      expect.objectContaining({
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ id: "node_live" })]),
        }),
      }),
      {
        entryNodeIds: ["node_live"],
        forceNodeIds: ["node_live"],
        onEvent: undefined,
      }
    );
    expect(runtime.runProject).not.toHaveBeenCalled();
  });

  it("renames a project and moves the retained session to the new path", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    const flushSpy = jest.spyOn(session, "flushPendingSaveWork").mockResolvedValue();
    const renamedProject = {
      ...projectFixture(),
      name: "Renamed Project",
      permissionsRef: {
        policyVersion: 1,
        policyPath: "Studio/Renamed.systemsculpt-assets/policy/grants.json",
      },
    };
    jest.spyOn((service as any).projectStore, "renameProject").mockResolvedValue({
      oldPath: "Studio/Test.systemsculpt",
      newPath: "Studio/Renamed.systemsculpt",
      project: renamedProject,
    });
    jest.spyOn((service as any).projectStore, "readProjectRawText").mockResolvedValue(
      '{"name":"Renamed Project"}'
    );
    await retainExistingSession(service, session);

    const renamed = await service.renameProject("Studio/Test.systemsculpt", "Renamed");

    expect(flushSpy).toHaveBeenCalledWith({ force: true });
    expect(renamed.newPath).toBe("Studio/Renamed.systemsculpt");
    expect(session.getProjectPath()).toBe("Studio/Renamed.systemsculpt");
    expect(session.getProject().name).toBe("Renamed Project");
    expect(service.getProjectSession("Studio/Renamed.systemsculpt")).toBe(session);
    expect(service.getProjectSession("Studio/Test.systemsculpt")).toBeNull();
  });

  it("adopts a project file already renamed through the ordinary vault", async () => {
    const service = new StudioService(createPluginStub());
    const project = projectFixture();
    const session = createSession("Studio/Test.systemsculpt", project);
    const movedRawText = serializeStudioProject(project);
    session.markAcceptedProjectText(movedRawText);
    await retainExistingSession(service, session);
    const renamedProject = {
      ...project,
      name: "Moved",
      permissionsRef: {
        ...project.permissionsRef,
        policyPath: "Studio/Moved.systemsculpt-assets/policy/grants.json",
      },
    };
    const store = (service as any).projectStore;
    jest.spyOn(store, "readVisibleProjectRawText").mockResolvedValue(movedRawText);
    const adopt = jest.spyOn(store, "adoptVisibleProjectRename").mockResolvedValue({
      oldPath: "Studio/Test.systemsculpt",
      newPath: "Studio/Moved.systemsculpt",
      project: renamedProject,
    });
    jest.spyOn(store, "readProjectRawText").mockResolvedValue(
      serializeStudioProject(renamedProject)
    );

    const renamed = await service.adoptVisibleProjectRename(
      "Studio/Test.systemsculpt",
      "Studio/Moved.systemsculpt"
    );

    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({
      oldPath: "Studio/Test.systemsculpt",
      newPath: "Studio/Moved.systemsculpt",
      movedRawText,
      project: expect.objectContaining({
        name: "Moved",
        permissionsRef: expect.objectContaining({
          policyPath: "Studio/Moved.systemsculpt-assets/policy/grants.json",
        }),
      }),
    }));
    expect(renamed.replacedCanvasProject).toBeNull();
    expect(session.getProjectPath()).toBe("Studio/Moved.systemsculpt");
    expect(service.getProjectSession("Studio/Moved.systemsculpt")).toBe(session);
    expect(service.getProjectSession("Studio/Test.systemsculpt")).toBeNull();
  });

  it("preserves pending canvas work before a renamed file with changed content wins", async () => {
    const service = new StudioService(createPluginStub());
    const project = projectFixture();
    const session = createSession("Studio/Test.systemsculpt", project);
    const previousRawText = serializeStudioProject(project);
    session.markAcceptedProjectText(previousRawText);
    session.mutate("node.title", (current) => {
      current.name = "Pending canvas";
    });
    await retainExistingSession(service, session);
    const movedProject = projectFixture();
    movedProject.name = "File changed too";
    const movedRawText = serializeStudioProject(movedProject);
    const renamedProject = {
      ...movedProject,
      name: "Moved",
      permissionsRef: {
        ...movedProject.permissionsRef,
        policyPath: "Studio/Moved.systemsculpt-assets/policy/grants.json",
      },
    };
    const preserve = jest.spyOn(service, "preserveProjectRecovery").mockResolvedValue();
    const store = (service as any).projectStore;
    jest.spyOn(store, "readVisibleProjectRawText").mockResolvedValue(movedRawText);
    jest.spyOn(store, "adoptVisibleProjectRename").mockResolvedValue({
      oldPath: "Studio/Test.systemsculpt",
      newPath: "Studio/Moved.systemsculpt",
      project: renamedProject,
    });
    jest.spyOn(store, "readProjectRawText").mockResolvedValue(
      serializeStudioProject(renamedProject)
    );

    const renamed = await service.adoptVisibleProjectRename(
      "Studio/Test.systemsculpt",
      "Studio/Moved.systemsculpt"
    );

    expect(preserve).toHaveBeenCalledWith(expect.objectContaining({ name: "Pending canvas" }));
    expect(renamed.replacedCanvasProject).toEqual(
      expect.objectContaining({ name: "Pending canvas" })
    );
    expect(session.getProject().name).toBe("Moved");
  });

  it("rejects Studio-owned field changes in a renamed file before adopting it", async () => {
    const service = new StudioService(createPluginStub());
    const project = projectFixture();
    const session = createSession("Studio/Test.systemsculpt", project);
    session.markAcceptedProjectText(serializeStudioProject(project));
    await retainExistingSession(service, session);
    const movedProject = projectFixture();
    movedProject.name = "Moved";
    movedProject.engine.minPluginVersion = "99.0.0";
    movedProject.permissionsRef.policyPath =
      "Studio/Moved.systemsculpt-assets/policy/grants.json";
    const store = (service as any).projectStore;
    jest.spyOn(store, "readVisibleProjectRawText").mockResolvedValue(
      serializeStudioProject(movedProject)
    );
    const adopt = jest.spyOn(store, "adoptVisibleProjectRename");

    await expect(service.adoptVisibleProjectRename(
      "Studio/Test.systemsculpt",
      "Studio/Moved.systemsculpt"
    )).rejects.toThrow("engine is Studio-owned and must remain unchanged");

    expect(adopt).not.toHaveBeenCalled();
    expect(session.getProjectPath()).toBe("Studio/Test.systemsculpt");
    expect(service.getProjectSession("Studio/Moved.systemsculpt")).toBeNull();
  });
});
