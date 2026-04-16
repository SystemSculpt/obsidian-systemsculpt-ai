import { SystemSculptSearchEngine } from "../SystemSculptSearchEngine";
import { App, TFile } from "obsidian";

const makePlugin = (app: App) =>
  ({
    app,
    settings: {
      embeddingsEnabled: false,
      embeddingsExclusions: {
        ignoreChatHistory: false,
        respectObsidianExclusions: false,
      },
    },
    vaultFileCache: undefined,
  } as any);

describe("SystemSculptSearchEngine lexical mode", () => {
  const NOW = Date.now();

  const buildFixture = () => {
    const app = new App();
    const files = [
      new TFile({ path: "notes/orange-juice.md", stat: { mtime: NOW - 1_000 } }),
      new TFile({ path: "notes/fresh-orange.md", stat: { mtime: NOW - 100 } }),
      new TFile({ path: "notes/research.canvas", stat: { mtime: NOW - 1_500 } }),
      new TFile({ path: "notes/unrelated.md", stat: { mtime: NOW - 2_000 } }),
      new TFile({ path: "notes/東京.md", stat: { mtime: NOW - 3_000 } }),
      new TFile({ path: "notes/emoji-launch.md", stat: { mtime: NOW - 3_100 } }),
      new TFile({ path: "notes/cyrillic.md", stat: { mtime: NOW - 3_200 } }),
    ];

    const contents: Record<string, string> = {
      "notes/orange-juice.md": "Orange juice is delicious and bright. Fresh squeezed orange juice every day.",
      "notes/fresh-orange.md": "Orange harvest note with no juice details.",
      "notes/research.canvas": JSON.stringify({
        nodes: [
          { id: "n1", type: "text", text: "Canvas note: yellow submarine" },
          { id: "n2", type: "file", file: "notes/orange-juice.md" },
          { id: "n3", type: "group", label: "Fruit cluster" },
        ],
        edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "references" }],
      }),
      "notes/unrelated.md": "Nothing about fruit here. This sentence mentions nodes for a targeted test.",
      "notes/東京.md": "これは東京の会議メモです。京都ではありません。",
      "notes/emoji-launch.md": "Release mood 🚀 and notes for a symbol-only query.",
      "notes/cyrillic.md": "Привет мир from the multilingual search fixture.",
    };

    app.vault.getFiles.mockReturnValue(files);
    // @ts-expect-error mock injected for tests
    app.vault.cachedRead = jest.fn((file) => Promise.resolve(contents[file.path] ?? ""));
    app.vault.read.mockImplementation(app.vault.cachedRead);
    app.vault.getAbstractFileByPath.mockImplementation((p) => files.find((f) => f.path === p) ?? null);

    return { app, files };
  };

  it("returns matches in Fast (lexical) mode for body content", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("orange juice", { mode: "lexical", limit: 10 });
    const paths = res.results.map((r) => r.path);

    expect(paths).toContain("notes/orange-juice.md");
    expect(res.stats.usedEmbeddings).toBe(false);
  });

  it("returns recent files without building the content index", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const recents = await engine.getRecent(10);

    expect(recents.map((r) => r.path)).toContain("notes/fresh-orange.md");
    expect(app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("returns only the requested number of recent files", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const recents = await engine.getRecent(2);

    expect(recents.map((r) => r.path)).toEqual(["notes/fresh-orange.md", "notes/orange-juice.md"]);
    expect(app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("hydrates previews only for requested recent paths", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const previews = await engine.getRecentPreviews(["notes/fresh-orange.md"]);

    expect(app.vault.cachedRead).toHaveBeenCalledTimes(1);
    expect(previews.get("notes/fresh-orange.md")).toContain("Orange harvest note");
  });

  it("caches recent previews by path, mtime, and size", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    await engine.getRecentPreviews(["notes/fresh-orange.md"]);
    await engine.getRecentPreviews(["notes/fresh-orange.md"]);

    expect(app.vault.cachedRead).toHaveBeenCalledTimes(1);
  });

  it("returns metadata hits for the first smart query without reading note bodies", async () => {
    jest.useFakeTimers();
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("fresh", { mode: "smart", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/fresh-orange.md");
    expect(res.stats.metadataOnly).toBe(true);
    expect(res.stats.indexingPending).toBe(true);
    expect(app.vault.cachedRead).not.toHaveBeenCalled();

    engine.destroy();
    jest.useRealTimers();
  });

  it("does not return unrelated recent notes for no-match lexical queries", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("zzzz-not-a-note", { mode: "lexical", limit: 10 });

    expect(res.results).toEqual([]);
  });

  it("clears the content index when search-affecting settings change", async () => {
    jest.useFakeTimers();
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    await engine.search("orange", { mode: "lexical", limit: 10 });
    expect(app.vault.cachedRead).toHaveBeenCalled();

    const settingsListener = (app.workspace.on as jest.Mock).mock.calls.find(([event]) => event === "systemsculpt:settings-updated")?.[1];
    expect(settingsListener).toBeDefined();
    settingsListener();

    (app.vault.cachedRead as jest.Mock).mockClear();
    const res = await engine.search("fresh", { mode: "smart", limit: 10 });

    expect(res.stats.metadataOnly).toBe(true);
    expect(app.vault.cachedRead).not.toHaveBeenCalled();

    engine.destroy();
    jest.useRealTimers();
  });

  it("does not mutate the cached vault file array when selecting recents", async () => {
    const { app, files } = buildFixture();
    const plugin = makePlugin(app);
    plugin.vaultFileCache = {
      getAllFilesView: jest.fn(() => files),
    };
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    await engine.getRecent(2);

    expect(files.map((file) => file.path)).toEqual([
      "notes/orange-juice.md",
      "notes/fresh-orange.md",
      "notes/research.canvas",
      "notes/unrelated.md",
      "notes/東京.md",
      "notes/emoji-launch.md",
      "notes/cyrillic.md",
    ]);
  });

  it("reuses the eligible file snapshot across metadata searches", async () => {
    jest.useFakeTimers();
    const { app, files } = buildFixture();
    const plugin = makePlugin(app);
    const getAllFilesView = jest.fn(() => files);
    plugin.vaultFileCache = { getAllFilesView };
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    await engine.search("fresh", { mode: "smart", limit: 10 });
    await engine.search("orange", { mode: "smart", limit: 10 });

    expect(getAllFilesView).toHaveBeenCalledTimes(1);

    engine.destroy();
    jest.useRealTimers();
  });

  it("reuses cached title and path tokens across metadata searches", async () => {
    jest.useFakeTimers();
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);
    const tokenizeSpy = jest.spyOn(engine as any, "tokenizeSearchText");

    await engine.search("fresh", { mode: "smart", limit: 10 });
    const firstSearchTokenizations = tokenizeSpy.mock.calls.length;
    await engine.search("orange", { mode: "smart", limit: 10 });

    expect(tokenizeSpy).toHaveBeenCalledTimes(firstSearchTokenizations);

    engine.destroy();
    jest.useRealTimers();
  });

  it("bootstraps the embeddings manager on smart searches so lazy autostart still runs semantic retrieval", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    plugin.settings.embeddingsEnabled = true;
    const getOrCreateEmbeddingsManager = jest.fn(() => {
      plugin.embeddingsManager = {
        searchSimilar: jest.fn(() => Promise.resolve([])),
        isReady: () => true,
        hasAnyEmbeddings: () => false,
        getStats: () => ({ total: 0, processed: 0, present: 0, needsProcessing: 0 }),
      };
      return plugin.embeddingsManager;
    });
    plugin.getOrCreateEmbeddingsManager = getOrCreateEmbeddingsManager;

    const engine = new SystemSculptSearchEngine(app as any, plugin);

    // First warm the full content index via a lexical search so smart mode
    // bypasses the metadata fast path (which never reaches the embeddings
    // bootstrap) and runs the full search path where the bug lives.
    await engine.search("orange", { mode: "lexical", limit: 10 });
    await engine.search("orange", { mode: "smart", limit: 10 });
    expect(getOrCreateEmbeddingsManager).toHaveBeenCalled();
  });

  it("refreshes dirty index entries before serving recents so modified notes get fresh previews", async () => {
    const { app, files } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const target = files.find((f) => f.path === "notes/orange-juice.md")!;

    // Warm the full content index so indexed.preview is populated.
    await engine.search("orange", { mode: "lexical", limit: 10 });

    const initial = await engine.getRecent(10);
    const initialExcerpt = initial.find((r) => r.path === target.path)?.excerpt ?? "";
    expect(initialExcerpt.toLowerCase()).toContain("orange");

    // Simulate an external edit: update the mocked content and fire modify.
    (app.vault.cachedRead as jest.Mock).mockImplementation((file: any) => {
      if (file.path === target.path) {
        return Promise.resolve("Totally new body text about automation checklists.");
      }
      // Defer to the original fixture mapping for other files.
      const defaults: Record<string, string> = {
        "notes/fresh-orange.md": "Orange harvest note with no juice details.",
        "notes/research.canvas": "",
        "notes/unrelated.md": "Nothing about fruit here.",
        "notes/東京.md": "これは東京の会議メモです。京都ではありません。",
        "notes/emoji-launch.md": "Release mood 🚀 and notes for a symbol-only query.",
        "notes/cyrillic.md": "Привет мир from the multilingual search fixture.",
      };
      return Promise.resolve(defaults[file.path] ?? "");
    });

    const modifyListener = (app.vault.on as jest.Mock).mock.calls.find(([event]) => event === "modify")?.[1];
    expect(modifyListener).toBeDefined();
    modifyListener(target);

    const refreshed = await engine.getRecent(10);
    const refreshedExcerpt = refreshed.find((r) => r.path === target.path)?.excerpt ?? "";
    expect(refreshedExcerpt.toLowerCase()).toContain("automation");
    expect(refreshedExcerpt.toLowerCase()).not.toContain("orange juice");
  });

  it("drops cached recents when userIgnoreFilters change between empty-query loads", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;
    let ignoreFilters: string[] = [];
    (app.vault as any).getConfig = jest.fn((key: string) => (key === "userIgnoreFilters" ? ignoreFilters : null));

    const engine = new SystemSculptSearchEngine(app as any, plugin);

    // First empty-query load populates the recent-hits cache via getRecent.
    const before = await engine.getRecent(10);
    expect(before.map((r) => r.path)).toContain("notes/orange-juice.md");

    // User edits Obsidian's "Excluded files". Without eligibility refresh in
    // getRecent, the cached recents would still include the excluded note
    // until a non-empty search or vault event invalidates the cache.
    ignoreFilters = ["orange-juice"];

    const after = await engine.getRecent(10);
    expect(after.map((r) => r.path)).not.toContain("notes/orange-juice.md");
    expect(after.map((r) => r.path)).toContain("notes/fresh-orange.md");
  });

  it("invalidates the eligible file snapshot when userIgnoreFilters change", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;
    let ignoreFilters: string[] = [];
    (app.vault as any).getConfig = jest.fn((key: string) => (key === "userIgnoreFilters" ? ignoreFilters : null));

    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const before = await engine.search("orange", { mode: "lexical", limit: 10 });
    expect(before.results.map((r) => r.path)).toContain("notes/orange-juice.md");

    ignoreFilters = ["orange-juice"];

    const after = await engine.search("orange", { mode: "lexical", limit: 10 });
    expect(after.results.map((r) => r.path)).not.toContain("notes/orange-juice.md");
  });

  it("keeps detecting further userIgnoreFilters changes after the first prune", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;
    let ignoreFilters: string[] = [];
    (app.vault as any).getConfig = jest.fn((key: string) => (key === "userIgnoreFilters" ? ignoreFilters : null));

    const engine = new SystemSculptSearchEngine(app as any, plugin);

    await engine.search("orange", { mode: "lexical", limit: 10 });

    ignoreFilters = ["orange-juice"];
    const afterFirst = await engine.search("orange", { mode: "lexical", limit: 10 });
    expect(afterFirst.results.map((r) => r.path)).not.toContain("notes/orange-juice.md");
    expect(afterFirst.results.map((r) => r.path)).toContain("notes/fresh-orange.md");

    ignoreFilters = ["fresh-orange"];
    const afterSecond = await engine.search("orange", { mode: "lexical", limit: 10 });
    expect(afterSecond.results.map((r) => r.path)).not.toContain("notes/fresh-orange.md");
    // Removing the previous filter should let orange-juice.md become searchable again.
    expect(afterSecond.results.map((r) => r.path)).toContain("notes/orange-juice.md");
  });

  it("invalidates the eligible file snapshot when files are created", async () => {
    jest.useFakeTimers();
    const { app, files } = buildFixture();
    const plugin = makePlugin(app);
    const getAllFilesView = jest.fn(() => files);
    plugin.vaultFileCache = { getAllFilesView };
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    await engine.search("fresh", { mode: "smart", limit: 10 });
    const createListener = (app.vault.on as jest.Mock).mock.calls.find(([event]) => event === "create")?.[1];
    expect(createListener).toBeDefined();
    createListener(new TFile({ path: "notes/new.md", stat: { mtime: NOW } }));
    await engine.search("orange", { mode: "smart", limit: 10 });

    expect(getAllFilesView).toHaveBeenCalledTimes(2);

    engine.destroy();
    jest.useRealTimers();
  });

  it("refreshes eligibility on the smart metadata fast path so in-flight indexes can't go stale", async () => {
    jest.useFakeTimers();
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;
    let ignoreFilters: string[] = [];
    (app.vault as any).getConfig = jest.fn((key: string) => (key === "userIgnoreFilters" ? ignoreFilters : null));

    const engine = new SystemSculptSearchEngine(app as any, plugin);
    const clearSpy = jest.spyOn(engine as any, "clearIndexes");

    // First smart search while the content index isn't ready yet → metadata fast path.
    // Fake timers keep the scheduled background indexing from running.
    const first = await engine.search("orange", { mode: "smart", limit: 10 });
    expect(first.stats.metadataOnly).toBe(true);
    expect(clearSpy).not.toHaveBeenCalled();

    // Simulate the user editing Obsidian's "Excluded files" between searches.
    ignoreFilters = ["orange-juice"];

    // Second smart search, still cold → metadata fast path again. Without the
    // refresh-before-metadata call, the signature would be updated silently and
    // a later lexical pass would reuse the stale (pre-filter) content index.
    const second = await engine.search("orange", { mode: "smart", limit: 10 });
    expect(second.stats.metadataOnly).toBe(true);
    expect(second.results.map((r) => r.path)).not.toContain("notes/orange-juice.md");
    expect(clearSpy).toHaveBeenCalledTimes(1);

    engine.destroy();
    jest.useRealTimers();
  });

  it("prefers full term coverage over recent one-term matches", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("orange juice", { mode: "lexical", limit: 10 });

    expect(res.results[0]?.path).toBe("notes/orange-juice.md");
  });

  it("indexes .canvas text nodes and finds matches", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("yellow submarine", { mode: "lexical", limit: 10 });
    const paths = res.results.map((r) => r.path);

    expect(paths).toContain("notes/research.canvas");
  });

  it("uses fuzzy token candidates for minor query typos", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("yelow submarine", { mode: "lexical", limit: 10 });

    expect(res.results[0]?.path).toBe("notes/research.canvas");
  });

  it("matches longer query terms against shorter indexed tokens", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("oranges", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/fresh-orange.md");
  });

  it("uses shorter title tokens for longer metadata queries before the content index is ready", async () => {
    jest.useFakeTimers();
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("oranges", { mode: "smart", limit: 10 });

    expect(res.stats.metadataOnly).toBe(true);
    expect(res.results.map((r) => r.path)).toContain("notes/fresh-orange.md");

    engine.destroy();
    jest.useRealTimers();
  });

  it("finds CJK body matches after the content index is ready", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("東京", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/東京.md");
  });

  it("finds Cyrillic body matches with Unicode tokens", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("привет", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/cyrillic.md");
  });

  it("finds symbol-only body matches through substring fallback", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("🚀", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/emoji-launch.md");
  });

  it("falls back to substring matching for 2-character prefix queries after indexing", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    // Warm the full content index so subsequent searches use the token path.
    await engine.search("orange", { mode: "lexical", limit: 10 });

    // "fr" is ASCII and tokenizable at length 2, but prefix expansion starts
    // at length 3 — without the short-term substring fallback, fresh-* notes
    // would disappear once the content index is ready.
    const res = await engine.search("fr", { mode: "lexical", limit: 10 });
    const paths = res.results.map((r) => r.path);
    expect(paths).toContain("notes/fresh-orange.md");
    expect(paths).toContain("notes/orange-juice.md");
  });

  it("falls back to substring matching for punctuated query terms after indexing", async () => {
    // Purpose-built fixture: the punctuated query "co-op" has no prefix of
    // length >= 3 that exists as an indexed token ("co-o" and "co-" never
    // survive the tokenizer), and "co"/"op" alone are below the 3-char
    // prefix-expansion floor. Without the substring fallback trigger for
    // punctuated terms, the note drops out of results entirely after the
    // content index is ready.
    const app = new App();
    const files = [
      new TFile({ path: "notes/co-op.md", stat: { mtime: NOW - 500 } }),
      new TFile({ path: "notes/unrelated.md", stat: { mtime: NOW - 2_000 } }),
    ];
    const contents: Record<string, string> = {
      "notes/co-op.md": "The co-op meeting is tomorrow.",
      "notes/unrelated.md": "Nothing relevant here.",
    };
    app.vault.getFiles.mockReturnValue(files);
    // @ts-expect-error mock injected for tests
    app.vault.cachedRead = jest.fn((file) => Promise.resolve(contents[file.path] ?? ""));
    app.vault.read.mockImplementation(app.vault.cachedRead);
    app.vault.getAbstractFileByPath.mockImplementation((p) => files.find((f) => f.path === p) ?? null);

    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    // Warm the full content index so the next search uses the token path.
    await engine.search("co", { mode: "lexical", limit: 10 });

    const res = await engine.search("co-op", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/co-op.md");
  });

  it("scores non-tokenizable terms in mixed queries so emoji-only docs still hit", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    // "orange" doesn't appear in emoji-launch.md at all; "🚀" has no tokenized
    // form and the phrase "orange 🚀" never appears verbatim. The doc should
    // still be returned because the non-tokenizable term matches its body.
    const res = await engine.search("orange 🚀", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).toContain("notes/emoji-launch.md");
  });

  it("finds non-ASCII metadata matches before reading note bodies", async () => {
    jest.useFakeTimers();
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("東京", { mode: "smart", limit: 10 });

    expect(res.stats.metadataOnly).toBe(true);
    expect(res.results.map((r) => r.path)).toContain("notes/東京.md");
    expect(app.vault.cachedRead).not.toHaveBeenCalled();

    engine.destroy();
    jest.useRealTimers();
  });

  it("does not index JSON keys from .canvas files", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("nodes", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).not.toContain("notes/research.canvas");
  });
});
