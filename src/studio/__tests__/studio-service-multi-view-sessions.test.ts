import { StudioService } from "../StudioService";
import type { StudioProjectV1 } from "../types";
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

function projectFixtureForPath(projectPath: string, nodeId: string): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: `proj_${nodeId}`,
    name: `Project ${nodeId}`,
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes: [
        {
          id: nodeId,
          kind: "studio.text_output",
          version: "1.0.0",
          title: `Node ${nodeId}`,
          position: { x: 40, y: 40 },
          config: { value: "" },
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: [nodeId],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: `${projectPath}-assets/policy/grants.json`,
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 100,
        maxArtifactsMb: 1024,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

function nodeIdForPath(projectPath: string): string {
  return projectPath.includes("P1") ? "node_p1" : "node_p2";
}

function createServiceWithStubbedLoads(): StudioService {
  const service = new StudioService(createPluginStub());
  jest.spyOn((service as any).projectStore, "saveProject").mockResolvedValue(undefined);
  jest
    .spyOn(service as any, "loadProjectForSession")
    .mockImplementation(async (...args: unknown[]) => {
      const projectPath = String(args[0]);
      return {
        project: projectFixtureForPath(projectPath, nodeIdForPath(projectPath)),
        rawText: "{}",
      };
    });
  return service;
}

describe("StudioService multi-view session ownership", () => {
  const services: StudioService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.dispose()));
  });
  const createService = (): StudioService => {
    const service = createServiceWithStubbedLoads();
    services.push(service);
    return service;
  };

  it("keeps project 1's session open when project 2 is opened by another view", async () => {
    const service = createService();

    const sessionP1 = await service.retainProjectSession("Studio/P1.systemsculpt");
    const sessionP2 = await service.retainProjectSession("Studio/P2.systemsculpt");

    expect(service.getProjectSession("Studio/P1.systemsculpt")).toBe(sessionP1);
    expect(service.getProjectSession("Studio/P2.systemsculpt")).toBe(sessionP2);
    expect(sessionP1).not.toBe(sessionP2);
  });

  it("routes path-scoped mutations to the matching project graph while both projects are open", async () => {
    const service = createService();

    const sessionP1 = await service.retainProjectSession("Studio/P1.systemsculpt");
    const sessionP2 = await service.retainProjectSession("Studio/P2.systemsculpt");

    const moved = service.mutateProject("Studio/P1.systemsculpt", "node.position", (project) => {
      const target = project.graph.nodes.find((node) => node.id === "node_p1");
      if (!target) {
        return false;
      }
      target.position = { x: 500, y: 640 };
      return true;
    });

    expect(moved).toBe(true);
    expect(sessionP1.getProject().graph.nodes[0].position).toEqual({ x: 500, y: 640 });
    expect(sessionP2.getProject().graph.nodes[0].position).toEqual({ x: 40, y: 40 });
  });

  it("keeps a project session open until every retaining view has released it", async () => {
    const service = createService();

    const first = await service.retainProjectSession("Studio/P1.systemsculpt");
    const second = await service.retainProjectSession("Studio/P1.systemsculpt");
    expect(second).toBe(first);

    await service.releaseProjectSession("Studio/P1.systemsculpt");
    expect(service.getProjectSession("Studio/P1.systemsculpt")).toBe(first);

    await service.releaseProjectSession("Studio/P1.systemsculpt");
    expect(service.getProjectSession("Studio/P1.systemsculpt")).toBeNull();
  });
});
