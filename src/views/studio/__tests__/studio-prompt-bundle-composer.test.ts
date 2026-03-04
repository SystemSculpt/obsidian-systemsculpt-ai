import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import {
  composeTextGenerationPromptBundle,
  resolvePromptBundleNodeSource,
} from "../systemsculpt-studio-view/StudioPromptBundleComposer";

const createNode = (overrides: Partial<StudioNodeInstance>): StudioNodeInstance =>
  ({
    id: "node-1",
    kind: "studio.text",
    version: "1.0.0",
    title: "Node",
    position: { x: 0, y: 0 },
    config: {},
    ...overrides,
  }) as StudioNodeInstance;

const createProject = (nodes: StudioNodeInstance[], edges: StudioProjectV1["graph"]["edges"]): StudioProjectV1 =>
  ({
    schema: "studio.project.v1",
    projectId: "project-1",
    name: "Project",
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes,
      edges,
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "policy.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 10,
        maxArtifactsMb: 100,
      },
    },
    migrations: {
      projectSchemaVersion: "1",
      applied: [],
    },
  }) as StudioProjectV1;

describe("StudioPromptBundleComposer", () => {
  it("resolves note source from runtime preview first", async () => {
    const source = await resolvePromptBundleNodeSource({
      node: createNode({ kind: "studio.note" }),
      runtimePath: "Notes/live.md",
      runtimeText: " Live note output ",
      configuredNotePath: "Notes/configured.md",
      readConfiguredNoteText: async () => ({
        text: "configured fallback",
        path: "Notes/configured.md",
      }),
    });

    expect(source).toEqual({
      content: "Path: Notes/live.md\nLive note output",
      contentLanguage: "markdown",
      sourceLabel: "live note preview",
      vaultPath: "Notes/live.md",
    });
  });

  it("falls back to configured note read when runtime note preview is empty", async () => {
    const source = await resolvePromptBundleNodeSource({
      node: createNode({ kind: "studio.note" }),
      runtimePath: undefined,
      runtimeText: "",
      configuredNotePath: "Notes/configured.md",
      readConfiguredNoteText: async () => ({
        text: "configured note body",
        path: "Notes/configured.md",
      }),
    });

    expect(source).toEqual({
      content: "configured note body",
      contentLanguage: "markdown",
      sourceLabel: "vault note",
      vaultPath: "Notes/configured.md",
    });
  });

  it("resolves text source from runtime output, then config value, then config preview", async () => {
    const fromRuntime = await resolvePromptBundleNodeSource({
      node: createNode({ kind: "studio.text", config: {} }),
      runtimePath: undefined,
      runtimeText: " runtime output ",
      configuredNotePath: "",
      readConfiguredNoteText: async () => null,
    });
    expect(fromRuntime.sourceLabel).toBe("latest node output");
    expect(fromRuntime.content).toBe("runtime output");

    const fromConfigValue = await resolvePromptBundleNodeSource({
      node: createNode({ kind: "studio.text", config: { value: "configured value" } }),
      runtimePath: undefined,
      runtimeText: "",
      configuredNotePath: "",
      readConfiguredNoteText: async () => null,
    });
    expect(fromConfigValue.sourceLabel).toBe("node config value");
    expect(fromConfigValue.content).toBe("configured value");

    const fromConfigPreview = await resolvePromptBundleNodeSource({
      node: createNode({ kind: "studio.text", config: { prompt: "hello" } }),
      runtimePath: undefined,
      runtimeText: "",
      configuredNotePath: "",
      readConfiguredNoteText: async () => null,
    });
    expect(fromConfigPreview.sourceLabel).toBe("node config preview");
    expect(fromConfigPreview.content).toBe("prompt: hello");
  });

  it("composes markdown bundle and deduplicates repeated prompt sources", async () => {
    const target = createNode({
      id: "target",
      kind: "studio.text_generation",
      title: "Generator",
      config: { systemPrompt: "You are helpful." },
    });
    const source = createNode({
      id: "source",
      kind: "studio.note",
      title: "Brief",
    });
    const project = createProject([target, source], [
      {
        id: "edge-1",
        fromNodeId: "source",
        fromPortId: "text",
        toNodeId: "target",
        toPortId: "prompt",
      },
      {
        id: "edge-2",
        fromNodeId: "source",
        fromPortId: "text",
        toNodeId: "target",
        toPortId: "prompt",
      },
    ]);

    const result = await composeTextGenerationPromptBundle({
      project,
      targetNodeId: "target",
      generatedAt: new Date("2026-03-04T12:34:56.000Z"),
      resolveSource: async () => ({
        content: "Source body",
        contentLanguage: "markdown",
        sourceLabel: "live note preview",
        vaultPath: "Notes/brief.md",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.sourceCount).toBe(1);
    expect(result.markdown).toContain("# Studio Text Generation Handoff");
    expect(result.markdown).toContain("Generated: 2026-03-04T12:34:56.000Z");
    expect(result.markdown).toContain("### Source 1: Note - Brief");
    expect(result.markdown).toContain("## System Prompt");
    expect(result.markdown).toContain("You are helpful.");
  });

  it("returns a typed failure when target is not text generation", async () => {
    const project = createProject([createNode({ id: "source", kind: "studio.note" })], []);
    const result = await composeTextGenerationPromptBundle({
      project,
      targetNodeId: "source",
      generatedAt: new Date("2026-03-04T12:34:56.000Z"),
      resolveSource: async () => ({
        content: "unused",
        contentLanguage: "text",
        sourceLabel: "latest node output",
        vaultPath: "",
      }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "target_not_text_generation",
    });
  });
});
