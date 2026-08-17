import {
  createDefaultStudioPolicy,
  createEmptyStudioProject,
  parseStudioPolicy,
  parseStudioProject,
  serializeStudioProject,
} from "../schema";
import { STUDIO_PROJECT_SCHEMA_V1 } from "../types";
import {
  STUDIO_AGENT_DOCS_PATH,
  renderStudioAgentReferenceMarkdown,
} from "../StudioProjectAgentContract";

describe("Studio schema", () => {
  it("round-trips an empty project through the v2 dialect", () => {
    const project = createEmptyStudioProject({
      name: "Architecture",
      policyPath: "SystemSculpt/Studio/Architecture.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });

    const serialized = serializeStudioProject(project);
    const parsed = parseStudioProject(serialized);
    expect(parsed.schema).toBe(STUDIO_PROJECT_SCHEMA_V1);
    expect(parsed.name).toBe("Architecture");
    expect(parsed.permissionsRef.policyPath).toContain("policy/grants.json");
    expect(parsed.graph.groups || []).toEqual([]);
  });

  it("serializes a compact v2 document that points at the generated agent reference", () => {
    const project = createEmptyStudioProject({
      name: "Agent-readable",
      policyPath: "SystemSculpt/Studio/Agent-readable.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.0.2",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "prompt",
      kind: "studio.text",
      version: "1.0.0",
      title: "Prompt",
      position: { x: 20, y: 20 },
      size: { width: 280 },
      config: { value: "hello" },
      continueOnError: false,
      disabled: false,
    });

    const serialized = serializeStudioProject(project);
    const document = JSON.parse(serialized);
    expect(document).toEqual({
      schema: "studio.project.v2",
      id: project.projectId,
      name: "Agent-readable",
      docs: STUDIO_AGENT_DOCS_PATH,
      canvas: {
        nodes: [
          { id: "prompt", kind: "text", title: "Prompt", x: 20, y: 20, width: 280, config: { value: "hello" } },
        ],
        edges: [],
        groups: [],
        shapes: [],
        arrows: [],
      },
    });
    expect(serialized.length).toBeLessThan(1_000);
    expect(serializeStudioProject(parseStudioProject(serialized))).toBe(serialized);
  });

  it("renders the node-kind reference into the shared agent document instead of every project file", () => {
    const reference = renderStudioAgentReferenceMarkdown();
    expect(reference).toContain("### text");
    expect(reference).toContain("- out: `text` (text)");
    expect(reference).toContain("- `value` (textarea");
    expect(reference).toContain("- `fontSize` (number");
    expect(reference).not.toMatch(
      /external[_ -]?sync|projection|authority|candidate|marker|revision|sidecar|reconciliation/i
    );
  });

  it("round-trips first-class node size, keeping width-only sizes", () => {
    const project = createEmptyStudioProject({
      name: "Sized",
      policyPath: "SystemSculpt/Studio/Sized.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "node_1",
      kind: "studio.text",
      version: "1.0.0",
      title: "Text",
      position: { x: 10, y: 20 },
      size: { width: 320, height: 240 },
      config: { value: "hello" },
      continueOnError: false,
      disabled: false,
    });

    const parsed = parseStudioProject(serializeStudioProject(project));
    expect(parsed.graph.nodes[0].size).toEqual({ width: 320, height: 240 });

    const corrupted = JSON.parse(serializeStudioProject(project));
    corrupted.canvas.nodes[0].width = "abc";
    expect(parseStudioProject(JSON.stringify(corrupted)).graph.nodes[0].size).toBeUndefined();

    // Width-only sizes are the PERSISTED contract for intrinsic-height kinds
    // (text reflow, aspect-driven image/video cards) — regression guard: they
    // were once dropped as "partial", silently resetting resized images back
    // to the default width on the next load.
    corrupted.canvas.nodes[0].width = 320;
    delete corrupted.canvas.nodes[0].height;
    expect(parseStudioProject(JSON.stringify(corrupted)).graph.nodes[0].size).toEqual({
      width: 320,
    });

    delete corrupted.canvas.nodes[0].width;
    expect(parseStudioProject(JSON.stringify(corrupted)).graph.nodes[0].size).toBeUndefined();
  });

  it("round-trips a minimal text-to-image prompt edge without migration", () => {
    const project = createEmptyStudioProject({
      name: "Text prompt",
      policyPath: "SystemSculpt/Studio/Text prompt.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.2.2",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push(
      {
        id: "prompt",
        kind: "studio.text",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 20, y: 20 },
        size: { width: 280 },
        config: { value: "Portrait of a fox in amber light", fontSize: 14 },
        continueOnError: false,
        disabled: false,
      },
      {
        id: "image",
        kind: "studio.image_generation",
        version: "1.0.0",
        title: "Image Generation",
        position: { x: 400, y: 20 },
        config: { count: 1, aspectRatio: "1:1" },
        continueOnError: false,
        disabled: false,
      },
    );
    project.graph.edges.push({
      id: "prompt-edge",
      fromNodeId: "prompt",
      fromPortId: "text",
      toNodeId: "image",
      toPortId: "prompt",
    });
    project.graph.entryNodeIds = ["prompt"];

    const serialized = serializeStudioProject(project);
    expect(JSON.parse(serialized).canvas.edges).toEqual(["prompt.text -> image.prompt"]);

    const parsed = parseStudioProject(serialized);
    expect(parsed.graph.edges).toEqual([
      {
        id: "prompt.text->image.prompt",
        fromNodeId: "prompt",
        fromPortId: "text",
        toNodeId: "image",
        toPortId: "prompt",
      },
    ]);
    expect(parsed.graph.nodes.find((node) => node.id === "prompt")?.config.value).toBe(
      "Portrait of a fox in amber light"
    );
    // Entry points are derived from graph structure at run time; v2 never persists them.
    expect(parsed.graph.entryNodeIds).toEqual([]);

    // A text node has exactly one output port, so the from-side port may be omitted.
    const shorthand = JSON.parse(serialized);
    shorthand.canvas.edges = ["prompt -> image.prompt"];
    expect(parseStudioProject(JSON.stringify(shorthand)).graph.edges).toEqual(parsed.graph.edges);
  });

  it("heals entry IDs that reference missing nodes instead of failing to parse", () => {
    const project = createEmptyStudioProject({
      name: "Stale entries",
      policyPath: "SystemSculpt/Studio/Stale entries.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.2.2",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "prompt",
      kind: "studio.text",
      version: "1.0.0",
      title: "Prompt",
      position: { x: 20, y: 20 },
      config: { value: "hello", fontSize: 14 },
      continueOnError: false,
      disabled: false,
    });
    project.graph.entryNodeIds = ["deleted-node", "prompt"];

    // The in-memory model doubles as a v1 document, which is where persisted
    // entry IDs can still appear and need healing.
    const parsed = parseStudioProject(JSON.stringify(project));
    expect(parsed.schema).toBe(STUDIO_PROJECT_SCHEMA_V1);
    expect(parsed.graph.entryNodeIds).toEqual(["prompt"]);

    // v2 never persists entry IDs, so stale ones cannot survive an upgrade.
    expect(parseStudioProject(serializeStudioProject(project)).graph.entryNodeIds).toEqual([]);
  });

  it("migrates legacy canvas-like payloads into v1", () => {
    const legacy = {
      name: "Legacy",
      nodes: [{ id: "n1", text: "hello", x: 10, y: 20 }],
      edges: [],
    };
    const parsed = parseStudioProject(JSON.stringify(legacy));
    expect(parsed.schema).toBe(STUDIO_PROJECT_SCHEMA_V1);
    expect(parsed.graph.nodes.length).toBe(1);
    expect(parsed.migrations.applied[0].id).toBe("legacy-auto-migration");
  });

  it("drops retired network grants while preserving retained policy capabilities", () => {
    const policy = createDefaultStudioPolicy();
    const legacyPolicy = {
      ...policy,
      grants: [{
      id: "grant_1",
      capability: "network",
      scope: { allowedDomains: ["systemsculpt.com"] },
      grantedAt: new Date().toISOString(),
      grantedByUser: true,
      }],
    };
    const parsed = parseStudioPolicy(JSON.stringify(legacyPolicy));
    expect(parsed.schema).toBe("studio.policy.v1");
    expect(parsed.grants).toEqual([]);
  });

  it("normalizes valid group colors and rejects invalid group colors", () => {
    const project = createEmptyStudioProject({
      name: "Color",
      policyPath: "SystemSculpt/Studio/Color.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "node_1",
      kind: "studio.input",
      version: "1.0.0",
      title: "Input",
      position: { x: 80, y: 80 },
      config: {},
      continueOnError: false,
      disabled: false,
    });
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        color: "#AbC",
        nodeIds: ["node_1"],
      },
    ];

    const parsed = parseStudioProject(serializeStudioProject(project));
    expect(parsed.graph.groups?.[0]?.color).toBe("#aabbcc");

    const invalidRaw = JSON.stringify({
      ...parsed,
      graph: {
        ...parsed.graph,
        groups: [
          {
            id: "group_1",
            name: "Group 1",
            color: "not-a-color",
            nodeIds: ["node_1"],
          },
        ],
      },
    });
    expect(() => parseStudioProject(invalidRaw)).toThrow('group.color must be a valid hex color');
  });
});
