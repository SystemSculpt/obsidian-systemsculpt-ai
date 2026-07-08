import { StudioProjectSession } from "../StudioProjectSession";
import type { StudioProjectV1 } from "../types";

function projectFixture(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_disposal",
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

function createClosableSession(saveProject: jest.Mock): StudioProjectSession {
  return new StudioProjectSession({
    projectPath: "Studio/Test.systemsculpt",
    project: projectFixture(),
    saveProject,
    readProjectRawText: jest.fn(async () => "{}"),
    discreteDelayMs: 0,
    continuousDelayMs: 0,
  });
}

describe("StudioProjectSession disposal", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("reports disposal so owners can drop zombie references", async () => {
    const session = createClosableSession(jest.fn(async () => {}));

    expect(session.isDisposed()).toBe(false);
    await session.close();
    expect(session.isDisposed()).toBe(true);
  });

  it("rejects mutations after the session is closed", async () => {
    const session = createClosableSession(jest.fn(async () => {}));
    await session.close();

    const changed = session.mutate("node.position", (project) => {
      project.name = "Zombie write";
      return true;
    });

    expect(changed).toBe(false);
    expect(session.getProject().name).toBe("Test Project");
  });

  it("rejects async mutations after the session is closed", async () => {
    const session = createClosableSession(jest.fn(async () => {}));
    await session.close();

    const changed = await session.mutateAsync("node.config", async (project) => {
      project.name = "Zombie async write";
      return true;
    });

    expect(changed).toBe(false);
    expect(session.getProject().name).toBe("Test Project");
  });

  it("never persists writes scheduled after close", async () => {
    const saveProject = jest.fn(async () => {});
    const session = createClosableSession(saveProject);
    await session.close();

    session.schedulePersist({ mode: "discrete", reason: "node.position" });
    await session.flushPendingSaveWork({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(saveProject).not.toHaveBeenCalled();
  });
});
