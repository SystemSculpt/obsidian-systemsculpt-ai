import { StudioProjectSession } from "../StudioProjectSession";
import { StudioService } from "../StudioService";
import type { StudioProjectV1 } from "../types";

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
      serverUrl: "https://api.systemsculpt.com",
    },
    getLogger: () => ({
      warn: jest.fn(),
      error: jest.fn(),
    }),
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

describe("StudioService session-backed mutation commands", () => {
  it("mutates the current project through the active session", () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    (service as any).currentProjectSession = session;
    (service as any).currentProjectPath = session.getProjectPath();

    const changed = service.mutateCurrentProject("node.title", (project) => {
      project.name = "Renamed from service";
      return true;
    });

    expect(changed).toBe(true);
    expect(session.getProject().name).toBe("Renamed from service");
    expect(service.getCurrentProjectSnapshot()?.name).toBe("Renamed from service");
  });

  it("returns defensive current project snapshots", () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    (service as any).currentProjectSession = session;
    (service as any).currentProjectPath = session.getProjectPath();

    const snapshot = service.getCurrentProjectSnapshot();
    expect(snapshot).not.toBeNull();
    snapshot!.name = "Mutated outside service";

    expect(session.getProject().name).toBe("Test Project");
  });

  it("mutates retained non-current sessions by project path", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession("Studio/Other.systemsculpt");
    await (service as any).projectSessionManager.retainSession("Studio/Other.systemsculpt", async () => session);

    const changed = service.mutateProject("Studio/Other.systemsculpt", "project.repair", (project) => {
      project.name = "Other Project";
      return true;
    });

    expect(changed).toBe(true);
    expect(service.getProjectSession("Studio/Other.systemsculpt")).toBe(session);
    expect(session.getProject().name).toBe("Other Project");
  });

  it("reuses the current session for same-path opens without reloading", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    const loadProjectForSession = jest.spyOn(service as any, "loadProjectForSession");
    (service as any).currentProjectSession = session;
    (service as any).currentProjectPath = session.getProjectPath();

    const reopened = await service.openProjectSession(session.getProjectPath());

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
    (service as any).currentProjectSession = session;
    (service as any).currentProjectPath = session.getProjectPath();

    const reopened = await service.openProjectSession(session.getProjectPath(), { forceReload: true });

    expect(reopened).toBe(session);
    expect(loadProjectForSession).toHaveBeenCalledWith(session.getProjectPath());
    expect(session.getProject().name).toBe("Reloaded Project");
  });

  it("runs the current project from the live session snapshot", async () => {
    const service = new StudioService(createPluginStub());
    const session = createSession();
    const flushSpy = jest.spyOn(session, "flushPendingSaveWork").mockResolvedValue();
    session.mutate("project.repair", (project) => {
      project.name = "Live Session Snapshot";
      return true;
    });
    (service as any).currentProjectSession = session;
    (service as any).currentProjectPath = session.getProjectPath();

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

    const result = await service.runCurrentProject();

    expect(result).toBe(summary);
    expect(flushSpy).toHaveBeenCalledWith({ force: true });
    expect(runtime.runProjectSnapshot).toHaveBeenCalledWith(
      session.getProjectPath(),
      expect.objectContaining({ name: "Live Session Snapshot" }),
      { onEvent: undefined }
    );
    expect(runtime.runProject).not.toHaveBeenCalled();
  });

  it("runs scoped node executions from the live session snapshot", async () => {
    const project = projectFixture();
    project.graph.nodes.push({
      id: "node_live",
      kind: "studio.text",
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
    (service as any).currentProjectSession = session;
    (service as any).currentProjectPath = session.getProjectPath();

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

    const result = await service.runCurrentProjectFromNode("node_live");

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
});
