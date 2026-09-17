import { Platform } from "obsidian";
import { StudioGraphCompiler } from "../StudioGraphCompiler";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { StudioRuntime } from "../StudioRuntime";
import type { StudioNodeDefinition, StudioNodeInputMap, StudioProjectV1 } from "../types";

it("preserves array-valued producer outputs across fan-in, sibling consumers and persistence", async () => {
  (Platform as { isDesktopApp: boolean }).isDesktopApp = false;
  const seen = new Map<string, StudioNodeInputMap>();
  const registry = new StudioNodeRegistry();
  const definition: StudioNodeDefinition = {
    kind: "test.data", version: "1.0.0", requiredHostCapabilities: [], capabilityClass: "local_cpu",
    inputPorts: [{ id: "value", type: "any" }], outputPorts: [{ id: "value", type: "any" }],
    configDefaults: {}, configSchema: { fields: [] },
    async execute(context) {
      seen.set(context.node.id, context.inputs);
      return { outputs: { value: context.node.config.value ?? context.inputs.value } };
    },
  };
  registry.register(definition);
  const project: StudioProjectV1 = {
    schema: "studio.project.v1", projectId: "inputs", name: "Inputs", createdAt: "2026-09-01", updatedAt: "2026-09-01",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: {
      nodes: ["array", "scalar", "joined", "sibling"].map((id) => ({
        id, kind: definition.kind, version: definition.version, title: id, position: { x: 0, y: 0 },
        config: id === "array" ? { value: ["original"] } : id === "scalar" ? { value: "other" } : {},
      })),
      edges: [["array", "joined"], ["scalar", "joined"], ["array", "sibling"]].map(([fromNodeId, toNodeId], index) => ({
        id: `edge-${index}`, fromNodeId, fromPortId: "value", toNodeId, toPortId: "value",
      })), entryNodeIds: ["array", "scalar"],
    },
    permissionsRef: { policyVersion: 1, policyPath: "Inputs.systemsculpt-assets/policy/grants.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 128 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
  const publishRun = jest.fn(async () => undefined);
  const projectStore = {
    readSupportFile: jest.fn(async () => null), publishRun,
    loadPolicy: jest.fn(async () => ({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-09-01", grants: [] })),
  };
  const runtime = new StudioRuntime({} as never, { getLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) } as never,
    projectStore as never, registry, new StudioGraphCompiler(), {} as never,
    { beginLocalCommit: jest.fn(async () => undefined), completeLocalCommit: jest.fn(async () => undefined) } as never);
  await runtime.runProjectSnapshot("Inputs.systemsculpt", project);
  expect(seen.get("sibling")).toEqual({ value: ["original"] });
  expect(seen.get("joined")).toEqual({ value: [["original"], "other"] });
  const command = (publishRun.mock.calls as unknown as [string, { cacheDocument: Uint8Array }][])[0][1];
  const cache = JSON.parse(new TextDecoder().decode(command.cacheDocument));
  expect(cache.entries.array.outputs).toEqual({ value: ["original"] });
});
