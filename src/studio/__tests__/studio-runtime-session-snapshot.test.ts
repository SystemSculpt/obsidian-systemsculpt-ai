import { Platform, TFile } from "obsidian";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { transcriptionNode } from "../nodes/transcriptionNode";
import { textNode } from "../nodes/textNode";
import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import { StudioGraphCompiler } from "../StudioGraphCompiler";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { StudioRuntime } from "../StudioRuntime";
import type { StudioNodeExecutionContext, StudioProjectV1, StudioTranscriptionRequest } from "../types";

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

  it("retries published transcription cleanup from retained run events", async () => {
    const runIndex = [{
      runId: "run-published",
      status: "success",
      startedAt: "2026-03-22T00:00:00.000Z",
      finishedAt: "2026-03-22T00:01:00.000Z",
      error: null,
      executedNodeIds: ["transcribe"],
      cachedNodeIds: [],
    }];
    const events = [
      JSON.stringify({
        type: "node.output",
        managedOperations: [
          { capability: "transcription", operationId: "studio-transcription-published" },
          { capability: "image_generation", operationId: "ignored-image" },
          { capability: "transcription", operationId: "bad/id" },
        ],
      }),
      "not-json",
    ].join("\n");
    const projectStore = {
      readSupportFile: jest.fn(async (_projectPath: string, path: string) => {
        if (path.endsWith("/runs/index.json")) {
          return new TextEncoder().encode(JSON.stringify(runIndex));
        }
        if (path.endsWith("/runs/run-published/events.ndjson")) {
          return new TextEncoder().encode(events);
        }
        return null;
      }),
    } as any;
    const completeLocalCommit = jest.fn(async () => undefined);
    const plugin = {
      getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    } as any;
    const runtime = new StudioRuntime(
      {} as any,
      plugin,
      projectStore,
      {} as any,
      {} as any,
      {} as any,
      { completeLocalCommit } as any,
    );

    await expect(runtime.getRecentRuns("Studio/Test.systemsculpt"))
      .resolves.toMatchObject([{ runId: "run-published" }]);

    expect(completeLocalCommit).toHaveBeenCalledWith([{
      capability: "transcription",
      operationId: "studio-transcription-published",
    }]);
  });

  it("reads each published run's events once and retries only cleanup that is still pending", async () => {
    let runIndex = [{ runId: "run-a", status: "success", startedAt: "2026-03-22T00:00:00.000Z", finishedAt: null, error: null, executedNodeIds: [], cachedNodeIds: [] }];
    const eventsFor = (operationId: string) => new TextEncoder().encode(JSON.stringify({
      type: "node.output",
      managedOperations: [{ capability: "transcription", operationId }],
    }));
    const projectStore = {
      readSupportFile: jest.fn(async (_projectPath: string, path: string) => {
        if (path.endsWith("/runs/index.json")) return new TextEncoder().encode(JSON.stringify(runIndex));
        if (path.endsWith("/runs/run-a/events.ndjson")) return eventsFor("op-a");
        if (path.endsWith("/runs/run-b/events.ndjson")) return eventsFor("op-b");
        return null;
      }),
    } as any;
    const completeLocalCommit = jest.fn(async (_refs: unknown[]) => undefined);
    completeLocalCommit.mockRejectedValueOnce(new Error("offline"));
    const runtime = new StudioRuntime(
      {} as any,
      { getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as any,
      projectStore,
      {} as any,
      {} as any,
      {} as any,
      { completeLocalCommit } as any,
    );
    const eventReads = () => projectStore.readSupportFile.mock.calls.filter(([, path]: [string, string]) => path.endsWith("events.ndjson")).length;

    await runtime.getRecentRuns("Studio/Test.systemsculpt");
    await runtime.getRecentRuns("Studio/Test.systemsculpt");
    await runtime.getRecentRuns("Studio/Test.systemsculpt");
    expect(eventReads()).toBe(1);
    // The first cleanup failed, the second succeeded, the third had nothing left to send.
    expect(completeLocalCommit.mock.calls).toEqual([
      [[{ capability: "transcription", operationId: "op-a" }]],
      [[{ capability: "transcription", operationId: "op-a" }]],
    ]);

    runIndex = [...runIndex, { ...runIndex[0], runId: "run-b", startedAt: "2026-03-22T00:05:00.000Z" }];
    await runtime.getRecentRuns("Studio/Test.systemsculpt");
    expect(eventReads()).toBe(2);
    expect(completeLocalCommit).toHaveBeenLastCalledWith([{ capability: "transcription", operationId: "op-b" }]);
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
      readSupportFile: jest.fn(async (_projectPath: string, path: string) => generationFiles.get(path.split(".systemsculpt-assets/").pop() || path) || null),
      loadPolicy: jest.fn(async () => ({
        schema: "studio.policy.v1",
        version: 1,
        updatedAt: "2026-03-22T00:00:00.000Z",
        grants: [],
      })),
    } as any;
    const compiler = new StudioGraphCompiler();
    jest.spyOn(compiler, "compileRun");
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

    const observed = jest.fn((update) => {
      if (update.event.type === "run.completed" && update.event.status === "success") {
        expect(generationFiles.has("runs/index.json")).toBe(true);
      }
    });
    runtime.runs.subscribe(observed);
    const summary = await runtime.runProjectSnapshot("Studio/Test.systemsculpt", project);

    expect(observed.mock.calls.map(([update]) => update.event.type)).toEqual(["run.started", "run.completed"]);
    expect(runtime.runs.getActiveRun("Studio/Test.systemsculpt")).toBeNull();
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
    expect(compiler.compileRun).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Live Session Snapshot" }),
      expect.anything(),
      { entryNodeIds: [], prepareInputsFor: undefined }
    );

    expect((await runtime.getLatestRunEvents("Studio/Test.systemsculpt")).map(event => event.type)).toEqual(["run.started", "run.completed"]);
    observed.mockClear();
    projectStore.publishRun.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(runtime.runProjectSnapshot("Studio/Test.systemsculpt", project)).rejects.toThrow("disk unavailable");
    expect(observed.mock.calls.map(([update]) => update.event.type)).toEqual(["run.started", "run.failed", "run.completed"]);
    expect(observed.mock.calls.at(-1)?.[0].event).toMatchObject({ status: "failed" });
    expect(runtime.runs.getActiveRun("Studio/Test.systemsculpt")).toBeNull();
  });

  it("lets a downstream node consume an asset staged by an upstream node before the run commit", async () => {
    platform.isDesktopApp = false;
    const app = { vault: { adapter: {}, getAbstractFileByPath: jest.fn(), read: jest.fn(), readBinary: jest.fn() } } as any;
    const plugin = { app, getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as any;
    const published: any[] = [];
    const projectStore = {
      supportRelativePath: (_projectPath: string, path: string) => path,
      readSupportFile: jest.fn(async () => null),
      loadPolicy: jest.fn(async () => ({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-03-22T00:00:00.000Z", grants: [{ id: "preview-read", capability: "filesystem", scope: { allowedPaths: ["Studio/Test.systemsculpt-assets"] }, grantedAt: "2026-03-22T00:00:00.000Z", grantedByUser: true }] })),
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
      definition: { requiredHostCapabilities: [], capabilityClass: "local_io", cachePolicy: "none", inputPorts: [], outputPorts: [{ id: "asset", type: "any" }], execute: async ({ services }: any) => ({ outputs: { asset: await services.storeAsset(bytes.buffer, "application/octet-stream") } }) },
      inboundEdges: [], dependencyNodeIds: [],
    };
    const consumer = {
      node: { id: "consumer", kind: "test.consumer", version: "1", title: "Consumer", position: { x: 1, y: 1 }, config: {} },
      definition: { requiredHostCapabilities: [], capabilityClass: "local_io", cachePolicy: "none", inputPorts: [{ id: "asset", type: "any", required: true }], outputPorts: [{ id: "size", type: "any" }], execute: async ({ services, inputs }: any) => {
        const consumed = new Uint8Array(await services.readAsset(inputs.asset));
        expect(consumed).toEqual(bytes);
        // Media previews use the vault path, before the run publishes its assets.
        const preview = new Uint8Array(await services.readVaultBinary(inputs.asset.path));
        expect(preview).toEqual(bytes);
        expect(await services.statVaultFileSize(inputs.asset.path)).toBe(bytes.byteLength);
        preview[0] = 0;
        expect(new Uint8Array(await services.readVaultBinary(inputs.asset.path))).toEqual(bytes);
        // Transcription can slice a staged asset before any vault file exists.
        const source = await services.openVaultFileSource(inputs.asset.path);
        expect(source.sizeBytes).toBe(bytes.byteLength);
        const slice = new Uint8Array(await source.readSlice(1, 3));
        expect(slice).toEqual(new Uint8Array([8, 9]));
        slice[0] = 0;
        expect(new Uint8Array(await source.readSlice(1, 3))).toEqual(new Uint8Array([8, 9]));
        await expect(source.readSlice(0, 4)).rejects.toThrow("Invalid file slice");
        source.release();
        await expect(source.readSlice(0, 1)).rejects.toThrow("released");
        await expect(services.openVaultFileSource("Private/audio.wav")).rejects.toThrow("Filesystem permission denied");
        await expect(services.openVaultFileSource("Studio/Test.systemsculpt-assets/../private.wav")).rejects.toThrow("parent traversal");
        await expect(services.openLocalFileSource("/tmp/audio.wav")).rejects.toThrow("Obsidian Desktop");
        return { outputs: { size: consumed.byteLength } };
      } },
      inboundEdges: [{ fromNodeId: "producer", fromPortId: "asset", toNodeId: "consumer", toPortId: "asset" }], dependencyNodeIds: ["producer"],
    };
    const registry = new StudioNodeRegistry();
    for (const fixture of [producer, consumer]) registry.register({
      ...fixture.definition, kind: fixture.node.kind, version: fixture.node.version,
      cachePolicy: "never", configDefaults: {}, configSchema: { fields: [] },
    } as any);
    const runtime = new StudioRuntime(app, plugin, projectStore, registry, new StudioGraphCompiler(), assetStore, {
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
    expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(app.vault.readBinary).not.toHaveBeenCalled();
    expect(projectStore.publishRun).toHaveBeenCalledTimes(1);
    expect(published[0].assets).toEqual([{ contentAddressedPath: `aa/${"a".repeat(64)}.bin`, bytes }]);
  });

  it.each([false, true])("opens permission-guarded transcription slices through the runtime (desktop=%s)", async (desktop) => {
    platform.isDesktopApp = desktop;
    const directory = await mkdtemp(join(tmpdir(), "studio-transcription-test-"));
    const absolutePath = join(directory, "audio.wav");
    const bytes = new Uint8Array([7, 8, 9]);
    await writeFile(absolutePath, bytes);
    const fileStat = await stat(absolutePath);
    const file = Object.assign(new TFile(), { path: "Approved/audio.wav", stat: { size: bytes.byteLength, mtime: fileStat.mtimeMs } });
    const fetchSlice = jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      expect(options?.headers).toEqual({ Range: "bytes=0-2" });
      return new Response(bytes, { status: 206, headers: { "Content-Range": "bytes 0-2/3" } });
    });
    const app = { vault: {
      adapter: desktop ? { getFullPath: jest.fn(() => absolutePath) } : {},
      getAbstractFileByPath: jest.fn((path: string) => path === file.path ? file : null),
      getResourcePath: jest.fn(() => "app://vault/audio.wav"),
      readBinary: jest.fn(),
    } } as any;
    const plugin = { app, getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as any;
    const projectStore = {
      readSupportFile: jest.fn(async () => null),
      loadPolicy: jest.fn(async () => ({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-03-22T00:00:00.000Z", grants: [{ id: "audio-read", capability: "filesystem", scope: { allowedPaths: ["Approved", directory] }, grantedAt: "2026-03-22T00:00:00.000Z", grantedByUser: true }] })),
      publishRun: jest.fn(async () => undefined),
    } as any;
    const transcribeAudio = jest.fn(async (request: StudioTranscriptionRequest) => {
      const content = await request.source.load();
      try {
        expect(content).toMatchObject({ filename: "audio.wav", contentType: "audio/wav", sizeBytes: 3 });
        expect(content).not.toHaveProperty("bytes");
        expect(await request.source.fingerprint()).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
        expect(new Uint8Array(await content.readSlice(0, 3))).toEqual(bytes);
        return { text: "transcript", operation: { capability: "transcription" as const, operationId: "transcription-test" } };
      } finally {
        request.source.release?.();
        await Promise.resolve();
        await expect(content.readSlice(0, 1)).rejects.toThrow();
      }
    });
    const registry = new StudioNodeRegistry();
    registry.register(textNode);
    registry.register({
      ...transcriptionNode,
      execute: async (context: StudioNodeExecutionContext) => {
        const { services } = context;
        await expect(services.openVaultFileSource("Private/audio.wav")).rejects.toThrow("Filesystem permission denied");
        await expect(services.openVaultFileSource("Approved/../private.wav")).rejects.toThrow("parent traversal");
        expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
        await expect(services.openVaultFileSource("Approved/missing.wav")).rejects.toThrow("Vault file not found");
        if (desktop) {
          await expect(services.openLocalFileSource("")).rejects.toThrow("path is empty");
          await expect(services.openLocalFileSource("audio.wav")).rejects.toThrow("requires an absolute path");
          await expect(services.openLocalFileSource("/private/audio.wav")).rejects.toThrow("Filesystem permission denied");
          await expect(services.openLocalFileSource(`${directory}/../private.wav`)).rejects.toThrow("parent traversal");
          const local = await services.openLocalFileSource(absolutePath);
          try {
            expect(local.sizeBytes).toBe(3);
            expect(new Uint8Array(await local.readSlice(1, 3))).toEqual(new Uint8Array([8, 9]));
          } finally { local.release(); }
          await expect(local.readSlice(0, 1)).rejects.toThrow("released");
        } else {
          await expect(services.openLocalFileSource(absolutePath)).rejects.toThrow("Obsidian Desktop");
        }
        const result = await transcriptionNode.execute(context);
        if (desktop) {
          const changed = await services.openLocalFileSource(absolutePath);
          await writeFile(absolutePath, new Uint8Array([1, 2, 3, 4]));
          try { await expect(changed.readSlice(0, 1)).rejects.toThrow("changed while it was being read"); }
          finally { changed.release(); }
        }
        return result;
      },
    });
    const runtime = new StudioRuntime(app, plugin, projectStore, registry, new StudioGraphCompiler(), {} as any, {
      transcribeAudio,
      beginLocalCommit: async () => undefined,
      completeLocalCommit: async () => undefined,
    } as any);
    const project = projectFixture();
    project.graph.nodes = [
      { id: "path", kind: textNode.kind, version: textNode.version, title: "Audio path", position: { x: 0, y: 0 }, config: { value: file.path } },
      { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 320, y: 0 }, config: {} },
    ];
    project.graph.edges = [{ id: "path-edge", fromNodeId: "path", fromPortId: "text", toNodeId: "transcription", toPortId: "path" }];
    project.graph.entryNodeIds = ["path"];
    try {
      const summary = await runtime.runProjectSnapshot("Studio/Test.systemsculpt", project);
      expect(summary).toMatchObject({ status: "success", error: null });
      expect(transcribeAudio).toHaveBeenCalledTimes(1);
      expect(app.vault.readBinary).not.toHaveBeenCalled();
      expect(fetchSlice).toHaveBeenCalledTimes(desktop ? 0 : 2);
      expect(projectStore.publishRun).toHaveBeenCalledWith("Studio/Test.systemsculpt", expect.objectContaining({
        eventsDocument: expect.any(Uint8Array),
      }));
      const events = new TextDecoder().decode(projectStore.publishRun.mock.calls[0][1].eventsDocument);
      expect(events).toContain('"outputs":{"text":"transcript"}');
      expect(events).toContain('"managedOperations":[{"capability":"transcription","operationId":"transcription-test"}]');
    } finally {
      runtime.dispose();
      fetchSlice.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates authored and edited minimal text through the real runtime into an video prompt", async () => {
    platform.isDesktopApp = false;
    const app = {
      vault: {
        adapter: {},
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        readBinary: jest.fn(),
      },
    } as any;
    const plugin = {
      app,
      getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    } as any;
    const projectStore = {
      readSupportFile: jest.fn(async () => null),
      loadPolicy: jest.fn(async () => ({
        schema: "studio.policy.v1",
        version: 1,
        updatedAt: "2026-03-22T00:00:00.000Z",
        grants: [],
      })),
      publishRun: jest.fn(async () => undefined),
    } as any;
    const registry = new StudioNodeRegistry();
    registerBuiltInStudioNodes(registry);
    const receivedPrompts: string[] = [];
    const apiAdapter = {
      generateVideo: jest.fn(async (request: { buildPayload: () => Promise<{ prompt: string }> }) => {
        const payload = await request.buildPayload();
        receivedPrompts.push(payload.prompt);
        return {
          videos: [],
          operation: {
            capability: "video_generation",
            operationId: `video-${receivedPrompts.length}`,
          },
        };
      }),
      beginLocalCommit: jest.fn(async () => undefined),
      completeLocalCommit: jest.fn(async () => undefined),
    } as any;
    const runtime = new StudioRuntime(
      app,
      plugin,
      projectStore,
      registry,
      new StudioGraphCompiler(),
      {
        stageArrayBuffer: jest.fn(),
        readArrayBuffer: jest.fn(),
      } as any,
      apiAdapter
    );
    (runtime as any).nodeResultCacheStore = {
      load: jest.fn(async () => ({
        projectId: "proj_live_runtime",
        updatedAt: "2026-03-22T00:00:00.000Z",
        entries: {},
      })),
    };
    const project = projectFixture();
    project.graph.nodes = [
      {
        id: "prompt",
        kind: "studio.text",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 0, y: 0 },
        config: {
          value: "Portrait of a fox in amber light",
          fontSize: 14,
        },
      },
      {
        id: "video",
        kind: "studio.video_generation",
        version: "1.0.0",
        title: "Video Generation",
        position: { x: 320, y: 0 },
        config: {
          model: "video-model",
          aspectRatio: "1:1",
        },
      },
    ];
    project.graph.edges = [{
      id: "prompt-edge",
      fromNodeId: "prompt",
      fromPortId: "text",
      toNodeId: "video",
      toPortId: "prompt",
    }];
    project.graph.entryNodeIds = ["prompt"];

    await expect(
      runtime.runProjectSnapshot("Studio/Test.systemsculpt", project, {
        entryNodeIds: ["video"],
      })
    ).resolves.toMatchObject({ status: "success" });

    project.graph.nodes[0].config.value = "Edited prompt reaches the video node";
    await expect(
      runtime.runProjectSnapshot("Studio/Test.systemsculpt", project, {
        entryNodeIds: ["video"],
      })
    ).resolves.toMatchObject({ status: "success" });

    expect(receivedPrompts).toEqual([
      "Portrait of a fox in amber light",
      "Edited prompt reaches the video node",
    ]);
    expect(apiAdapter.generateVideo).toHaveBeenCalledTimes(2);
    expect(projectStore.publishRun).toHaveBeenCalledTimes(2);
  });
});
