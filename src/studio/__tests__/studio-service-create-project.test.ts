import { StudioService } from "../StudioService";

function createPluginStub(): any {
  const files = new Map<string, string>();
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path)),
    mkdir: jest.fn(async () => {}),
    write: jest.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (value == null) {
        throw new Error(`missing file: ${path}`);
      }
      return value;
    }),
  };
  return {
    app: {
      vault: {
        adapter,
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
      serverUrl: "https://api.systemsculpt.com",
    },
    getLogger: () => ({
      warn: jest.fn(),
      error: jest.fn(),
    }),
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
