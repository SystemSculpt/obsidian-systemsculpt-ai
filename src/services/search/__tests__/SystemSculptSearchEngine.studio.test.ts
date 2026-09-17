import { App, TFile } from "obsidian";
import { SystemSculptSearchEngine } from "../SystemSculptSearchEngine";

const NOW = Date.now();
const project = (name: string, text: string) => JSON.stringify({
  schema: "studio.project.v2", id: "project-id", name,
  canvas: { nodes: [{ id: "node-id", kind: "text", config: { value: text } }] },
});

function fixture() {
  const app = new App();
  app.workspace.offref = jest.fn();
  const files: TFile[] = [];
  const contents = new Map<string, string>();
  const add = (path: string, text: string, mtime = NOW) => {
    const file = new TFile({ path, stat: { mtime, size: text.length } });
    files.push(file);
    contents.set(path, text);
    return file;
  };
  app.vault.getFiles.mockReturnValue(files);
  app.vault.getAbstractFileByPath.mockImplementation((path) => files.find((file) => file.path === path) ?? null);
  app.vault.cachedRead.mockImplementation(async (file) => contents.get(file.path) ?? "");
  const plugin = {
    app,
    settings: { embeddingsEnabled: false, embeddingsExclusions: { ignoreChatHistory: false, respectObsidianExclusions: false, folders: [] as string[] } },
  } as any;
  const engine = new SystemSculptSearchEngine(app, plugin);
  const emit = (event: string, file: TFile, oldPath?: string) => {
    const listener = app.vault.on.mock.calls.find(([name]) => name === event)?.[1];
    expect(listener).toBeDefined();
    listener(file, oldPath);
  };
  const update = (file: TFile, text: string, mtime: number) => {
    contents.set(file.path, text);
    file.stat.mtime = mtime;
    file.stat.size = text.length;
    emit("modify", file);
  };
  const linked = () => {
    const entry = add("Projects/Launch.systemsculpt", JSON.stringify({
      schema: "studio.entry.v1", id: "project-id", projection: "Launch.studio/views/graph.systemsculpt",
    }), NOW - 100_000);
    const projection = add("Projects/Launch.studio/views/graph.systemsculpt", project("Launch", "quartz brief"), NOW);
    return { entry, projection };
  };
  return { app, files, contents, add, engine, emit, update, linked, plugin };
}

describe("SystemSculpt search Studio projects", () => {
  it("finds Studio filenames on the first smart query and content after indexing", async () => {
    const { add, engine } = fixture();
    const file = add("Projects/Launch.systemsculpt", project("Release planning", "quartz brief"));
    try {
      expect((await engine.search("Launch")).results.map((hit) => hit.path)).toEqual([file.path]);
      await engine.whenIndexReady();
      const results = (await engine.search("quartz")).results;
      expect(results).toEqual([expect.objectContaining({ path: file.path, excerpt: expect.stringContaining("quartz brief") })]);
      expect((await engine.search("project-id", { mode: "lexical" })).results).toEqual([]);
    } finally { engine.destroy(); }
  });

  it("includes Studio in cold recents and applies its edit time to relevance ranking", async () => {
    const { add, engine, app } = fixture();
    const note = add("Notes/Launch.md", "Launch quartz", NOW - 90 * 86_400_000);
    const studio = add("Projects/Launch.systemsculpt", project("Launch", "quartz"));
    try {
      expect((await engine.getRecent(2)).map((hit) => hit.path)).toEqual([studio.path, note.path]);
      expect(app.vault.cachedRead.mock.calls.map(([file]) => file.path)).not.toContain(note.path);
      expect((await engine.search("Launch", { mode: "lexical" })).results[0].path).toBe(studio.path);
    } finally { engine.destroy(); }
  });

  it("ranks a linked Studio by its projection time and returns one public entry", async () => {
    const { linked, add, engine } = fixture();
    const { entry, projection } = linked();
    add("Notes/Recent.md", "quartz", NOW - 1000);
    add(".systemsculpt/studio/projects/id/generations/revision/project.systemsculpt", project("Backup", "quartz"), NOW + 1000);
    add("Projects/Launch.systemsculpt-assets/imports/copy.systemsculpt", project("Copy", "quartz"), NOW + 2000);
    try {
      expect(await engine.getRecent(1)).toEqual([expect.objectContaining({ path: entry.path, updatedAt: projection.stat.mtime })]);
      const preview = (await engine.getRecentPreviews([entry.path])).get(entry.path);
      expect(preview).toBe("Launch\nquartz brief");
      expect((await engine.search("quartz", { mode: "lexical" })).results.map((hit) => hit.path).sort()).toEqual(["Notes/Recent.md", entry.path].sort());
    } finally { engine.destroy(); }
  });

  it("refreshes linked content, previews and recency after a projection edit", async () => {
    const { linked, add, engine, update } = fixture();
    const { entry, projection } = linked();
    const note = add("Notes/Recent.md", "Other note", NOW + 1000);
    try {
      await engine.whenIndexReady();
      await engine.getRecentPreviews([entry.path]);
      expect((await engine.getRecent(1))[0].path).toBe(note.path);
      update(projection, project("Launch", "zephyr revisions"), NOW + 2000);
      expect(await engine.getRecent(1)).toEqual([expect.objectContaining({ path: entry.path, updatedAt: NOW + 2000, excerpt: "Launch\nzephyr revisions" })]);
      expect((await engine.getRecentPreviews([entry.path])).get(entry.path)).toBe("Launch\nzephyr revisions");
      expect((await engine.search("quartz", { mode: "lexical" })).results).toEqual([]);
      expect((await engine.search("zephyr", { mode: "lexical" })).results[0].path).toBe(entry.path);
    } finally { engine.destroy(); }
  });

  it("removes missing projection text and recovers when the source is recreated", async () => {
    const { linked, files, engine, emit } = fixture();
    const { entry, projection } = linked();
    try {
      await engine.whenIndexReady();
      files.splice(files.indexOf(projection), 1);
      emit("delete", projection);
      expect((await engine.search("quartz", { mode: "lexical" })).results).toEqual([]);
      expect((await engine.search("Launch", { mode: "lexical" })).results[0].path).toBe(entry.path);
      files.push(projection);
      emit("create", projection);
      expect((await engine.search("quartz", { mode: "lexical" })).results[0].path).toBe(entry.path);
    } finally { engine.destroy(); }
  });

  it("tracks Studio create, rename and delete events", async () => {
    const { add, files, engine, emit } = fixture();
    try {
      await engine.whenIndexReady();
      const file = add("Projects/Launch.systemsculpt", project("Launch", "quartz"));
      emit("create", file);
      expect((await engine.search("quartz", { mode: "lexical" })).results[0].path).toBe(file.path);
      files.splice(files.indexOf(file), 1);
      const renamed = add("Projects/Revised.systemsculpt", project("Launch", "quartz"));
      emit("rename", renamed, file.path);
      expect((await engine.search("quartz", { mode: "lexical" })).results.map((hit) => hit.path)).toEqual([renamed.path]);
      files.splice(files.indexOf(renamed), 1);
      emit("delete", renamed);
      expect(await engine.getRecent()).toEqual([]);
    } finally { engine.destroy(); }
  });

  it("retries Studio content invalidated during the initial read", async () => {
    const { linked, app, contents, engine, update } = fixture();
    const { entry, projection } = linked();
    let changed = false;
    app.vault.cachedRead.mockImplementation(async (file) => {
      const text = contents.get(file.path) ?? "";
      if (file.path === projection.path && !changed) {
        changed = true;
        update(projection, project("Launch", "zephyr revisions"), NOW + 2000);
      }
      return text;
    });
    try {
      await engine.whenIndexReady();
      expect((await engine.search("zephyr", { mode: "lexical" })).results[0].path).toBe(entry.path);
      expect((await engine.search("quartz", { mode: "lexical" })).results).toEqual([]);
    } finally { engine.destroy(); }
  });

  it("preserves recency ordering when Studio matches merge with semantic note hits", async () => {
    const { add, engine, plugin } = fixture();
    const old = add("Notes/Launch.md", "Launch", NOW - 1000);
    const studio = add("Projects/New Launch.systemsculpt", project("Launch", "Release"));
    plugin.settings.embeddingsEnabled = true;
    plugin.embeddingsManager = {
      isReady: () => true,
      hasAnyEmbeddings: () => true,
      getStats: () => ({ total: 1, processed: 1 }),
      searchSimilar: async () => [{ path: old.path, score: 1 }],
    };
    try {
      const response = await engine.search("Launch", { mode: "semantic", sort: "recency", limit: 2 });
      expect(response.stats.usedEmbeddings).toBe(true);
      expect(response.results.map((hit) => hit.path)).toEqual([studio.path, old.path]);
    } finally { engine.destroy(); }
  });

  it("respects exclusions for entries and their content sources", async () => {
    const { linked, add, engine, plugin } = fixture();
    const { entry } = linked();
    add("Private/Hidden.systemsculpt", project("Private", "quartz"));
    plugin.settings.embeddingsExclusions.folders = ["Private", "Projects/Launch.studio"];
    try {
      expect((await engine.getRecent()).map((hit) => hit.path)).toEqual([entry.path]);
      expect((await engine.search("quartz", { mode: "lexical" })).results).toEqual([]);
    } finally { engine.destroy(); }
  });

  it.each(["smart", "lexical"] as const)("sorts %s hits by recency before limiting results", async (mode) => {
    const { add, engine } = fixture();
    for (let i = 0; i < 350; i++) add(`Notes/Launch ${i}.md`, "Launch", NOW - 1000);
    const newest = add("Projects/New Launch.systemsculpt", project("New Launch", "Release"));
    try {
      expect((await engine.search("Launch", { mode, sort: "recency", limit: 1 })).results[0].path).toBe(newest.path);
    } finally { engine.destroy(); }
  });
});
