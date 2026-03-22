import { StudioRuntime } from "../StudioRuntime";
import type { StudioProjectV1 } from "../types";

function projectFixture(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_live_runtime",
    name: "Live Session Snapshot",
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

describe("StudioRuntime session snapshot runs", () => {
  it("runs directly from the provided project snapshot without reloading the project file", async () => {
    const adapter = {
      exists: jest.fn(async (path: string) => path.endsWith("index.json") ? false : true),
      mkdir: jest.fn(async () => {}),
      write: jest.fn(async () => {}),
      read: jest.fn(async () => "[]"),
      append: jest.fn(async () => {}),
      rmdir: jest.fn(async () => {}),
      remove: jest.fn(async () => {}),
    };
    const app = {
      vault: {
        adapter,
        configDir: ".obsidian",
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        readBinary: jest.fn(),
      },
    } as any;
    const plugin = {
      app,
      getLogger: () => ({
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    } as any;
    const projectStore = {
      loadProject: jest.fn(async () => {
        throw new Error("runProjectSnapshot should not reload the project from disk");
      }),
      loadPolicy: jest.fn(async () => ({
        schema: "studio.policy.v1",
        version: 1,
        updatedAt: "2026-03-22T00:00:00.000Z",
        grants: [],
      })),
    } as any;
    const compiler = {
      compile: jest.fn(() => ({
        executionOrder: [],
        nodesById: new Map(),
      })),
    } as any;
    const assetStore = {
      storeArrayBuffer: jest.fn(),
      readArrayBuffer: jest.fn(),
    } as any;
    const apiAdapter = {
      estimateRunCredits: jest.fn(async () => ({ ok: true })),
    } as any;
    const runtime = new StudioRuntime(
      app,
      plugin,
      projectStore,
      {} as any,
      compiler,
      assetStore,
      apiAdapter
    );
    (runtime as any).nodeResultCacheStore = {
      load: jest.fn(async () => ({
        projectId: "proj_live_runtime",
        updatedAt: "2026-03-22T00:00:00.000Z",
        entries: {},
      })),
      save: jest.fn(async () => {}),
    };
    const project = projectFixture();

    const summary = await runtime.runProjectSnapshot("Studio/Test.systemsculpt", project);

    expect(summary.status).toBe("success");
    expect(projectStore.loadProject).not.toHaveBeenCalled();
    expect(projectStore.loadPolicy).toHaveBeenCalledWith(project.permissionsRef.policyPath);
    const snapshotWrite = adapter.write.mock.calls.find(([path]: [string]) => path.endsWith("/snapshot.json"));
    expect(snapshotWrite).toBeDefined();
    const snapshotText = snapshotWrite?.[1] as string;
    expect(snapshotText).toContain("Live Session Snapshot");
    expect(compiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Live Session Snapshot" }),
      expect.anything()
    );
  });
});
