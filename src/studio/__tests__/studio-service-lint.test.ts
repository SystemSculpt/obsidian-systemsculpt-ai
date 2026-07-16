import { createEmptyStudioProject, serializeStudioProject } from "../schema";
import { StudioService } from "../StudioService";
import { createManagedCapabilityGraphStub, getManagedStudioTestVaultName } from "./managed-capability-graph.stub";

function createPluginStub(): any {
  const adapter = {
    exists: jest.fn(async () => false),
    mkdir: jest.fn(async () => {}),
    write: jest.fn(async () => {}),
    read: jest.fn(async () => ""),
  };
  return {
    app: {
      vault: {
        adapter,
        getName: getManagedStudioTestVaultName,
        configDir: ".obsidian",
      },
    },
    manifest: {
      id: "systemsculpt-ai",
      version: "9.9.9",
      dir: "/tmp/systemsculpt-ai",
    },
    settings: {
      studioDefaultProjectsFolder: "SystemSculpt/Studio",
      studioRunRetentionMaxRuns: 100,
      studioRunRetentionMaxArtifactsMb: 1024,
      licenseKey: "test-license-key",
      serverUrl: "https://systemsculpt.com",
    },
    getLogger: () => ({
      warn: jest.fn(),
      error: jest.fn(),
    }),
    getManagedCapabilityGraph: createManagedCapabilityGraphStub,
  };
}

describe("StudioService lintProjectText", () => {
  it("returns ok for parse+compile valid projects", () => {
    const service = new StudioService(createPluginStub());
    const project = createEmptyStudioProject({
      name: "Lint",
      policyPath: "SystemSculpt/Studio/Lint.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "9.9.9",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "node_input",
      kind: "studio.input",
      version: "1.0.0",
      title: "Input",
      position: { x: 80, y: 120 },
      config: { value: "hello" },
      continueOnError: false,
      disabled: false,
    });

    const result = service.lintProjectText(serializeStudioProject(project));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.name).toBe("Lint");
      expect(result.project.graph.nodes).toHaveLength(1);
    }
  });

  it("fails when parse/schema is invalid", () => {
    const service = new StudioService(createPluginStub());
    const result = service.lintProjectText("{\"name\":\"Broken\"}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("fails when compile validation fails", () => {
    const service = new StudioService(createPluginStub());
    const project = createEmptyStudioProject({
      name: "Unknown",
      policyPath: "SystemSculpt/Studio/Unknown.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "9.9.9",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "node_custom",
      kind: "studio.not_registered",
      version: "1.0.0",
      title: "Unknown",
      position: { x: 120, y: 120 },
      config: {},
      continueOnError: false,
      disabled: false,
    });

    const result = service.lintProjectText(serializeStudioProject(project));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing node definition");
    }
  });

  it("rejects raw node geometry that the compatibility parser would normalize", () => {
    const service = new StudioService(createPluginStub());
    const project = createEmptyStudioProject({
      name: "Raw geometry",
      policyPath: "SystemSculpt/Studio/Raw geometry.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "9.9.9",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "node_input",
      kind: "studio.input",
      version: "1.0.0",
      title: "Input",
      position: { x: 80, y: 120 },
      config: { value: "hello" },
      continueOnError: false,
      disabled: false,
    });
    const rawDocument = JSON.parse(serializeStudioProject(project));
    rawDocument.graph.nodes[0].position.x = "80";

    const result = service.lintProjectText(JSON.stringify(rawDocument));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("position.x must be a finite number");
    }
  });

  it("rejects raw group membership that the compatibility parser would discard", () => {
    const service = new StudioService(createPluginStub());
    const project = createEmptyStudioProject({
      name: "Raw groups",
      policyPath: "SystemSculpt/Studio/Raw groups.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "9.9.9",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    project.graph.nodes.push({
      id: "node_input",
      kind: "studio.input",
      version: "1.0.0",
      title: "Input",
      position: { x: 80, y: 120 },
      config: { value: "hello" },
      continueOnError: false,
      disabled: false,
    });
    project.graph.groups.push({
      id: "group_missing_member",
      name: "Missing member",
      nodeIds: ["node_missing"],
    });

    const result = service.lintProjectText(serializeStudioProject(project));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('references missing node "node_missing"');
    }
  });
});
