import { Platform } from "obsidian";
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

  it("coalesces concurrent first retains into one shared session", async () => {
    const service = createService();
    const loadProjectForSession = (service as any).loadProjectForSession as jest.Mock;

    const [first, second] = await Promise.all([
      service.retainProjectSession("Studio/P1.systemsculpt"),
      service.retainProjectSession("Studio/P1.systemsculpt"),
    ]);

    expect(second).toBe(first);
    expect(loadProjectForSession).toHaveBeenCalledTimes(1);
    await service.releaseProjectSession("Studio/P1.systemsculpt");
    expect(service.getProjectSession("Studio/P1.systemsculpt")).toBe(first);
    await service.releaseProjectSession("Studio/P1.systemsculpt");
    expect(service.getProjectSession("Studio/P1.systemsculpt")).toBeNull();
  });

  it("reconciles a direct file edit when the project is reopened after the last view closes", async () => {
    const service = new StudioService(createPluginStub());
    services.push(service);
    jest.spyOn((service as any).projectStore, "saveProject").mockResolvedValue(undefined);
    const projectPath = "Studio/P1.systemsculpt";
    let visibleProject = projectFixtureForPath(projectPath, "node_p1");
    let cachedProject: StudioProjectV1 | null = null;
    jest.spyOn(service as any, "loadProjectForSession").mockImplementation(async (
      _path: string,
      options?: { forceReload?: boolean }
    ) => {
      if (!cachedProject || options?.forceReload === true) {
        cachedProject = JSON.parse(JSON.stringify(visibleProject)) as StudioProjectV1;
      }
      return {
        project: JSON.parse(JSON.stringify(cachedProject)) as StudioProjectV1,
        rawText: JSON.stringify(cachedProject),
      };
    });

    const first = await service.retainProjectSession(projectPath);
    expect(first.getProject().name).toBe("Project node_p1");
    await service.releaseProjectSession(projectPath);
    expect(service.getProjectSession(projectPath)).toBeNull();

    visibleProject = {
      ...visibleProject,
      name: "Edited while Studio was closed",
      updatedAt: "2026-07-15T12:00:00.000Z",
    };

    const reopened = await service.retainProjectSession(projectPath);
    expect(reopened).not.toBe(first);
    expect(reopened.getProject().name).toBe("Edited while Studio was closed");
  });
  it("prepares native connected context through the shared graph plan without rerunning recorded producers or losing fan-in", async () => {
    (Platform as { isDesktopApp: boolean }).isDesktopApp = false;
    const service = createService();
    const path = "Studio/P1.systemsculpt";
    const session = await service.retainProjectSession(path);
    const produce = jest.fn(async () => ({ outputs: { json: "must not run" } }));
    (service as any).registry.register({
      kind: "test.expensive", version: "1.0.0", requiredHostCapabilities: [], capabilityClass: "local_cpu", cachePolicy: "never",
      inputPorts: [], outputPorts: [{ id: "json", type: "json" }], configDefaults: {}, configSchema: { fields: [] }, execute: produce,
    });
    session.mutate("project.repair", project => {
      project.graph.nodes = [
        { id: "saved", kind: "test.expensive", version: "1.0.0", position: { x: 0, y: 0 }, config: {} },
        { id: "fresh", kind: "studio.json", version: "1.0.0", position: { x: 0, y: 0 }, config: { value: { fresh: true } } },
        { id: "role", kind: "studio.codex", version: "1.0.0", position: { x: 0, y: 0 }, config: { prompt: "Review both sources", workingDirectory: "." } },
      ];
      project.graph.edges = ["saved", "fresh"].map(id => ({ id: `edge-${id}`, fromNodeId: id, fromPortId: "json", toNodeId: "role", toPortId: "context" }));
    });
    const cache = {
      schema: "studio.node-cache.v1", projectId: session.getProject().projectId, updatedAt: "2026-09-17T00:00:00.000Z",
      entries: { saved: { nodeId: "saved", nodeKind: "test.expensive", nodeVersion: "1.0.0", inputFingerprint: "earlier", runId: "earlier", updatedAt: "2026-09-17T00:00:00.000Z", outputs: { json: [{ saved: true }] } } },
    };
    jest.spyOn((service as any).projectStore, "readSupportFile").mockImplementation(async (_path: string, file: string) => file.endsWith("node-results.json") ? new TextEncoder().encode(JSON.stringify(cache)) : null);
    jest.spyOn((service as any).projectStore, "loadPolicy").mockResolvedValue({ schema: "studio.policy.v1", version: 1, grants: [] });
    const publish = jest.spyOn((service as any).projectStore, "publishRun").mockResolvedValue(undefined);
    jest.spyOn((service as any).apiAdapter, "beginLocalCommit").mockResolvedValue(undefined);
    jest.spyOn((service as any).apiAdapter, "completeLocalCommit").mockResolvedValue(undefined);
    let prompt = "";
    jest.spyOn(service.agentRuns, "start").mockImplementation(async (input: any) => {
      prompt = (await input.prepare()).prompt;
      return { id: "native-run" } as never;
    });
    await service.startAgentRun(path, "role");
    expect(JSON.parse(prompt.split("Connected context:\n")[1])).toEqual({ context: [[{ saved: true }], { fresh: true }] });
    expect(produce).not.toHaveBeenCalled();
    const events = new TextDecoder().decode(publish.mock.calls[0][1].eventsDocument);
    expect(events).toContain('"nodeId":"fresh"');
    expect(events).not.toContain('"nodeId":"role"');
    expect(events).not.toContain('"nodeId":"saved"');
  });

  it("waits for a pending retained-project load during service disposal", async () => {
    const service = createService();
    let finishLoad!: () => void;
    const waiting = new Promise<void>(resolve => { finishLoad = resolve; });
    (service as any).loadProjectForSession.mockImplementation(async (path: string) => {
      await waiting;
      return { project: projectFixtureForPath(path, "node_p1"), rawText: "{}" };
    });
    const retaining = service.retainProjectSession("Studio/P1.systemsculpt");
    await Promise.resolve(); await Promise.resolve();
    const disposing = service.dispose();
    finishLoad();
    const session = await retaining;
    await disposing;
    expect(session.isDisposed()).toBe(true);
    expect(service.getProjectSession("Studio/P1.systemsculpt")).toBeNull();
    await expect(service.retainProjectSession("Studio/P2.systemsculpt")).rejects.toThrow("disposed");
  });

});
