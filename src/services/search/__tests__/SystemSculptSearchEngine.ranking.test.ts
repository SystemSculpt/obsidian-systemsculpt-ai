import { App, TFile } from "obsidian";
import { SystemSculptSearchEngine, type SearchHit } from "../SystemSculptSearchEngine";
import { generateVault, type GeneratedVault } from "./fixtures/generatedVault";

/**
 * Ranked results on a generated fixture vault, pinned by snapshot. The
 * snapshot was recorded before the index moved to integer postings, so it
 * proves the lean index ranks, scores and excerpts exactly as the original.
 */
const NOW = Date.UTC(2026, 9, 25, 12);
const LIMIT = 12;

const EXTRA_NOTES: Record<string, { text: string; mtime: number }> = {
  "notes/orange-juice.md": { text: "Orange juice is delicious and bright. Fresh squeezed orange juice every day.", mtime: NOW - 1_000 },
  "notes/fresh-orange.md": { text: "Orange harvest note with no juice details.", mtime: NOW - 100 },
  "notes/research.canvas": {
    text: JSON.stringify({
      nodes: [
        { id: "n1", type: "text", text: "Canvas note: yellow submarine" },
        { id: "n2", type: "file", file: "notes/orange-juice.md" },
        { id: "n3", type: "group", label: "Fruit cluster" },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "references" }],
    }),
    mtime: NOW - 1_500,
  },
  "notes/東京.md": { text: "これは東京の会議メモです。京都ではありません。", mtime: NOW - 3_000 },
  "notes/emoji-launch.md": { text: "Release mood 🚀 and notes for a symbol-only query.", mtime: NOW - 3_100 },
  "notes/cyrillic.md": { text: "Привет мир from the multilingual search fixture.", mtime: NOW - 3_200 },
  "notes/co-op.md": { text: "The co-op meeting is tomorrow. Bring the co-op budget.", mtime: NOW - 3_300 },
  "notes/long-intro.md": {
    text: `---\ntags: [long]\n---\n${"Filler words about nothing in particular. ".repeat(220)}The hidden needle phrase sits past the indexed window.`,
    mtime: NOW - 4_000,
  },
};

function buildVault(): GeneratedVault {
  return generateVault({ notes: 360, seed: 2026, now: NOW, medianChars: 1_800, extraNotes: EXTRA_NOTES });
}

function buildQueries(vault: GeneratedVault): string[] {
  const word = (rank: number) => vault.lexicon[rank];
  const typo = (value: string) => value.slice(0, 2) + value.slice(3);
  return [
    "the", "project", "orange juice", "fresh orange", "weekly review plan", "action items next steps",
    word(60), word(300), word(1_500), word(6_000), word(20_000),
    `${word(300)} ${word(1_500)}`, `${word(60)} ${word(300)} ${word(1_500)}`,
    typo(word(1_500)), typo(word(6_000)), "yelow submarine", "oranges",
    word(1_500).slice(0, 3), word(1_500).slice(0, 4),
    "p", "pr", "pro", "proj", "e", "fr", "zz", "a b",
    "co-op", "don't", "follow-up", "c++", "node.js", "q&a", `#${word(40)}`,
    "café", "über", "привет", "東京", "会議", "メモ", "🚀", "orange 🚀",
    "projects/alpha", "daily 2024", "archive", "gamma launch",
    "zzzz-not-a-note", "https", "example.com", "needle phrase", "filler words",
  ];
}

function makeEngine(vault: GeneratedVault, overrides: Map<string, string> = new Map()) {
  const app = new App();
  const files = vault.files;
  jest.spyOn(app.vault, "getFiles").mockImplementation(() => files);
  jest.spyOn(app.vault, "cachedRead").mockImplementation(async (file: TFile) => overrides.get(file.path) ?? vault.read(file));
  jest.spyOn(app.vault, "getAbstractFileByPath").mockImplementation((path: string) => files.find((file) => file.path === path) ?? null);
  const plugin = {
    app,
    settings: {
      embeddingsEnabled: false,
      embeddingsExclusions: { ignoreChatHistory: false, respectObsidianExclusions: false },
    },
    vaultFileCache: undefined,
  };
  const engine = new SystemSculptSearchEngine(app as never, plugin as never);
  const listener = (event: string) =>
    (app.vault.on as jest.Mock).mock.calls.find(([name]) => name === event)![1] as (...args: unknown[]) => void;
  return { app, engine, files, listener };
}

function rows(hits: SearchHit[]): string[] {
  return hits.map((hit, index) => `${index + 1}. ${hit.path} | ${hit.score} | ${hit.origin} | ${hit.excerpt ?? ""}`);
}

async function runQueries(engine: SystemSculptSearchEngine, queries: string[], sort: "relevance" | "recency" = "relevance") {
  const results: Record<string, string[]> = {};
  for (const query of queries) {
    const response = await engine.search(query, { mode: "lexical", sort, limit: LIMIT });
    results[query] = rows(response.results);
  }
  return results;
}

describe("SystemSculptSearchEngine ranking on a generated vault", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("ranks word queries by relevance", async () => {
    const vault = buildVault();
    const { engine } = makeEngine(vault);
    const results = await runQueries(engine, buildQueries(vault));
    engine.destroy();
    expect(results).toMatchSnapshot();
  });

  it("ranks word queries by recency", async () => {
    const vault = buildVault();
    const { engine } = makeEngine(vault);
    const queries = buildQueries(vault).filter((_, index) => index % 3 === 0);
    const results = await runQueries(engine, queries, "recency");
    engine.destroy();
    expect(results).toMatchSnapshot();
  });

  it("ranks after notes change, appear, disappear and move", async () => {
    const vault = buildVault();
    const overrides = new Map<string, string>();
    const { engine, files, listener } = makeEngine(vault, overrides);
    const queries = buildQueries(vault);
    await engine.search("warm", { mode: "lexical", limit: LIMIT });

    const word = (rank: number) => vault.lexicon[rank];
    const modified = [files[3], files[40], files[41]];
    overrides.set(modified[0].path, `Rewritten ${word(300)} note about orange juice and the co-op ${word(1_500)}.`);
    overrides.set(modified[1].path, "Short note: weekly review plan 🚀.");
    overrides.set(modified[2].path, "");
    for (const file of modified) listener("modify")(file);

    const created = new TFile({ path: "Inbox/New orange juice plan.md", stat: { mtime: NOW - 50, size: 60 } });
    overrides.set(created.path, `Fresh orange juice plan for the project ${word(60)}.`);
    files.push(created);
    listener("create")(created);

    const deleted = files[7];
    files.splice(7, 1);
    listener("delete")(deleted);

    const renamed = files[20];
    const oldPath = renamed.path;
    const text = vault.read(renamed);
    Object.assign(renamed, { path: `Archive/Moved ${renamed.name}`, basename: `Moved ${renamed.basename}` });
    overrides.set(renamed.path, text);
    listener("rename")(renamed, oldPath);

    const results = await runQueries(engine, queries);
    engine.destroy();
    expect(results).toMatchSnapshot();
  });

  it("ranks titles and paths before the content index is ready", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const vault = buildVault();
      const { engine } = makeEngine(vault);
      const results: Record<string, string[]> = {};
      for (const query of buildQueries(vault)) {
        const response = await engine.search(query, { mode: "smart", limit: LIMIT });
        expect(response.stats.metadataOnly).toBe(true);
        results[query] = rows(response.results);
      }
      engine.destroy();
      expect(results).toMatchSnapshot();
    } finally {
      jest.useRealTimers();
    }
  });

  it("lists recent notes with previews", async () => {
    const vault = buildVault();
    const { engine } = makeEngine(vault);
    const cold = rows(await engine.getRecent(25));
    await engine.search("warm", { mode: "lexical", limit: LIMIT });
    const warm = rows(await engine.getRecent(25));
    engine.destroy();
    expect({ cold, warm }).toMatchSnapshot();
  });
});
