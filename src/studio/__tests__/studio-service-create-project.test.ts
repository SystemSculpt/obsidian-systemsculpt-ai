import { StudioService } from "../StudioService";
import { createManagedCapabilityGraphStub, getManagedStudioTestVaultName } from "./managed-capability-graph.stub";

function createPluginStub(): any {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path)),
    mkdir: jest.fn(async (path: string) => { dirs.add(path); }),
    write: jest.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (value == null) throw new Error(`missing file: ${path}`);
      return value;
    }),
    writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => { files.set(path, new TextDecoder().decode(data)); }),
    readBinary: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (value == null) throw new Error(`missing file: ${path}`);
      return new TextEncoder().encode(value).buffer;
    }),
    list: jest.fn(async (path: string) => {
      const prefix = path ? `${path}/` : "";
      const directFiles = [...files.keys()].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"));
      const folders = new Set<string>();
      for (const candidate of [...dirs, ...files.keys()]) {
        if (!candidate.startsWith(prefix) || candidate === path) continue;
        const first = candidate.slice(prefix.length).split("/")[0];
        if (first && candidate.slice(prefix.length).includes("/")) folders.add(`${prefix}${first}`);
      }
      return { files: directFiles, folders: [...folders] };
    }),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
      for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
    }),
  };
  return {
    app: {
      vault: {
        adapter,
        getName: getManagedStudioTestVaultName,
        configDir: ".obsidian",
        getFiles: () => [],
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

describe("StudioService.createProject", () => {
  it("creates a blank project with no seeded nodes or edges", async () => {
    const service = new StudioService(createPluginStub());

    const project = await service.createProject({ name: "Blank Canvas" });

    expect(project.graph.nodes).toEqual([]);
    expect(project.graph.edges).toEqual([]);
    expect(project.graph.entryNodeIds).toEqual([]);
  });
});
