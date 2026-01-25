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
      new TFile({ path: "notes/research.canvas", stat: { mtime: NOW - 1_500 } }),
      new TFile({ path: "notes/unrelated.md", stat: { mtime: NOW - 2_000 } }),
    ];

    const contents: Record<string, string> = {
      "notes/orange-juice.md": "Orange juice is delicious and bright. Fresh squeezed orange juice every day.",
      "notes/research.canvas": JSON.stringify({
        nodes: [
          { id: "n1", type: "text", text: "Canvas note: yellow submarine" },
          { id: "n2", type: "file", file: "notes/orange-juice.md" },
          { id: "n3", type: "group", label: "Fruit cluster" },
        ],
        edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "references" }],
      }),
      "notes/unrelated.md": "Nothing about fruit here. This sentence mentions nodes for a targeted test.",
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

  it("indexes .canvas text nodes and finds matches", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("yellow submarine", { mode: "lexical", limit: 10 });
    const paths = res.results.map((r) => r.path);

    expect(paths).toContain("notes/research.canvas");
  });

  it("does not index JSON keys from .canvas files", async () => {
    const { app } = buildFixture();
    const plugin = makePlugin(app);
    const engine = new SystemSculptSearchEngine(app as any, plugin);

    const res = await engine.search("nodes", { mode: "lexical", limit: 10 });

    expect(res.results.map((r) => r.path)).not.toContain("notes/research.canvas");
  });
});
