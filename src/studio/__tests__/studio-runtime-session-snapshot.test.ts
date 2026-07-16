import { Platform } from "obsidian";
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
  const platform = Platform as typeof Platform & { isDesktopApp: boolean };

  beforeEach(() => {
    platform.isDesktopApp = true;
  });

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
    const logger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const plugin = {
      app,
      getLogger: () => logger,
    } as any;
    const generationFiles = new Map<string, Uint8Array>();
    const projectStore = {
      loadProject: jest.fn(async () => {
        throw new Error("runProjectSnapshot should not reload the project from disk");
      }),
      supportRelativePath: jest.fn((_projectPath: string, path: string) => path),
      publishRun: jest.fn(async (_projectPath: string, command: { runId: string; snapshotDocument: Uint8Array; eventsDocument: Uint8Array; runIndexDocument: Uint8Array; cacheDocument: Uint8Array }) => {
        generationFiles.set(`runs/${command.runId}/snapshot.json`, command.snapshotDocument);
        generationFiles.set(`runs/${command.runId}/events.ndjson`, command.eventsDocument);
        generationFiles.set("runs/index.json", command.runIndexDocument);
        generationFiles.set("cache/node-results.json", command.cacheDocument);
      }),
      readSupportFile: jest.fn(async (_projectPath: string, path: string) => generationFiles.get(path) || null),
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
      beginLocalCommit: jest.fn(async () => undefined),
      completeLocalCommit: jest.fn(async () => { throw new Error("cleanup unavailable"); }),
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
    expect(projectStore.publishRun).toHaveBeenCalledTimes(1);
    expect(apiAdapter.beginLocalCommit.mock.invocationCallOrder[0]).toBeLessThan(
      projectStore.publishRun.mock.invocationCallOrder[0]
    );
    expect(apiAdapter.completeLocalCommit).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Studio managed-operation cleanup remains pending after run publication",
      expect.objectContaining({ metadata: expect.objectContaining({ error: "cleanup unavailable" }) }),
    );
    const publication = projectStore.publishRun.mock.calls[0][1];
    expect(new TextDecoder().decode(publication.snapshotDocument)).toContain("Live Session Snapshot");
    expect(new TextDecoder().decode(publication.eventsDocument)).toContain("run.completed");
    expect(new TextDecoder().decode(publication.runIndexDocument)).toContain("success");
    expect(new TextDecoder().decode(publication.cacheDocument)).toContain("proj_live_runtime");
    expect(projectStore.loadPolicy).toHaveBeenCalledWith(project.permissionsRef.policyPath);
    const snapshotBytes = [...generationFiles].find(([path]) => path.endsWith("/snapshot.json"))?.[1];
    expect(snapshotBytes).toBeDefined();
    expect(new TextDecoder().decode(snapshotBytes)).toContain("Live Session Snapshot");
    expect(compiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Live Session Snapshot" }),
      expect.anything()
    );
  });

  it("lets a downstream node consume an asset staged by an upstream node before the run commit", async () => {
    platform.isDesktopApp = false;
    const app = { vault: { adapter: {}, getAbstractFileByPath: jest.fn(), read: jest.fn(), readBinary: jest.fn() } } as any;
    const plugin = { app, getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as any;
    const published: any[] = [];
    const projectStore = {
      supportRelativePath: (_projectPath: string, path: string) => path,
      readSupportFile: jest.fn(async () => null),
      loadPolicy: jest.fn(async () => ({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-03-22T00:00:00.000Z", grants: [] })),
      publishRun: jest.fn(async (_path: string, command: unknown) => { published.push(command); }),
    } as any;
    const bytes = new Uint8Array([7, 8, 9]);
    const asset = { hash: "a".repeat(64), mimeType: "application/octet-stream", sizeBytes: 3, path: "Studio/Test.systemsculpt-assets/assets/sha256/aa/blob.bin" };
    const assetStore = {
      stageArrayBuffer: jest.fn(async () => ({ asset, generationFile: { contentAddressedPath: `aa/${"a".repeat(64)}.bin`, bytes } })),
      readArrayBuffer: jest.fn(async () => { throw new Error("committed fallback must not be used for a staged asset"); }),
    } as any;
    const producer = {
      node: { id: "producer", kind: "test.producer", version: "1", title: "Producer", position: { x: 0, y: 0 }, config: {} },
      definition: { requiredHostCapabilities: [], capabilityClass: "local_io", cachePolicy: "none", execute: async ({ services }: any) => ({ outputs: { asset: await services.storeAsset(bytes.buffer, "application/octet-stream") } }) },
      inboundEdges: [], dependencyNodeIds: [],
    };
    const consumer = {
      node: { id: "consumer", kind: "test.consumer", version: "1", title: "Consumer", position: { x: 1, y: 1 }, config: {} },
      definition: { requiredHostCapabilities: [], capabilityClass: "local_io", cachePolicy: "none", execute: async ({ services, inputs }: any) => {
        const consumed = new Uint8Array(await services.readAsset(inputs.asset));
        expect(consumed).toEqual(bytes);
        return { outputs: { size: consumed.byteLength } };
      } },
      inboundEdges: [{ fromNodeId: "producer", fromPortId: "asset", toNodeId: "consumer", toPortId: "asset" }], dependencyNodeIds: ["producer"],
    };
    const compiler = { compile: () => ({ executionOrder: ["producer", "consumer"], nodesById: new Map([["producer", producer], ["consumer", consumer]]) }) } as any;
    const runtime = new StudioRuntime(app, plugin, projectStore, {} as any, compiler, assetStore, {
      beginLocalCommit: async () => undefined,
      completeLocalCommit: async () => undefined,
    } as any);
    (runtime as any).nodeResultCacheStore = { load: async () => ({ projectId: "proj_live_runtime", updatedAt: "2026-03-22T00:00:00.000Z", entries: {} }) };
    const project = projectFixture();
    project.graph.nodes = [producer.node as any, consumer.node as any];
    project.graph.edges = [{ id: "edge", fromNodeId: "producer", fromPortId: "asset", toNodeId: "consumer", toPortId: "asset" }];
    project.graph.entryNodeIds = ["producer"];

    const summary = await runtime.runProjectSnapshot("Studio/Test.systemsculpt", project);
    expect(summary.status).toBe("success");
    expect(assetStore.readArrayBuffer).not.toHaveBeenCalled();
    expect(projectStore.publishRun).toHaveBeenCalledTimes(1);
    expect(published[0].assets).toEqual([{ contentAddressedPath: `aa/${"a".repeat(64)}.bin`, bytes }]);
  });
});
