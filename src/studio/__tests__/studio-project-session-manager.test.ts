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

  it("retains the only session copy when close recovery fails", async () => {
    const manager = new StudioProjectSessionManager();
    const session = createSession();
    jest.spyOn(session, "close").mockRejectedValueOnce(new Error("recovery failed"));

    await manager.retainSession("Studio/Test.systemsculpt", async () => session);

    await expect(manager.releaseSession("Studio/Test.systemsculpt")).rejects.toThrow("recovery failed");
    expect(manager.getSession("Studio/Test.systemsculpt")).toBe(session);
    expect(manager.getRetainCount("Studio/Test.systemsculpt")).toBe(0);
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

  it("attempts every session close even when one recovery write fails", async () => {
    const manager = new StudioProjectSessionManager();
    const first = createSession("Studio/One.systemsculpt");
    const second = createSession("Studio/Two.systemsculpt");
    jest.spyOn(first, "close").mockRejectedValueOnce(new Error("first recovery failed"));
    const secondCloseSpy = jest.spyOn(second, "close");

    await manager.retainSession("Studio/One.systemsculpt", async () => first);
    await manager.retainSession("Studio/Two.systemsculpt", async () => second);

    await expect(manager.closeAll()).rejects.toThrow("first recovery failed");

    expect(secondCloseSpy).toHaveBeenCalledTimes(1);
    expect(manager.getSession("Studio/One.systemsculpt")).toBe(first);
    expect(manager.getSession("Studio/Two.systemsculpt")).toBeNull();
  });

  it("moves retained sessions to a renamed project path", async () => {
    const manager = new StudioProjectSessionManager();
    const session = createSession("Studio/Original.systemsculpt");

    await manager.retainSession("Studio/Original.systemsculpt", async () => session);

    expect(manager.moveSession("Studio/Original.systemsculpt", "Studio/Renamed.systemsculpt")).toBe(true);
    expect(manager.getSession("Studio/Original.systemsculpt")).toBeNull();
    expect(manager.getSession("Studio/Renamed.systemsculpt")).toBe(session);
    expect(manager.getRetainCount("Studio/Renamed.systemsculpt")).toBe(1);
  });
});
