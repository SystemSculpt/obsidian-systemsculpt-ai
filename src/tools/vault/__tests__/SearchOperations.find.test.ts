/**
 * @jest-environment node
 */
import { App, TFile, TFolder } from "obsidian";
import { SearchOperations } from "../tools/SearchOperations";
import {
  outputAsToolResult,
  safeOutboundVaultToolResult,
  toJsonValue,
} from "../../../chat/managed/WireConversation";

type FindResponse = {
  results: Array<Record<string, unknown>>;
  totalFound: number;
  truncated?: boolean;
  notice?: string;
};

const MTIME = Date.UTC(2026, 8, 24, 12, 0, 0);

function vault(paths: string[], exclusions: Record<string, unknown> = {}) {
  const files = paths.map((path) => new TFile({ path, stat: { ctime: MTIME, mtime: MTIME, size: 100 } }));
  const folders = new Map<string, TFolder>();
  const root = new TFolder({ path: "/" });
  const folderFor = (path: string): TFolder => {
    if (!path) return root;
    const existing = folders.get(path);
    if (existing) return existing;
    const folder = new TFolder({ path });
    folders.set(path, folder);
    folderFor(path.split("/").slice(0, -1).join("/")).children.push(folder);
    return folder;
  };
  for (const file of files) folderFor(file.path.split("/").slice(0, -1).join("/"));

  const app = new App();
  (app.vault.getFiles as jest.Mock).mockReturnValue(files);
  (app.vault.getRoot as jest.Mock).mockReturnValue(root);
  const plugin = {
    settings: {
      chatsDirectory: "SystemSculpt/Chats",
      savedChatsDirectory: "SystemSculpt/Saved Chats",
      embeddingsExclusions: {
        folders: [],
        patterns: [],
        ignoreChatHistory: true,
        respectObsidianExclusions: true,
        ...exclusions,
      },
    },
    app: { vault: { configDir: ".obsidian", getConfig: jest.fn(() => []) } },
  };
  return new SearchOperations(app, ["/"], plugin as any);
}

async function find(ops: SearchOperations, patterns: string[], maxResults?: number): Promise<FindResponse> {
  return await ops.findFiles({ patterns, ...(maxResults ? { maxResults } : {}) }) as FindResponse;
}

describe("find", () => {
  const paths = [
    "Marketing/Email/Campaign drafts/brand template.md",
    "Household/Golden Retriever/budget.md",
    "Archive/Old/budget-2019.md",
    "Notes/budget.md",
    "Notes/meeting notes.md",
    "Projects/Launch/plan.md",
  ];

  it("returns a clear empty answer when no name matches", async () => {
    const response = await find(vault(paths), ["zzqxv", "nonexistent"]);

    expect(response.results).toEqual([]);
    expect(response.totalFound).toBe(0);
    expect(response.notice).toContain('No file or folder names contain "zzqxv", "nonexistent".');
    expect(JSON.stringify(response).length).toBeLessThan(400);
  });

  it("returns only files and folders whose names contain a search term", async () => {
    const response = await find(vault(paths), ["budget"]);

    expect(response.results.map((result) => result.path).sort()).toEqual([
      "Archive/Old/budget-2019.md",
      "Household/Golden Retriever/budget.md",
      "Notes/budget.md",
    ]);
    expect(response.totalFound).toBe(3);
    expect(response.notice).toBeUndefined();
  });

  it("matches folders by name", async () => {
    const response = await find(vault(paths), ["launch"]);

    expect(response.results).toEqual([
      expect.objectContaining({ path: "Projects/Launch" }),
      expect.objectContaining({ path: "Projects/Launch/plan.md" }),
    ]);
  });

  it("ranks equal matches equally, with no vault-specific folder bonus or penalty", async () => {
    const response = await find(vault(paths), ["budget"]);
    const scores = new Map(response.results.map((result) => [result.path, result.score]));

    // "Golden" and "Household" contain "old"; "Archive/Old" is an archive folder.
    expect(scores.get("Household/Golden Retriever/budget.md")).toBe(scores.get("Notes/budget.md"));
    expect(scores.get("Archive/Old/budget-2019.md")).toBe(scores.get("Notes/budget.md"));

    const marketing = await find(vault(paths), ["template"]);
    expect(marketing.results).toEqual([
      expect.objectContaining({ path: "Marketing/Email/Campaign drafts/brand template.md" }),
    ]);
  });

  it("returns only path, score and modified time for each result", async () => {
    const response = await find(vault(paths), ["launch"]);

    expect(Object.keys(response).sort()).toEqual(["results", "totalFound"]);
    expect(response.results).toEqual([
      { path: "Projects/Launch", score: expect.any(Number) },
      { path: "Projects/Launch/plan.md", score: expect.any(Number), modified: new Date(MTIME).toISOString() },
    ]);
  });

  it("honors maxResults while reporting every match", async () => {
    const response = await find(vault(paths), ["budget"], 1);

    expect(response.results).toHaveLength(1);
    expect(response.totalFound).toBe(3);
  });

  it("skips files the user excluded with glob patterns", async () => {
    const response = await find(vault([...paths, "Daily/budget.md"], { patterns: ["Daily/**"] }), ["budget"]);

    expect(response.results.map((result) => result.path)).not.toContain("Daily/budget.md");
    expect(response.totalFound).toBe(3);
  });

  it("keeps the no-match notice intact through managed tool-result delivery", async () => {
    const response = await find(vault(paths), ["zzqxv"]);

    const outbound = safeOutboundVaultToolResult(outputAsToolResult(toJsonValue(response)));

    expect(outbound).toEqual({ success: true, data: response });
  });
});
