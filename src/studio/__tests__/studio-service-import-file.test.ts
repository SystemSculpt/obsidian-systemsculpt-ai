import { deriveStudioImportsDir } from "../paths";
import { StudioService } from "../StudioService";
import type { StudioProjectV1 } from "../types";
import {
  createManagedCapabilityGraphStub,
  getManagedStudioTestVaultName,
} from "./managed-capability-graph.stub";

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

function projectFixture(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_imports",
    name: "Import Test",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes: [],
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/Import Test.systemsculpt-assets/policy/grants.json",
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

describe("StudioService.importFileToProject", () => {
  it("writes imported browser files into the project-owned imports directory", async () => {
    const service = new StudioService(createPluginStub());
    const projectPath = "SystemSculpt/Studio/Import Test.systemsculpt";
    const loadProject = jest
      .spyOn((service as any).projectStore, "loadProject")
      .mockResolvedValue(projectFixture());
    const putSupportFile = jest
      .spyOn((service as any).projectStore, "putSupportFile")
      .mockResolvedValue(undefined);
    const bytes = new TextEncoder().encode("image-bytes").buffer;

    const importedPath = await service.importFileToProject(projectPath, {
      bytes,
      name: "../My bad:name.jpeg",
      mimeType: "image/png",
    });

    expect(loadProject).toHaveBeenCalledWith(projectPath);
    expect(putSupportFile).toHaveBeenCalledTimes(1);
    const storedFile = putSupportFile.mock.calls[0]?.[2];
    expect(putSupportFile).toHaveBeenCalledWith(
      projectPath,
      "proj_imports",
      expect.objectContaining({
        supportRelativePath: expect.stringMatching(
          /^imports\/My-bad-name-[0-9a-f]{12}\.png$/
        ),
        bytes: expect.any(Uint8Array),
      })
    );
    expect(Array.from(storedFile.bytes)).toEqual(Array.from(new Uint8Array(bytes)));
    expect(importedPath).toBe(
      `${deriveStudioImportsDir(projectPath)}/${storedFile.supportRelativePath.slice("imports/".length)}`
    );
  });

  it("deduplicates repeated filenames by hashing the imported bytes", async () => {
    const service = new StudioService(createPluginStub());
    const projectPath = "SystemSculpt/Studio/Import Test.systemsculpt";
    jest.spyOn((service as any).projectStore, "loadProject").mockResolvedValue(projectFixture());
    const putSupportFile = jest
      .spyOn((service as any).projectStore, "putSupportFile")
      .mockResolvedValue(undefined);

    const firstPath = await service.importFileToProject(projectPath, {
      bytes: new TextEncoder().encode("first").buffer,
      name: "duplicate.txt",
      mimeType: "text/plain",
    });
    const secondPath = await service.importFileToProject(projectPath, {
      bytes: new TextEncoder().encode("second").buffer,
      name: "duplicate.txt",
      mimeType: "text/plain",
    });

    const firstStored = putSupportFile.mock.calls[0]?.[2]?.supportRelativePath;
    const secondStored = putSupportFile.mock.calls[1]?.[2]?.supportRelativePath;
    expect(firstStored).toMatch(/^imports\/duplicate-[0-9a-f]{12}\.txt$/);
    expect(secondStored).toMatch(/^imports\/duplicate-[0-9a-f]{12}\.txt$/);
    expect(firstStored).not.toBe(secondStored);
    expect(firstPath).not.toBe(secondPath);
  });
});
