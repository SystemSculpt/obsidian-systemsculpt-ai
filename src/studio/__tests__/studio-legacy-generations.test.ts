import { createEmptyStudioProject, serializeStudioProject } from "../schema";
import {
  STUDIO_LEGACY_CHECK_PATH,
  STUDIO_LEGACY_PROJECTS_DIR,
  checkStudioLegacyGenerations,
  formatStudioLegacyBytes,
  studioLegacyGenerationsOfferMessage,
  studioLegacyGenerationsResultMessage,
  type StudioLegacyGenerationsOffer,
} from "../StudioLegacyGenerations";

jest.mock("../../platform/hostCapabilities", () => ({ hasHostCapability: () => false }));

type Bytes = string | Uint8Array;
const size = (value: Bytes) => typeof value === "string" ? new TextEncoder().encode(value).length : value.length;

/** A vault adapter over a flat map of files; folders are the prefixes of file paths. */
function memoryVault(files: Map<string, Bytes>, options: { failRmdir?: string } = {}) {
  const isFolder = (path: string) => [...files.keys()].some((file) => file.startsWith(`${path}/`));
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || isFolder(path)),
    list: jest.fn(async (path: string) => {
      const children = new Set<string>(), result = { files: [] as string[], folders: [] as string[] };
      for (const file of files.keys()) {
        if (!file.startsWith(`${path}/`)) continue;
        const [name, ...rest] = file.slice(path.length + 1).split("/");
        const child = `${path}/${name}`;
        if (children.has(child)) continue;
        children.add(child);
        (rest.length ? result.folders : result.files).push(child);
      }
      return result;
    }),
    stat: jest.fn(async (path: string) => files.has(path) ? { type: "file", ctime: 0, mtime: 0, size: size(files.get(path)!) } : null),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value !== "string") throw new Error(`File not found: ${path}`);
      return value;
    }),
    write: jest.fn(async (path: string, data: string) => { files.set(path, data); }),
    rmdir: jest.fn(async (path: string, recursive: boolean) => {
      if (!recursive) throw new Error("Folder is not empty.");
      if (path === options.failRmdir) throw new Error("EACCES: permission denied");
      for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
    }),
  };
  return {
    adapter,
    getFiles: () => [...files.keys()].filter((path) => !path.startsWith(".")).map((path) => ({ path })),
  };
}

function projectText(projectId: string, name: string): string {
  const project = createEmptyStudioProject({
    name,
    policyPath: `SystemSculpt/Studio/${name}.systemsculpt-assets/policy/grants.json`,
    minPluginVersion: "6.10.0",
    maxRuns: 100,
    maxArtifactsMb: 1024,
  });
  return serializeStudioProject({ ...project, projectId });
}

/** One PNG and one MP4, copied whole into every generation as Studio before 6.10 did. */
const PNG = new Uint8Array(1_200_000).fill(7);
const MP4 = new Uint8Array(2_400_000).fill(9);
const PNG_PATH = `support/assets/sha256/07/${"7".repeat(64)}.png`;
const MP4_PATH = `support/assets/sha256/09/${"9".repeat(64)}.mp4`;

function addLegacyGenerations(files: Map<string, Bytes>, projectId: string, count: number, text: string): void {
  for (let revision = 0; revision < count; revision++) {
    const hash = revision.toString(16).padStart(64, "0");
    const root = `${STUDIO_LEGACY_PROJECTS_DIR}/${projectId}/generations/${revision}-${hash}`;
    const entries = [
      { kind: "text", relativePath: "project.systemsculpt", sizeBytes: size(text) },
      { kind: "binary", relativePath: PNG_PATH, sizeBytes: PNG.length },
      { kind: "binary", relativePath: MP4_PATH, sizeBytes: MP4.length },
    ];
    files.set(`${root}/commit.json`, JSON.stringify({ generationHash: hash, projectId, revision, schemaVersion: 1 }));
    files.set(`${root}/manifest.json`, JSON.stringify({ commandKind: "discrete_save", entries }));
    files.set(`${root}/files/project.systemsculpt`, text);
    files.set(`${root}/files/${PNG_PATH}`, PNG);
    files.set(`${root}/files/${MP4_PATH}`, MP4);
  }
}

const folderOf = (projectId: string) => `${STUDIO_LEGACY_PROJECTS_DIR}/${projectId}`;
const bytesUnder = (files: Map<string, Bytes>, folder: string) =>
  [...files].filter(([path]) => path.startsWith(`${folder}/`)).reduce((total, [, value]) => total + size(value), 0);
const snapshot = (files: Map<string, Bytes>) => new Map(files);
const withoutCheck = (files: Map<string, Bytes>) => { const copy = snapshot(files); copy.delete(STUDIO_LEGACY_CHECK_PATH); return copy; };

/**
 * A vault from before 6.10: Alpha (a single-file project) and Board (a
 * directory project) open now; Broken fails to open; proj_gone's project file
 * was deleted.
 */
function legacyVault() {
  const files = new Map<string, Bytes>();
  const alpha = projectText("proj_alpha", "Alpha");
  const board = projectText("proj_board", "Board");
  files.set("SystemSculpt/Studio/Alpha.systemsculpt", alpha);
  files.set(`SystemSculpt/Studio/Alpha.systemsculpt-assets/assets/sha256/07/${"7".repeat(64)}.png`, PNG);
  files.set("SystemSculpt/Studio/Board.systemsculpt", JSON.stringify({ schema: "studio.entry.v1", id: "proj_board", projection: "Board.studio/views/graph.systemsculpt" }));
  files.set("SystemSculpt/Studio/Board.studio/views/graph.systemsculpt", board);
  // Valid JSON naming its project, but not a project Studio can open.
  files.set("SystemSculpt/Studio/Broken.systemsculpt", JSON.stringify({ schema: "studio.project.v2", id: "proj_broken", canvas: { nodes: "not a list" } }));
  files.set("Notes/Unrelated.md", "# Kept\n");
  addLegacyGenerations(files, "proj_alpha", 3, alpha);
  files.set(`${folderOf("proj_alpha")}/retired/1-${"1".repeat(64)}/support/project.manifest.json`, "{}");
  addLegacyGenerations(files, "proj_board", 2, board);
  addLegacyGenerations(files, "proj_broken", 2, alpha.replace("proj_alpha", "proj_broken"));
  addLegacyGenerations(files, "proj_gone", 2, alpha.replace("proj_alpha", "proj_gone"));
  return files;
}

describe("legacy Studio generations", () => {
  it("offers the folders of projects that open, and deletes only those after a yes", async () => {
    const files = legacyVault(), before = snapshot(files), vault = memoryVault(files);
    const expectedBytes = bytesUnder(files, folderOf("proj_alpha")) + bytesUnder(files, folderOf("proj_board"));
    const ask = jest.fn(async (_offer: StudioLegacyGenerationsOffer) => true);

    const result = await checkStudioLegacyGenerations({ vault, ask, now: () => new Date("2026-10-25T12:00:00.000Z") });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual({ folders: [folderOf("proj_alpha"), folderOf("proj_board")], bytes: expectedBytes });
    // Five generations, each with its own copy of the same 3.6 MB of media.
    expect(expectedBytes).toBeGreaterThan(5 * (PNG.length + MP4.length));
    expect(studioLegacyGenerationsOfferMessage(ask.mock.calls[0][0])).toBe(
      "SystemSculpt Studio no longer uses the project history saved before version 6.10. Delete it to free 18 MB? Your projects stay as they are.",
    );
    expect(result).toEqual({ status: "deleted", offer: ask.mock.calls[0][0], deletedBytes: expectedBytes, failed: [] });
    if (result.status === "deleted") expect(studioLegacyGenerationsResultMessage(result)).toBe("Deleted 18 MB of old Studio history.");

    expect(bytesUnder(files, folderOf("proj_alpha"))).toBe(0);
    expect(bytesUnder(files, folderOf("proj_board"))).toBe(0);
    expect(vault.adapter.rmdir.mock.calls).toEqual([[folderOf("proj_alpha"), true], [folderOf("proj_board"), true]]);
    // Everything else, the failing project's and the orphan's folders included, is byte for byte what it was.
    for (const [path, value] of before) {
      if (path.startsWith(`${folderOf("proj_alpha")}/`) || path.startsWith(`${folderOf("proj_board")}/`)) continue;
      expect(files.get(path)).toBe(value);
    }
    expect(JSON.parse(files.get(STUDIO_LEGACY_CHECK_PATH) as string)).toEqual({ outcome: "deleted", at: "2026-10-25T12:00:00.000Z" });

    const again = jest.fn(async () => true);
    await expect(checkStudioLegacyGenerations({ vault, ask: again })).resolves.toEqual({ status: "checked" });
    expect(again).not.toHaveBeenCalled();
  });

  it("deletes nothing after a no, and does not ask again", async () => {
    const files = legacyVault(), before = snapshot(files), vault = memoryVault(files);

    const result = await checkStudioLegacyGenerations({ vault, ask: async () => false, now: () => new Date("2026-10-25T12:00:00.000Z") });

    expect(result.status).toBe("kept");
    expect(vault.adapter.rmdir).not.toHaveBeenCalled();
    expect(vault.adapter.write.mock.calls.map(([path]) => path)).toEqual([STUDIO_LEGACY_CHECK_PATH]);
    expect(JSON.parse(files.get(STUDIO_LEGACY_CHECK_PATH) as string)).toEqual({ outcome: "kept", at: "2026-10-25T12:00:00.000Z" });
    expect(withoutCheck(files)).toEqual(before);

    const again = jest.fn(async () => true);
    await expect(checkStudioLegacyGenerations({ vault, ask: again })).resolves.toEqual({ status: "checked" });
    expect(again).not.toHaveBeenCalled();
    expect(vault.adapter.rmdir).not.toHaveBeenCalled();
  });

  it("leaves a project that fails to open untouched, even beside a copy that opens", async () => {
    const files = legacyVault();
    // A second copy of Alpha with the same identity that no longer opens.
    files.set("Archive/Alpha copy.systemsculpt", JSON.stringify({ schema: "studio.project.v2", id: "proj_alpha", canvas: { nodes: 3 } }));
    // A directory project whose canvas is missing.
    files.set("SystemSculpt/Studio/Board.studio/views/graph.systemsculpt", "{\"schema\":\"studio.project.v2\",");
    const before = snapshot(files), vault = memoryVault(files);
    const ask = jest.fn(async () => true);

    const result = await checkStudioLegacyGenerations({ vault, ask });

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "none" });
    expect(vault.adapter.rmdir).not.toHaveBeenCalled();
    expect(JSON.parse(files.get(STUDIO_LEGACY_CHECK_PATH) as string)).toMatchObject({ outcome: "nothing to offer" });
    expect(withoutCheck(files)).toEqual(before);
  });

  it("offers only the projects that open when another fails, and reports a folder it couldn't delete", async () => {
    const files = legacyVault(), vault = memoryVault(files, { failRmdir: folderOf("proj_board") });
    const boardBytes = bytesUnder(files, folderOf("proj_board"));
    const alphaBytes = bytesUnder(files, folderOf("proj_alpha"));

    const result = await checkStudioLegacyGenerations({ vault, ask: async () => true });

    expect(result).toMatchObject({ status: "deleted", deletedBytes: alphaBytes, failed: [folderOf("proj_board")] });
    expect(bytesUnder(files, folderOf("proj_board"))).toBe(boardBytes);
    if (result.status === "deleted") {
      expect(studioLegacyGenerationsResultMessage(result)).toBe(
        `Deleted ${formatStudioLegacyBytes(alphaBytes)} of old Studio history. 1 folder in .systemsculpt/studio/projects couldn't be deleted.`,
      );
      expect(studioLegacyGenerationsResultMessage({ ...result, deletedBytes: 0, failed: result.offer.folders.slice() })).toBe(
        "Studio couldn't delete its old project history in .systemsculpt/studio/projects.",
      );
    }
  });

  it("asks again at the next check when no answer came", async () => {
    const files = legacyVault(), before = snapshot(files), vault = memoryVault(files);

    await expect(checkStudioLegacyGenerations({ vault, ask: async () => null })).resolves.toEqual({ status: "unanswered" });
    expect(files).toEqual(before);

    const ask = jest.fn(async () => false);
    await expect(checkStudioLegacyGenerations({ vault, ask })).resolves.toMatchObject({ status: "kept" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does nothing in a vault without legacy generations", async () => {
    const files = new Map<string, Bytes>([["SystemSculpt/Studio/Alpha.systemsculpt", projectText("proj_alpha", "Alpha")]]);
    const vault = memoryVault(files), ask = jest.fn(async () => true);

    await expect(checkStudioLegacyGenerations({ vault, ask })).resolves.toEqual({ status: "none" });

    expect(vault.adapter.exists.mock.calls).toEqual([[STUDIO_LEGACY_PROJECTS_DIR]]);
    expect(vault.adapter.read).not.toHaveBeenCalled();
    expect(vault.adapter.write).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("formats sizes as a file manager does", () => {
    expect(formatStudioLegacyBytes(886_000_000)).toBe("886 MB");
    expect(formatStudioLegacyBytes(1_250_000_000)).toBe("1.3 GB");
    expect(formatStudioLegacyBytes(4_200)).toBe("4 KB");
  });
});
