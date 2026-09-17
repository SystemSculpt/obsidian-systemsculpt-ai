import { Platform } from "obsidian";
import { StudioGraphCompiler } from "../StudioGraphCompiler";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { StudioSandboxRunner } from "../StudioSandboxRunner";
import { StudioRuntime } from "../StudioRuntime";
import type { StudioNodeDefinition, StudioProjectV1, StudioRunEvent } from "../types";

function project(): StudioProjectV1 {
  return {
    schema: "studio.project.v1", projectId: "proj_single", name: "Single node runs",
    createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: {
      nodes: [
        { id: "seed", kind: "test.seed", version: "1.0.0", title: "Seed", position: { x: 0, y: 0 }, config: { value: "one" } },
        { id: "gen", kind: "test.generate", version: "1.0.0", title: "Image Generation", position: { x: 200, y: 0 }, config: {} },
        { id: "clip", kind: "test.clip", version: "1.0.0", title: "Video Generation", position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: "e1", fromNodeId: "seed", fromPortId: "text", toNodeId: "gen", toPortId: "prompt" },
        { id: "e2", fromNodeId: "gen", fromPortId: "image", toNodeId: "clip", toPortId: "frame" },
      ],
      entryNodeIds: ["seed"], groups: [],
    },
    permissionsRef: { policyVersion: 1, policyPath: "Studio/Single.systemsculpt-assets/policy/grants.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 128 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

function harness(cacheEntries: Record<string, unknown> = {}, supportFiles: Record<string, string> = {}) {
  const executed: string[] = [];
  const registry = new StudioNodeRegistry();
  const define = (kind: string, cachePolicy: "never" | "by_inputs", inputs: StudioNodeDefinition["inputPorts"], output: string, produce: (inputs: Record<string, unknown>, config: Record<string, unknown>) => unknown): StudioNodeDefinition => ({
    kind, version: "1.0.0", requiredHostCapabilities: [], capabilityClass: "local_cpu", cachePolicy,
    inputPorts: inputs, outputPorts: [{ id: output, type: "any" }], configDefaults: {}, configSchema: { fields: [] },
    async execute(context) {
      executed.push(context.node.id);
      return { outputs: { [output]: produce(context.inputs as Record<string, unknown>, context.node.config as Record<string, unknown>) } };
    },
  });
  registry.register(define("test.seed", "by_inputs", [], "text", (_inputs, config) => config.value));
  registry.register(define("test.generate", "never", [{ id: "prompt", type: "any", required: true }], "image", (inputs) => `image-for-${String(inputs.prompt)}`));
  registry.register(define("test.clip", "never", [{ id: "frame", type: "any" }], "video", (inputs) => `video-from-${String(inputs.frame)}`));

  const published: { cache?: Record<string, unknown> } = {};
  const projectStore = {
    loadProject: jest.fn(), supportRelativePath: jest.fn((_p: string, path: string) => path),
    readSupportFile: jest.fn(async (_p: string, path: string) => { const key = Object.keys(supportFiles).find((suffix) => path.endsWith(suffix)); return key ? new TextEncoder().encode(supportFiles[key]) : null; }),
    loadPolicy: jest.fn(async () => ({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-09-13T00:00:00.000Z", grants: [] })),
    publishRun: jest.fn(async (_p: string, command: { cacheDocument: Uint8Array }) => { published.cache = JSON.parse(new TextDecoder().decode(command.cacheDocument)); }),
  } as never;
  const plugin = { app: { vault: { adapter: {}, getAbstractFileByPath: jest.fn() } }, getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as never;
  const runtime = new StudioRuntime(
    (plugin as { app: unknown }).app as never, plugin, projectStore, registry, new StudioGraphCompiler(), {} as never,
    { beginLocalCommit: jest.fn(async () => undefined), completeLocalCommit: jest.fn(async () => undefined) } as never,
  );
  (runtime as unknown as { nodeResultCacheStore: unknown }).nodeResultCacheStore = {
    load: jest.fn(async () => ({ schema: "studio.node-cache.v1", projectId: "proj_single", updatedAt: "2026-09-13T00:00:00.000Z", entries: cacheEntries })),
    save: jest.fn(async () => undefined),
  };
  const events: StudioRunEvent[] = [];
  const run = (entryNodeIds?: string[]) => runtime.runProjectSnapshot("Studio/Single.systemsculpt", project(), { entryNodeIds, onEvent: async (event) => { events.push(event); } });
  return { run, executed, events, published, runtime, registry };
}

const entry = (nodeId: string, kind: string, outputs: Record<string, unknown>) => ({
  nodeId, nodeKind: kind, nodeVersion: "1.0.0", inputFingerprint: "sha256:stale", outputs, updatedAt: "2026-09-13T00:00:00.000Z", runId: "run-earlier",
});

describe("running one node", () => {
  beforeEach(() => { (Platform as { isDesktopApp: boolean }).isDesktopApp = false; });

  it("feeds the target from the upstream generation's recorded output instead of regenerating it", async () => {
    const { run, executed, events } = harness({ gen: entry("gen", "test.generate", { image: "image-from-last-time" }) });
    const summary = await run(["clip"]);
    expect(summary.status).toBe("success");
    expect(executed).toEqual(["clip"]);
    expect(summary.executedNodeIds).toEqual(["clip"]);
    expect(events.filter((event) => event.type === "node.started").map((event) => (event as { nodeId: string }).nodeId)).toEqual(["clip"]);
    const output = events.find((event) => event.type === "node.output") as { outputs: Record<string, unknown> };
    expect(output.outputs.video).toBe("video-from-image-from-last-time");
  });

  it("stops with the upstream node to run first when it has never produced an output", async () => {
    const { run, executed } = harness();
    await expect(run(["clip"])).rejects.toThrow('Run "Image Generation" first');
    expect(executed).toEqual([]);
  });

  it("recovers an upstream output from retained run history when the cache predates latest-output records", async () => {
    const runIndex = JSON.stringify([
      { runId: "run-old", status: "success", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, error: null, executedNodeIds: ["gen"], cachedNodeIds: [] },
      { runId: "run-new", status: "success", startedAt: "2026-09-02T00:00:00.000Z", finishedAt: null, error: null, executedNodeIds: ["gen"], cachedNodeIds: [] },
    ]);
    const events = (image: string) => [
      JSON.stringify({ type: "node.output", runId: "r", nodeId: "gen", outputs: { image }, at: "2026-09-01T00:00:00.000Z" }),
      JSON.stringify({ type: "node.output", runId: "r", nodeId: "seed", outputs: { text: "x" }, at: "2026-09-01T00:00:00.000Z" }),
    ].join("\n");
    const { run, executed, events: seen } = harness({}, {
      "runs/index.json": runIndex,
      "runs/run-old/events.ndjson": events("image-from-old-run"),
      "runs/run-new/events.ndjson": events("image-from-newest-run"),
    });
    const summary = await run(["clip"]);
    expect(summary.status).toBe("success");
    expect(executed).toEqual(["clip"]);
    const output = seen.find((event) => event.type === "node.output") as { outputs: Record<string, unknown> };
    expect(output.outputs.video).toBe("video-from-image-from-newest-run");
  });

  it("still recomputes cacheable upstream nodes and records outputs for every node in a full run", async () => {
    const { run, executed, published } = harness();
    const summary = await run();
    expect(summary.status).toBe("success");
    expect(executed).toEqual(["seed", "gen", "clip"]);
    const entries = (published.cache as { entries: Record<string, { outputs: Record<string, unknown> }> }).entries;
    expect(Object.keys(entries).sort()).toEqual(["clip", "gen", "seed"]);
    expect(entries.gen.outputs.image).toBe("image-for-one");
  });

  it("runs a cacheable node between the target and a never-cached boundary without crossing it", async () => {
    const { run, executed } = harness({ gen: entry("gen", "test.generate", { image: "kept" }) });
    // gen is the boundary; seed sits beyond it and must not run.
    const summary = await run(["clip"]);
    expect(summary.status).toBe("success");
    expect(executed).toEqual(["clip"]);
  });
  it("aborts active commands, rejects queued runs and prevents new execution after disposal", async () => {
    const { run, runtime, registry } = harness();
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let commandSignal: AbortSignal | undefined;
    const command = jest.spyOn(StudioSandboxRunner.prototype, "runCli").mockImplementation(async request => {
      commandSignal = request.signal;
      started();
      return await new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true });
      });
    });
    registry.register({ ...registry.get("test.seed", "1.0.0")!, async execute(context) {
      await context.services.runCli({ command: "test", cwd: "/test" });
      return { outputs: { text: "finished" } };
    } });
    const active = run();
    const activeResult = expect(active).rejects.toThrow("Command aborted");
    await startedPromise;
    const queued = run();
    const queuedResult = expect(queued).rejects.toThrow("disposed");
    runtime.dispose();
    expect(commandSignal?.aborted).toBe(true);
    await Promise.all([activeResult, queuedResult]);
    await expect(run()).rejects.toThrow("disposed");
    expect(command).toHaveBeenCalledTimes(1);
    command.mockRestore();
  });

  it("prepares connected context from recorded never-cache outputs without executing producers or the target", async () => {
    const { runtime, executed } = harness({ gen: entry("gen", "test.generate", { image: ["kept", "image"] }) });
    const inputs = await runtime.prepareNodeInputs("Studio/Single.systemsculpt", project(), "clip");
    expect(inputs).toEqual({ frame: ["kept", "image"] });
    expect(executed).toEqual([]);
  });

  it("prepares every same-port input with the same array-preserving fan-in as an ordinary run", async () => {
    const { runtime, executed } = harness();
    const snapshot = project();
    snapshot.graph.nodes.push({ ...snapshot.graph.nodes[0], id: "second", config: { value: ["two", "three"] } });
    snapshot.graph.edges.push({ id: "e3", fromNodeId: "second", fromPortId: "text", toNodeId: "gen", toPortId: "prompt" });
    const inputs = await runtime.prepareNodeInputs("Studio/Single.systemsculpt", snapshot, "gen");
    expect(inputs).toEqual({ prompt: ["one", ["two", "three"]] });
    expect(executed).toEqual(["seed", "second"]);
  });

  it("fails input preparation instead of rerunning a never-cache producer with no recorded output", async () => {
    const { runtime, executed } = harness();
    await expect(runtime.prepareNodeInputs("Studio/Single.systemsculpt", project(), "clip")).rejects.toThrow('Run "Image Generation" first');
    expect(executed).toEqual([]);
  });

  it("admits an immutable snapshot when preparing native inputs", async () => {
    const { runtime } = harness();
    const snapshot = project();
    const pending = runtime.prepareNodeInputs("Studio/Single.systemsculpt", snapshot, "gen");
    snapshot.graph.nodes[0].config.value = "edited after admission";
    expect(await pending).toEqual({ prompt: "one" });
  });

});
