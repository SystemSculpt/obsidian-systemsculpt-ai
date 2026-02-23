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
});

