import { StudioProjectStore } from "../StudioProjectStore";
import { deriveStudioAssetsDir, deriveStudioPolicyPath, sanitizeStudioProjectName } from "../paths";

type InMemoryApp = {
  vault: {
    adapter: {
      exists: (path: string) => Promise<boolean>;
      mkdir: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
      read: (path: string) => Promise<string>;
      rename: (source: string, destination: string) => Promise<void>;
    };
    getAbstractFileByPath?: (path: string) => unknown;
    getFiles: () => Array<{ path: string }>;
  };
};

function createStore(options?: { existingFiles?: string[]; existingDirs?: string[] }) {
  const existingFiles = options?.existingFiles || [];
  const existingDirs = options?.existingDirs || [];
  const files = new Map<string, string>();
  for (const filePath of existingFiles) {
    files.set(filePath, "{}");
  }
  const dirs = new Set<string>(existingDirs);

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || dirs.has(path)),
    mkdir: jest.fn(async (path: string) => {
      dirs.add(path);
    }),
    write: jest.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value === "undefined") {
        throw new Error(`File not found: ${path}`);
      }
      return value;
    }),
    rename: jest.fn(async (source: string, destination: string) => {
      if (files.has(source)) {
        const value = files.get(source)!;
        files.delete(source);
        files.set(destination, value);
        return;
      }

      if (!dirs.has(source)) {
        throw new Error(`Path not found: ${source}`);
      }

      const dirRenames = Array.from(dirs)
        .filter((path) => path === source || path.startsWith(`${source}/`))
        .sort((left, right) => left.length - right.length);
      for (const oldDir of dirRenames) {
        dirs.delete(oldDir);
        const nextDir = oldDir === source ? destination : `${destination}${oldDir.slice(source.length)}`;
        dirs.add(nextDir);
      }

      const fileRenames = Array.from(files.entries())
        .filter(([path]) => path.startsWith(`${source}/`))
        .sort(([left], [right]) => left.length - right.length);
      for (const [oldPath, value] of fileRenames) {
        files.delete(oldPath);
        files.set(`${destination}${oldPath.slice(source.length)}`, value);
      }
    }),
  };

  const app: InMemoryApp = {
    vault: {
      adapter,
      getAbstractFileByPath: () => null,
      getFiles: () => Array.from(files.keys()).map((path) => ({ path })),
    },
  };

  return {
    dirs,
    files,
    store: new StudioProjectStore(app as any),
  };
}

describe("StudioProjectStore", () => {
  it("sanitizes human-readable names while removing path-breaking characters", () => {
    expect(sanitizeStudioProjectName("  Launch: Plan / Alpha?  ")).toBe("Launch Plan Alpha");
    expect(sanitizeStudioProjectName("")).toBe("Untitled Studio Project");
  });

  it("auto-suffixes .systemsculpt paths when collisions exist", async () => {
    const { store, files } = createStore({
      existingFiles: [
        "SystemSculpt/Studio/New Studio Project.systemsculpt",
        "SystemSculpt/Studio/New Studio Project (2).systemsculpt",
      ],
    });

    const created = await store.createProject({
      name: "New Studio Project",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });

    expect(created.path).toBe("SystemSculpt/Studio/New Studio Project (3).systemsculpt");
    expect(files.has("SystemSculpt/Studio/New Studio Project (3).systemsculpt")).toBe(true);
    expect(
      files.has("SystemSculpt/Studio/New Studio Project (3).systemsculpt-assets/project.manifest.json")
    ).toBe(true);
  });

  it("normalizes manual project paths and applies collision suffixes", async () => {
    const { store } = createStore({ existingFiles: ["Custom/Flow.systemsculpt"] });

    const created = await store.createProject({
      name: "Flow",
      projectPath: "Custom/Flow",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });

    expect(created.path).toBe("Custom/Flow (2).systemsculpt");
  });

  it("treats pre-existing assets folders as path collisions", async () => {
    const { store } = createStore({
      existingDirs: ["Custom/Flow.systemsculpt-assets"],
    });

    const created = await store.createProject({
      name: "Flow",
      projectPath: "Custom/Flow",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });

    expect(created.path).toBe("Custom/Flow (2).systemsculpt");
  });

  it("renames the Studio project file and assets tree together", async () => {
    const { store, files, dirs } = createStore();

    const created = await store.createProject({
      name: "Original",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });
    const oldAssetsDir = deriveStudioAssetsDir(created.path);
    files.set(`${oldAssetsDir}/assets/sha256/blob.txt`, "blob");
    dirs.add(`${oldAssetsDir}/assets`);
    dirs.add(`${oldAssetsDir}/assets/sha256`);

    const renamed = await store.renameProject(created.path, "Renamed", {
      project: created.project,
    });
    const newAssetsDir = deriveStudioAssetsDir(renamed.newPath);
    const renamedProject = await store.loadProject(renamed.newPath);

    expect(renamed.oldPath).toBe("SystemSculpt/Studio/Original.systemsculpt");
    expect(renamed.newPath).toBe("SystemSculpt/Studio/Renamed.systemsculpt");
    expect(files.has("SystemSculpt/Studio/Original.systemsculpt")).toBe(false);
    expect(files.has("SystemSculpt/Studio/Renamed.systemsculpt")).toBe(true);
    expect(files.has(`${oldAssetsDir}/project.manifest.json`)).toBe(false);
    expect(files.has(`${newAssetsDir}/project.manifest.json`)).toBe(true);
    expect(files.has(`${oldAssetsDir}/assets/sha256/blob.txt`)).toBe(false);
    expect(files.has(`${newAssetsDir}/assets/sha256/blob.txt`)).toBe(true);
    expect(renamedProject.name).toBe("Renamed");
    expect(renamedProject.permissionsRef.policyPath).toBe(deriveStudioPolicyPath(renamed.newPath));
  });
});
