import { App, TFile } from "obsidian";
import { SystemSculptSearchEngine } from "../SystemSculptSearchEngine";
import { SearchOperations } from "../../../tools/vault/tools/SearchOperations";

function fixture(contents: Record<string, string>) {
  const app = new App();
  const files = Object.entries(contents).map(([path, text], index) => new TFile({
    path, stat: { size: text.length, mtime: Date.now() - index * 1000, ctime: 1 },
  }));
  const handlers = new Map<string, (file: TFile, oldPath?: string) => void>();
  Object.assign(app.vault, {
    getFiles: jest.fn(() => files),
    getAbstractFileByPath: jest.fn((path: string) => files.find((file) => file.path === path) ?? null),
    cachedRead: jest.fn(async (file: TFile) => contents[file.path]),
    on: jest.fn((name: string, handler: (file: TFile, oldPath?: string) => void) => {
      handlers.set(name, handler);
      return { name };
    }),
    offref: jest.fn(),
  });
  const plugin = {
    app,
    settings: {
      embeddingsEnabled: false,
      embeddingsExclusions: { ignoreChatHistory: true, respectObsidianExclusions: false },
      chatsDirectory: "Chats",
    },
    getSearchEngine: () => engine,
  };
  const engine = new SystemSculptSearchEngine(app, plugin as never);
  return { app: app as App & { vault: { cachedRead: jest.Mock } }, files, contents, handlers, plugin, engine };
}

describe("shared search candidates", () => {
  let engine: SystemSculptSearchEngine | undefined;
  afterEach(() => engine?.destroy());

  it("reuses modal postings for literal substring OR queries without rereading nonmatches", async () => {
    const f = fixture({ "one.md": "A haystack", "two.md": "Unforgettable NEEDLEwork", "three.md": "beta" });
    engine = f.engine;
    await engine.startIndexing();
    f.app.vault.cachedRead.mockClear();
    expect(await engine.getContentCandidates(f.files, ["needle", "beta"])).toEqual(new Set(["two.md", "three.md"]));
    expect(f.app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("keeps incomplete raw coverage, nonindexed files and failed reads as direct-scan candidates", async () => {
    const f = fixture({
      "short.md": "absent",
      "properties.md": "---\nneedle: yes\n---\nabsent",
      "large.md": `${"x ".repeat(4000)}needle`,
      "canvas.canvas": '{"nodes":[],"needle":true}',
      "raw.txt": "needle",
      "failed.md": "needle",
    });
    engine = f.engine;
    f.app.vault.cachedRead.mockImplementation(async (file: TFile) => {
      if (file.path === "failed.md") throw new Error("unavailable");
      return f.contents[file.path];
    });
    expect(await engine.getContentCandidates(f.files, ["needle"])).toEqual(new Set([
      "properties.md", "large.md", "canvas.canvas", "raw.txt", "failed.md",
    ]));
  });

  it("does not interpret arbitrary regex, symbols or Unicode as a safe negative", async () => {
    const f = fixture({ "note.md": "café 🚀" });
    engine = f.engine;
    expect(await engine.getContentCandidates(f.files, null)).toBeNull();
    expect(await engine.getContentCandidates(f.files, ["🚀"])).toBeNull();
    expect(await engine.getContentCandidates(f.files, ["café"])).toBeNull();
  });

  it("builds only authorized scoped notes and still completes the modal index later", async () => {
    const f = fixture({ "allowed/a.md": "needle", "other/b.md": "needle" });
    engine = f.engine;
    await engine.getContentCandidates([f.files[0]], ["needle"]);
    expect(f.app.vault.cachedRead.mock.calls.map(([file]) => file.path)).toEqual(["allowed/a.md"]);
    await engine.startIndexing();
    const response = await engine.search("needle", { mode: "lexical" });
    expect(response.results.map((hit) => hit.path).sort()).toEqual(["allowed/a.md", "other/b.md"]);
  });

  it("refreshes changed postings and shares the searchable vault revision", async () => {
    const f = fixture({ "note.md": "absent" });
    engine = f.engine;
    await engine.getContentCandidates(f.files, ["needle"]);
    const revision = engine.getRevision();
    f.handlers.get("modify")!(new TFile({ path: "Chats/running.md" }));
    expect(engine.getRevision()).toBe(revision);
    f.contents["note.md"] = "needle";
    f.handlers.get("modify")!(f.files[0]);
    expect(engine.getRevision()).toBeGreaterThan(revision);
    expect(await engine.getContentCandidates(f.files, ["needle"])).toEqual(new Set(["note.md"]));
    f.app.vault.cachedRead.mockClear();
    await engine.getContentCandidates(f.files, ["needle"]);
    expect(f.app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("cancels candidate preparation before any authorized file is read", async () => {
    const f = fixture({ "note.md": "needle" });
    engine = f.engine;
    const controller = new AbortController();
    controller.abort();
    await expect(engine.getContentCandidates(f.files, ["needle"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("agent search confirms only shared candidates while retaining filename hits", async () => {
    const f = fixture({ "irrelevant.md": "haystack", "hit.md": "needle", "needle.md": "haystack" });
    engine = f.engine;
    await engine.startIndexing();
    f.app.vault.cachedRead.mockClear();
    const operations = new SearchOperations(f.app, ["/"], f.plugin as never);
    const result = await operations.grepVault({ patterns: ["needle"] }) as { results: Array<{ path: string }> };
    expect(result.results.map((hit) => hit.path).sort()).toEqual(["hit.md", "needle.md"]);
    expect(f.app.vault.cachedRead.mock.calls.map(([file]) => file.path).sort()).toEqual(["hit.md", "needle.md"]);
  });

  it("searches large old notes beyond the former file count and prefix cutoffs", async () => {
    const f = fixture(Object.fromEntries([
      ...Array.from({ length: 32 }, (_, i) => [`notes/${i}.md`, "needle"]),
      ["archive/old.md", `${"large note filler ".repeat(15000)}needle`],
    ]));
    engine = f.engine;
    const operations = new SearchOperations(f.app, ["/"], f.plugin as never);
    const snippets: string[] = [];
    const paths = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await operations.grepVault({ patterns: ["needle"], pageTokens: 4096, cursor }) as {
        results: Array<{ path: string }>;
        snippets: string[];
        page: { next_cursor: string | null };
      };
      for (const hit of response.results) paths.add(hit.path);
      snippets.push(...response.snippets);
      cursor = response.page.next_cursor ?? undefined;
    } while (cursor);
    expect(paths.size).toBe(33);
    expect(snippets.some((snippet) => snippet.startsWith("archive/old.md:") && snippet.includes("【needle】"))).toBe(true);
  });

  it("keeps content-only excerpts aligned after skipping frontmatter", async () => {
    const f = fixture({ "note.md": `---\nproperties: ${"x".repeat(500)}\n---\nstart needle finish` });
    engine = f.engine;
    const operations = new SearchOperations(f.app, ["/"], f.plugin as never);
    const result = await operations.grepVault({ patterns: ["needle"], searchIn: "content" }) as { snippets: string[] };
    expect(result.snippets).toEqual(["note.md:4  start 【needle】 finish"]);
  });
});
