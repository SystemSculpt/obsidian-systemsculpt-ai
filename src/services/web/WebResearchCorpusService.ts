import { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { WebFetchResponse, WebSearchResult } from "./WebResearchApiService";

type SearchRunParams = {
  chatId: string;
  query: string;
  results: WebSearchResult[];
  fetched: Array<{ result: WebSearchResult; fetch: WebFetchResponse }>;
};

type FetchRunParams = {
  chatId: string;
  url: string;
  fetch: WebFetchResponse;
};

type SearchRunOutput = {
  runDir: string;
  indexPath: string;
  fetchedFiles: Array<{
    url: string;
    title: string | null;
    filePath: string;
  }>;
};

type FetchRunOutput = {
  runDir: string;
  indexPath: string;
  filePath: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toUtcDateParts(date: Date): { day: string; time: string } {
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const min = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return {
    day: `${yyyy}-${mm}-${dd}`,
    time: `${hh}${min}${ss}Z`,
  };
}

function slugify(value: string, maxLen: number = 60): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "untitled";
  const slug = raw
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "untitled").slice(0, maxLen);
}

function sanitizeFileName(value: string, maxLen: number = 120): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "untitled";
  const cleaned = raw
    .replace(/[\\/:*?\"<>|]/g, "-")
    .replace(/\\s+/g, " ")
    .trim();
  return (cleaned || "untitled").slice(0, maxLen);
}

function buildFrontmatter(meta: Record<string, any>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) continue;
    if (typeof value === "string") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    try {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } catch {
      lines.push(`${key}: ${JSON.stringify(String(value))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

async function upsertFile(app: App, path: string, content: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  await app.vault.create(path, content);
}

export class WebResearchCorpusService {
  private app: App;
  private plugin: SystemSculptPlugin;

  constructor(plugin: SystemSculptPlugin) {
    this.app = plugin.app;
    this.plugin = plugin;
  }

  private getBaseDir(): string {
    return (this.plugin.settings.webResearchDirectory || "SystemSculpt/Web Research").trim() || "SystemSculpt/Web Research";
  }

  private async ensureDir(path: string): Promise<void> {
    // DirectoryManager is preferred because it handles nested creation well.
    if ((this.plugin as any).directoryManager?.ensureDirectoryByPath) {
      await (this.plugin as any).directoryManager.ensureDirectoryByPath(path);
      return;
    }
    // Fallback: try creating folder directly.
    try {
      await this.app.vault.createFolder(path);
    } catch {
      /* folder may already exist */
    }
  }

  private async createRunDir(chatId: string, slugBase: string): Promise<{ runDir: string; dayDir: string; timeSlug: string }> {
    const base = this.getBaseDir();
    const now = new Date();
    const { day, time } = toUtcDateParts(now);
    const safeChatId = sanitizeFileName(chatId, 80);
    const slug = slugify(slugBase, 60);
    const timeSlug = `${time}--${slug}`;
    const dayDir = `${base}/${safeChatId}/${day}`;
    const runDir = `${dayDir}/${timeSlug}`;

    await this.ensureDir(base);
    await this.ensureDir(`${base}/${safeChatId}`);
    await this.ensureDir(dayDir);
    await this.ensureDir(runDir);
    await this.ensureDir(`${runDir}/fetch`);

    return { runDir, dayDir, timeSlug };
  }

  async writeSearchRun(params: SearchRunParams): Promise<SearchRunOutput> {
    const { runDir } = await this.createRunDir(params.chatId, params.query);

    const requestPath = `${runDir}/request.json`;
    const resultsPath = `${runDir}/results.json`;
    const indexPath = `${runDir}/index.md`;

    await upsertFile(this.app, requestPath, JSON.stringify({
      type: "web_search",
      query: params.query,
      createdAt: new Date().toISOString(),
    }, null, 2));

    await upsertFile(this.app, resultsPath, JSON.stringify({
      query: params.query,
      results: params.results,
    }, null, 2));

    const fetchedFiles: SearchRunOutput["fetchedFiles"] = [];
    for (let i = 0; i < params.fetched.length; i += 1) {
      const entry = params.fetched[i];
      const index = pad2(i + 1);

      let domain = "source";
      try {
        domain = new URL(entry.fetch.finalUrl || entry.fetch.url).hostname || domain;
      } catch {}

      const titleOrUrl = entry.fetch.title || entry.fetch.finalUrl || entry.fetch.url || entry.result.title || entry.result.url;
      const fileName = `${index} - ${sanitizeFileName(domain, 40)} - ${sanitizeFileName(titleOrUrl, 80)}.md`;
      const filePath = `${runDir}/fetch/${fileName}`;

      const frontmatter = buildFrontmatter({
        url: entry.fetch.url,
        final_url: entry.fetch.finalUrl,
        title: entry.fetch.title,
        fetched_at: entry.fetch.fetchedAt,
        content_type: entry.fetch.contentType,
        truncated: entry.fetch.truncated,
      });

      const body = `${frontmatter}\n\n${entry.fetch.markdown || ""}\n`;
      await upsertFile(this.app, filePath, body);

      fetchedFiles.push({
        url: entry.fetch.finalUrl || entry.fetch.url,
        title: entry.fetch.title,
        filePath,
      });
    }

    // Index: sources + links only (no summary)
    const lines: string[] = [];
    lines.push(`# Web Research`);
    lines.push(``);
    lines.push(`- Query: ${params.query}`);
    lines.push(`- Created: ${new Date().toISOString()}`);
    lines.push(``);
    lines.push(`## Results`);
    lines.push(``);

    for (const result of params.results) {
      const url = result.url;
      const title = result.title || url;
      const fetched = fetchedFiles.find((f) => f.url === url) || fetchedFiles.find((f) => f.url === result.url);
      if (fetched) {
        lines.push(`- [[${fetched.filePath}|${title}]] (${url})`);
      } else {
        lines.push(`- ${title} (${url})`);
      }
      if (result.snippet) {
        lines.push(`  - ${result.snippet}`);
      }
    }

    await upsertFile(this.app, indexPath, lines.join("\n") + "\n");

    return { runDir, indexPath, fetchedFiles };
  }

  async writeFetchRun(params: FetchRunParams): Promise<FetchRunOutput> {
    const { runDir } = await this.createRunDir(params.chatId, `fetch ${params.url}`);
    const requestPath = `${runDir}/request.json`;
    const indexPath = `${runDir}/index.md`;

    await upsertFile(this.app, requestPath, JSON.stringify({
      type: "web_fetch",
      url: params.url,
      createdAt: new Date().toISOString(),
    }, null, 2));

    let domain = "source";
    try {
      domain = new URL(params.fetch.finalUrl || params.fetch.url).hostname || domain;
    } catch {}

    const titleOrUrl = params.fetch.title || params.fetch.finalUrl || params.fetch.url;
    const fileName = `01 - ${sanitizeFileName(domain, 40)} - ${sanitizeFileName(titleOrUrl, 80)}.md`;
    const filePath = `${runDir}/fetch/${fileName}`;

    const frontmatter = buildFrontmatter({
      url: params.fetch.url,
      final_url: params.fetch.finalUrl,
      title: params.fetch.title,
      fetched_at: params.fetch.fetchedAt,
      content_type: params.fetch.contentType,
      truncated: params.fetch.truncated,
    });

    await upsertFile(this.app, filePath, `${frontmatter}\n\n${params.fetch.markdown || ""}\n`);

    const lines: string[] = [];
    lines.push(`# Web Fetch`);
    lines.push(``);
    lines.push(`- URL: ${params.url}`);
    lines.push(`- Created: ${new Date().toISOString()}`);
    lines.push(``);
    lines.push(`## Source`);
    lines.push(``);
    lines.push(`- [[${filePath}|${params.fetch.title || params.url}]] (${params.fetch.finalUrl || params.fetch.url})`);
    lines.push(``);

    await upsertFile(this.app, indexPath, lines.join("\n") + "\n");

    return { runDir, indexPath, filePath };
  }
}
