import { Platform } from "obsidian";
import { StudioGraphCompiler } from "../StudioGraphCompiler";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { StudioRuntime } from "../StudioRuntime";
import type { StudioNodeDefinition, StudioProjectV1, StudioRunEvent } from "../types";

/**
 * seed -> gen -> clip, where `clip.frame` is a required port. Disabling `gen`
 * used to leave `frame` simply absent from clip's input map, so clip ran on
 * partial data instead of being skipped with its producer.
 */
function project(overrides: { disabledNodeId?: string } = {}): StudioProjectV1 {
  const disable = (id: string) => (overrides.disabledNodeId === id ? { disabled: true } : {});
  return {
    schema: "studio.project.v1", projectId: "proj_skip", name: "Skip propagation",
    createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: {
      nodes: [
        { id: "seed", kind: "test.seed", version: "1.0.0", title: "Seed", position: { x: 0, y: 0 }, config: { value: "one" }, ...disable("seed") },
        { id: "gen", kind: "test.generate", version: "1.0.0", title: "Image Generation", position: { x: 200, y: 0 }, config: {}, ...disable("gen") },
        { id: "clip", kind: "test.clip", version: "1.0.0", title: "Video Generation", position: { x: 400, y: 0 }, config: {}, ...disable("clip") },
        { id: "note", kind: "test.note", version: "1.0.0", title: "Note", position: { x: 400, y: 200 }, config: {}, ...disable("note") },
      ],
      edges: [
        { id: "e1", fromNodeId: "seed", fromPortId: "text", toNodeId: "gen", toPortId: "prompt" },
        { id: "e2", fromNodeId: "gen", fromPortId: "image", toNodeId: "clip", toPortId: "frame" },
        { id: "e3", fromNodeId: "gen", fromPortId: "image", toNodeId: "note", toPortId: "illustration" },
      ],
      entryNodeIds: ["seed"], groups: [],
    },
    permissionsRef: { policyVersion: 1, policyPath: "Studio/Skip.systemsculpt-assets/policy/grants.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 128 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

function harness(overrides: { disabledNodeId?: string } = {}) {
  const executed: string[] = [];
  const seenInputs = new Map<string, Record<string, unknown>>();
  const registry = new StudioNodeRegistry();
  const define = (
    kind: string,
    inputs: StudioNodeDefinition["inputPorts"],
    output: string,
    produce: (inputs: Record<string, unknown>, config: Record<string, unknown>) => unknown,
  ): StudioNodeDefinition => ({
    kind, version: "1.0.0", requiredHostCapabilities: [], capabilityClass: "local_cpu", cachePolicy: "never",
    inputPorts: inputs, outputPorts: [{ id: output, type: "any" }], configDefaults: {}, configSchema: { fields: [] },
    async execute(context) {
      executed.push(context.node.id);
      seenInputs.set(context.node.id, context.inputs as Record<string, unknown>);
      return { outputs: { [output]: produce(context.inputs as Record<string, unknown>, context.node.config as Record<string, unknown>) } };
    },
  });
  registry.register(define("test.seed", [], "text", (_inputs, config) => config.value));
  registry.register(define("test.generate", [{ id: "prompt", type: "any", required: true }], "image", (inputs) => `image-for-${String(inputs.prompt)}`));
  registry.register(define("test.clip", [{ id: "frame", type: "any", required: true }], "video", (inputs) => `video-from-${String(inputs.frame)}`));
  // `illustration` is optional: losing its producer must not skip the node.
  registry.register(define("test.note", [{ id: "illustration", type: "any" }], "markdown", (inputs) => `note-${String(inputs.illustration ?? "none")}`));

  const projectStore = {
    loadProject: jest.fn(), supportRelativePath: jest.fn((_p: string, path: string) => path),
    readSupportFile: jest.fn(async () => null),
    loadPolicy: jest.fn(async () => ({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-09-13T00:00:00.000Z", grants: [] })),
    publishRun: jest.fn(async () => undefined),
  } as never;
  const plugin = { app: { vault: { adapter: {}, getAbstractFileByPath: jest.fn() } }, getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as never;
  const runtime = new StudioRuntime(
    (plugin as { app: unknown }).app as never, plugin, projectStore, registry, new StudioGraphCompiler(), {} as never,
    { beginLocalCommit: jest.fn(async () => undefined), completeLocalCommit: jest.fn(async () => undefined) } as never,
  );
  (runtime as unknown as { nodeResultCacheStore: unknown }).nodeResultCacheStore = {
    load: jest.fn(async () => ({ schema: "studio.node-cache.v1", projectId: "proj_skip", updatedAt: "2026-09-13T00:00:00.000Z", entries: {} })),
    save: jest.fn(async () => undefined),
  };
  const events: StudioRunEvent[] = [];
  const run = () => runtime.runProjectSnapshot("Studio/Skip.systemsculpt", project(overrides), {
    onEvent: async (event) => { events.push(event); },
  });
  return { run, executed, seenInputs, events };
}

describe("disabled nodes propagate their skip downstream", () => {
  beforeEach(() => { (Platform as { isDesktopApp: boolean }).isDesktopApp = false; });

  it("skips a node whose required input lost its only producer", async () => {
    const { run, executed } = harness({ disabledNodeId: "gen" });

    const summary = await run();

    expect(summary.status).toBe("success");
    expect(executed).toContain("seed");
    expect(executed).not.toContain("gen");
    // The point of the fix: clip is skipped rather than executed with `frame`
    // missing from its inputs.
    expect(executed).not.toContain("clip");
    expect(summary.executedNodeIds).not.toContain("clip");
  });

  it("still runs a node whose lost input was optional", async () => {
    const { run, executed, seenInputs } = harness({ disabledNodeId: "gen" });

    await run();

    expect(executed).toContain("note");
    expect(seenInputs.get("note")).toEqual({});
  });

  it("runs the whole chain when nothing is disabled", async () => {
    const { run, executed, seenInputs } = harness();

    const summary = await run();

    expect(summary.status).toBe("success");
    expect(executed).toEqual(expect.arrayContaining(["seed", "gen", "clip", "note"]));
    expect(seenInputs.get("clip")).toEqual({ frame: "image-for-one" });
  });

  it("propagates the skip transitively through required ports", async () => {
    const { run, executed } = harness({ disabledNodeId: "seed" });

    const summary = await run();

    expect(summary.status).toBe("success");
    // seed is disabled, gen loses its required prompt, clip then loses its
    // required frame. Only the node with an optional input survives.
    expect(executed).toEqual(["note"]);
  });
});
