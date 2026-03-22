import { StudioProjectSession } from "../StudioProjectSession";
import { StudioProjectSessionManager } from "../StudioProjectSessionManager";
import type { StudioProjectV1 } from "../types";

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

function createSession(projectPath = "Studio/Test.systemsculpt"): StudioProjectSession {
  return new StudioProjectSession({
    projectPath,
    project: projectFixture(),
    saveProject: jest.fn(async () => {}),
    readProjectRawText: jest.fn(async () => "{}"),
  });
}

describe("StudioProjectSessionManager", () => {
  it("reuses a retained session for the same path and tracks retain counts", async () => {
    const manager = new StudioProjectSessionManager();
    const session = createSession();
    const createSessionFn = jest.fn(async () => session);

    const first = await manager.retainSession("Studio/Test.systemsculpt", createSessionFn);
    const second = await manager.retainSession("Studio/Test.systemsculpt", createSessionFn);

    expect(first).toBe(session);
    expect(second).toBe(session);
    expect(createSessionFn).toHaveBeenCalledTimes(1);
    expect(manager.getRetainCount("Studio/Test.systemsculpt")).toBe(2);
  });

  it("closes a session when the final retainer releases it", async () => {
    const manager = new StudioProjectSessionManager();
    const session = createSession();
    const closeSpy = jest.spyOn(session, "close");

    await manager.retainSession("Studio/Test.systemsculpt", async () => session);
    await manager.retainSession("Studio/Test.systemsculpt", async () => session);

    await manager.releaseSession("Studio/Test.systemsculpt");
    expect(closeSpy).not.toHaveBeenCalled();
    expect(manager.getRetainCount("Studio/Test.systemsculpt")).toBe(1);

    await manager.releaseSession("Studio/Test.systemsculpt");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(manager.getSession("Studio/Test.systemsculpt")).toBeNull();
  });

  it("closes all retained sessions during manager disposal", async () => {
    const manager = new StudioProjectSessionManager();
    const first = createSession("Studio/One.systemsculpt");
    const second = createSession("Studio/Two.systemsculpt");
    const firstCloseSpy = jest.spyOn(first, "close");
    const secondCloseSpy = jest.spyOn(second, "close");

    await manager.retainSession("Studio/One.systemsculpt", async () => first);
    await manager.retainSession("Studio/Two.systemsculpt", async () => second);

    await manager.closeAll();

    expect(firstCloseSpy).toHaveBeenCalledTimes(1);
    expect(secondCloseSpy).toHaveBeenCalledTimes(1);
    expect(manager.listOpenSessions()).toHaveLength(0);
  });
});
