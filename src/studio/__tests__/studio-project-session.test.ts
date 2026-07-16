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

  it("blocks a queued canvas save without pretending the canvas was persisted", () => {
    const saveProject = jest.fn(async () => {});
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });

    session.schedulePersist({ mode: "discrete" });
    session.blockProjectFileWrites();
    jest.advanceTimersByTime(100);
    expect(saveProject).not.toHaveBeenCalled();
    expect(session.hasPendingLocalSaveWork()).toBe(true);
  });

  it("recognizes its own project write before the vault modify event fires", async () => {
    let session!: StudioProjectSession;
    const rawText = '{"schema":"studio.project.v1","name":"Saved"}';
    const decisions: unknown[] = [];
    const saveProject = jest.fn(async (
      _path: string,
      _project: StudioProjectV1,
      onBeforeProjectWrite?: (raw: string) => void
    ) => {
      onBeforeProjectWrite?.(rawText);
      decisions.push(session.resolveProjectFileTextUpdate(rawText).decision);
    });
    session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      readProjectRawText: jest.fn(async () => rawText),
      discreteDelayMs: 0,
    });

    session.schedulePersist({ mode: "discrete" });
    await session.flushPendingSaveWork({ force: true });

    expect(decisions).toEqual([{ kind: "ignore", reason: "self_write" }]);
    expect(session.hasPendingLocalSaveWork()).toBe(false);
  });

  it("does not overwrite an invalid project file while the canvas keeps changing", async () => {
    const saveProject = jest.fn(async () => {});
    const saveBlockedProjectRecovery = jest.fn(async () => {});
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      readProjectRawText: jest.fn(async () => "{"),
      saveBlockedProjectRecovery,
      discreteDelayMs: 0,
    });

    session.blockProjectFileWrites();
    session.mutate("node.title", (project) => {
      project.name = "Still editable in memory";
    });
    await session.flushPendingSaveWork({ force: true });
    await session.close();

    expect(saveProject).not.toHaveBeenCalled();
    expect(saveBlockedProjectRecovery).toHaveBeenCalledTimes(1);
    expect(session.hasPendingLocalSaveWork()).toBe(true);
  });

  it("reevaluates the last valid bytes after a malformed edit is fixed exactly", () => {
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject: jest.fn(async () => {}),
    });
    const validText = '{"schema":"studio.project.v1","name":"Valid"}';
    const malformedText = "{";
    session.markAcceptedProjectText(validText);
    const malformed = session.resolveProjectFileTextUpdate(malformedText);
    session.markRejectedProjectSignature(malformed.signature);

    expect(session.resolveProjectFileTextUpdate(validText).decision).toEqual({ kind: "evaluate" });
  });

  it("keeps the file-write block across ordinary Undo snapshot replacement", async () => {
    const saveProject = jest.fn(async () => {});
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      discreteDelayMs: 0,
    });
    session.blockProjectFileWrites();
    session.replaceProjectSnapshot(projectFixture(), { notifyListeners: false });
    session.schedulePersist({ mode: "discrete", reason: "history.apply" });
    await session.flushPendingSaveWork({ force: true });

    expect(saveProject).not.toHaveBeenCalled();
    expect(session.hasPendingLocalSaveWork()).toBe(true);
  });

  it("preserves blocked canvas work through the plugin-owned recovery callback on close", async () => {
    const saveBlockedProjectRecovery = jest.fn(async () => {});
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject: jest.fn(async () => {}),
      saveBlockedProjectRecovery,
      discreteDelayMs: 0,
    });
    session.blockProjectFileWrites();
    session.mutate("node.title", (project) => {
      project.name = "Unsaved canvas survives close";
    });

    await session.close();

    expect(saveBlockedProjectRecovery).toHaveBeenCalledWith(
      "Studio/Test.systemsculpt",
      expect.objectContaining({ name: "Unsaved canvas survives close" })
    );
  });

  it("keeps the session alive when blocked canvas recovery cannot be stored", async () => {
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject: jest.fn(async () => {}),
      saveBlockedProjectRecovery: jest.fn(async () => {
        throw new Error("storage unavailable");
      }),
      discreteDelayMs: 0,
    });
    session.blockProjectFileWrites();
    session.mutate("node.title", (project) => {
      project.name = "Only remaining canvas copy";
    });

    await expect(session.close()).rejects.toThrow("storage unavailable");

    expect(session.isDisposed()).toBe(false);
    expect(session.hasPendingLocalSaveWork()).toBe(true);
    expect(session.getProject().name).toBe("Only remaining canvas copy");
  });

  it("pauses automatic retries after a save failure instead of looping forever", async () => {
    const saveProject = jest.fn(async () => {
      throw new Error("storage unavailable");
    });
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      discreteDelayMs: 40,
    });

    session.mutate("node.title", (project) => {
      project.name = "Pending after failure";
    });
    jest.advanceTimersByTime(40);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(session.getDebugState()).toMatchObject({
      hasPendingLocalSaveWork: true,
      saveFailurePaused: true,
    });
  });

  it("retries a paused save once after a later explicit mutation", async () => {
    const saveProject = jest
      .fn<Promise<void>, [string, StudioProjectV1]>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const session = new StudioProjectSession({
      projectPath: "Studio/Test.systemsculpt",
      project: projectFixture(),
      saveProject,
      readProjectRawText: jest.fn(async () => "{}"),
      discreteDelayMs: 40,
    });

    session.mutate("node.title", (project) => {
      project.name = "First edit";
    });
    jest.advanceTimersByTime(40);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getDebugState().saveFailurePaused).toBe(true);

    session.mutate("node.title", (project) => {
      project.name = "Second edit retries";
    });
    jest.advanceTimersByTime(40);
    await session.flushPendingSaveWork({ force: true });

    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(session.getProject().name).toBe("Second edit retries");
    expect(session.hasPendingLocalSaveWork()).toBe(false);
    expect(session.getDebugState().saveFailurePaused).toBe(false);
  });
});
