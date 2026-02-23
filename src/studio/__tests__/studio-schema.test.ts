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

  it("parses and validates policy documents", () => {
    const policy = createDefaultStudioPolicy();
    policy.grants.push({
      id: "grant_1",
      capability: "network",
      scope: { allowedDomains: ["api.systemsculpt.com"] },
      grantedAt: new Date().toISOString(),
      grantedByUser: true,
    });
    const parsed = parseStudioPolicy(JSON.stringify(policy));
    expect(parsed.schema).toBe("studio.policy.v1");
    expect(parsed.grants.length).toBe(1);
    expect(parsed.grants[0].scope.allowedDomains).toContain("api.systemsculpt.com");
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
