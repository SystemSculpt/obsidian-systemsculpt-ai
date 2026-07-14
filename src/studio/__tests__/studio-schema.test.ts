import {
  createDefaultStudioPolicy,
  createEmptyStudioProject,
  parseStudioPolicy,
  parseStudioProject,
  serializeStudioProject,
} from "../schema";
import { STUDIO_PROJECT_SCHEMA_V1 } from "../types";

describe("Studio schema", () => {
  it("round-trips a v1 project document", () => {
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
    corrupted.graph.nodes[0].size = { width: "abc", height: 240 };
    expect(parseStudioProject(JSON.stringify(corrupted)).graph.nodes[0].size).toBeUndefined();

    // Width-only sizes are the PERSISTED contract for intrinsic-height kinds
    // (text reflow, aspect-driven image/video cards) — regression guard: they
    // were once dropped as "partial", silently resetting resized images back
    // to the default width on the next load.
    corrupted.graph.nodes[0].size = { width: 320 };
    expect(parseStudioProject(JSON.stringify(corrupted)).graph.nodes[0].size).toEqual({
      width: 320,
    });

    delete corrupted.graph.nodes[0].size;
    expect(parseStudioProject(JSON.stringify(corrupted)).graph.nodes[0].size).toBeUndefined();
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
