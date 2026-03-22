import { StudioProjectSession } from "../StudioProjectSession";
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

describe("StudioProjectSession", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns defensive project snapshots so callers cannot mutate session state accidentally", () => {
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject: jest.fn(async () => {}),
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });

    const snapshot = session.getProjectSnapshot();
    snapshot.name = "Mutated outside session";

    expect(session.getProject().name).toBe("Test Project");
    expect(session.getReadonlyProjectSnapshot().name).toBe("Test Project");
  });

  it("mutates through the session contract and schedules persistence once", () => {
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject: jest.fn(async () => {}),
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });
    const listener = jest.fn();
    session.subscribe(listener);

    const changed = session.mutate("node.title", (project) => {
      project.name = "Renamed";
      return true;
    });

    expect(changed).toBe(true);
    expect(session.getProject().name).toBe("Renamed");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getDebugState()).toMatchObject({
      dirtyRevision: 1,
      persistedRevision: 0,
      hasPendingLocalSaveWork: true,
      projectPath: "Studio/Test.systemsculpt",
    });
  });

  it("coalesces near-real-time discrete saves without pushing the timer out forever", async () => {
    const saveProject = jest.fn(async () => {});
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });

    session.schedulePersist({ mode: "discrete" });
    jest.advanceTimersByTime(20);
    session.schedulePersist({ mode: "discrete" });
    jest.advanceTimersByTime(19);
    await Promise.resolve();

    expect(saveProject).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it("queues a follow-up save when edits arrive during an in-flight save", async () => {
    let resolveFirstSave: (() => void) | null = null;
    const saveProject = jest
      .fn<Promise<void>, [string, StudioProjectV1]>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);

    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });

    session.schedulePersist({ mode: "discrete" });
    jest.advanceTimersByTime(40);
    await Promise.resolve();
    expect(saveProject).toHaveBeenCalledTimes(1);

    session.schedulePersist({ mode: "discrete" });
    resolveFirstSave?.();
    await Promise.resolve();
    jest.advanceTimersByTime(40);
    await session.flushPendingSaveWork({ force: true });

    expect(saveProject).toHaveBeenCalledTimes(2);
  });

  it("defers external file updates while local save work is still pending", () => {
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject: jest.fn(async () => {}),
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });

    session.schedulePersist({ mode: "discrete" });
    const result = session.resolveExternalProjectTextUpdate('{"schema":"studio.project.v1"}');

    expect(result.decision).toEqual({ kind: "defer", reason: "local_save_pending" });
    expect(session.hasDeferredExternalSync()).toBe(true);
  });
});
