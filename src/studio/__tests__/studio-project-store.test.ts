import { StudioProjectStore } from "../StudioProjectStore";
import { deriveStudioAssetsDir, deriveStudioPolicyPath, sanitizeStudioProjectName } from "../paths";

type InMemoryApp = {
  vault: {
    adapter: {
      exists: (path: string) => Promise<boolean>;
      mkdir: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
      writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
      read: (path: string) => Promise<string>;
      readBinary: (path: string) => Promise<ArrayBuffer>;
      process: (path: string, update: (data: string) => string) => Promise<string>;
      copy: (source: string, destination: string) => Promise<void>;
      list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
      remove: (path: string) => Promise<void>;
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
    writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
      files.set(path, new TextDecoder().decode(data));
    }),
    readBinary: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value === "undefined") throw new Error(`File not found: ${path}`);
      return new TextEncoder().encode(value).buffer;
    }),
    process: jest.fn(async (path: string, update: (data: string) => string) => {
      const value = files.get(path);
      if (typeof value === "undefined") throw new Error(`File not found: ${path}`);
      const nextValue = update(value);
      files.set(path, nextValue);
      return nextValue;
    }),
    copy: jest.fn(async (source: string, destination: string) => {
      const value = files.get(source);
      if (typeof value === "undefined") throw new Error(`File not found: ${source}`);
      if (files.has(destination) || dirs.has(destination)) {
        throw new Error(`Path already exists: ${destination}`);
      }
      files.set(destination, value);
    }),
    list: jest.fn(async (path: string) => {
      const prefix = path ? `${path}/` : "";
      const listedFiles = Array.from(files.keys()).filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"));
      const listedFolders = new Set(Array.from(dirs).filter((dir) => dir.startsWith(prefix) && dir !== path).map((dir) => `${prefix}${dir.slice(prefix.length).split("/")[0]}`));
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const tail = file.slice(prefix.length);
        if (tail.includes("/")) listedFolders.add(`${prefix}${tail.split("/")[0]}`);
      }
      return { files: listedFiles.sort(), folders: [...listedFolders].sort() };
    }),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
      for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
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

  it("serializes concurrent support publications by reloading ExpectedGeneration", async () => {
    const { store } = createStore();
    const created = await store.createProject({ name: "Concurrent", minPluginVersion: "4.13.0", maxRuns: 100, maxArtifactsMb: 512 });
    await Promise.all([0, 1, 2].map((index) => store.putAsset(created.path, created.project.projectId, {
      contentAddressedPath: `0${index}/${String(index).repeat(64)}.bin`,
      bytes: new Uint8Array([index]),
    })));
    for (let index = 0; index < 3; index += 1) {
      const absolute = `${deriveStudioAssetsDir(created.path)}/assets/sha256/0${index}/${String(index).repeat(64)}.bin`;
      expect(await store.readSupportFile(created.path, absolute)).toEqual(new Uint8Array([index]));
    }
  });

  it("force reload invalidates the selected generation and ingests a one-file external edit", async () => {
    const { store, files } = createStore();
    const created = await store.createProject({ name: "Direct edit", minPluginVersion: "4.13.0", maxRuns: 100, maxArtifactsMb: 512 });
    expect((await store.loadProject(created.path)).name).toBe("Direct edit");

    const externallyEdited = JSON.parse(files.get(created.path)!) as Record<string, unknown>;
    externallyEdited.name = "Edited outside Studio";
    externallyEdited.updatedAt = "2026-07-15T12:00:00.000Z";
    files.set(created.path, `${JSON.stringify(externallyEdited, null, 2)}\n`);

    expect((await store.loadProject(created.path)).name).toBe("Direct edit");
    expect((await store.loadProject(created.path, { forceReload: true })).name).toBe("Edited outside Studio");
    const recovered = await store.generations.recover(created.project.projectId);
    expect(recovered.status).toBe("ready");
    if (recovered.status === "ready") {
      expect(recovered.expectedGeneration.revision).toBe(1);
      expect(recovered.generation.metadata.commandKind).toBe("external_sync");
    }
  });

  it("keeps persistence bookkeeping out of project-file errors", async () => {
    const { store, files } = createStore();
    const created = await store.createProject({
      name: "Invalid file",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });
    files.set(created.path, "{");

    let message = "";
    try {
      await store.loadProject(created.path, { forceReload: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Studio couldn't read this project file");
    expect(message).not.toMatch(
      /external|sync|projection|authority|generation|candidate|marker|revision|hash/i
    );
    expect(files.get(created.path)).toBe("{");
  });

  it("publishes a renamed projection and retires the old visible paths safely", async () => {
    const { store, files, dirs } = createStore();

    const created = await store.createProject({
      name: "Original",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });
    const oldAssetsDir = deriveStudioAssetsDir(created.path);
    await store.putAsset(created.path, created.project.projectId, {
      contentAddressedPath: `aa/${"a".repeat(64)}.txt`,
      bytes: new TextEncoder().encode("blob"),
    });

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
    expect(files.has(`${oldAssetsDir}/assets/sha256/aa/${"a".repeat(64)}.txt`)).toBe(false);
    expect(files.has(`${newAssetsDir}/assets/sha256/aa/${"a".repeat(64)}.txt`)).toBe(true);
    expect([...files.keys()].some((path) => path.includes("/retired/"))).toBe(true);
    expect(renamedProject.name).toBe("Renamed");
    expect(renamedProject.permissionsRef.policyPath).toBe(deriveStudioPolicyPath(renamed.newPath));
  });
});
