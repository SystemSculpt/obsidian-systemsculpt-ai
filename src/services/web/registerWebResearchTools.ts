import type SystemSculptPlugin from "../../main";
import type { ToolCallManager } from "../../views/chatview/ToolCallManager";
import type { ChatView } from "../../views/chatview/ChatView";
import { WebResearchApiService, type WebSearchResult, type WebFetchResponse } from "./WebResearchApiService";
import { WebResearchCorpusService } from "./WebResearchCorpusService";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const text = String(markdown ?? "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[... truncated ...]`;
}

export function registerWebResearchTools(params: {
  toolCallManager: ToolCallManager;
  plugin: SystemSculptPlugin;
  chatView: ChatView;
}): void {
  const { toolCallManager, plugin, chatView } = params;
  const api = new WebResearchApiService(plugin);
  const corpus = new WebResearchCorpusService(plugin);

  toolCallManager.registerTool(
    {
      name: "web_search",
      description:
        "Search the web for a query (Brave) and optionally fetch the top results. Saves a corpus under the Web Research directory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "integer", description: "Maximum results to return (1-10)", default: 5, minimum: 1, maximum: 10 },
          fetch_top_n: { type: "integer", description: "Fetch top N results (0-5)", default: 2, minimum: 0, maximum: 5 },
          fetch_max_chars: { type: "integer", description: "Max chars per fetched excerpt returned to the model", default: 4000, minimum: 200, maximum: 12000 },
        },
        required: ["query"],
      },
    },
    async (args: any) => {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("web_search.query is required");

      const maxResults = clampInt(args?.max_results, 5, 1, 10);
      const fetchTopN = clampInt(args?.fetch_top_n, 2, 0, 5);
      const fetchMaxChars = clampInt(args?.fetch_max_chars, 4000, 200, 12000);

      const search = await api.search({ query, maxResults });
      const results: WebSearchResult[] = Array.isArray(search?.results) ? search.results.slice(0, maxResults) : [];

      const toFetch = fetchTopN > 0 ? results.slice(0, fetchTopN) : [];
      const fetched: Array<{ result: WebSearchResult; fetch: WebFetchResponse }> = [];

      for (const result of toFetch) {
        const fetch = await api.fetch({ url: result.url, maxChars: 120_000 });
        fetched.push({ result, fetch });
      }

      const chatId = String((chatView as any)?.chatId ?? "").trim() || `chat_${Date.now()}`;
      const corpusRun = await corpus.writeSearchRun({
        chatId,
        query,
        results,
        fetched,
      });

      return {
        query,
        corpusIndexPath: corpusRun.indexPath,
        results,
        fetched: fetched.map((entry) => ({
          url: entry.fetch.finalUrl || entry.fetch.url,
          title: entry.fetch.title,
          excerpt: excerptMarkdown(entry.fetch.markdown || "", fetchMaxChars),
        })),
      };
    }
  );

  toolCallManager.registerTool(
    {
      name: "web_fetch",
      description:
        "Fetch a URL and extract its main content as markdown. Saves a corpus under the Web Research directory.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          max_chars: { type: "integer", description: "Max chars to store for the fetched page", default: 120000, minimum: 1, maximum: 200000 },
          excerpt_max_chars: { type: "integer", description: "Max chars returned to the model", default: 4000, minimum: 200, maximum: 12000 },
        },
        required: ["url"],
      },
    },
    async (args: any) => {
      const url = String(args?.url ?? "").trim();
      if (!url) throw new Error("web_fetch.url is required");

      const maxChars = clampInt(args?.max_chars, 120_000, 1, 200_000);
      const excerptMaxChars = clampInt(args?.excerpt_max_chars, 4000, 200, 12000);

      const fetch = await api.fetch({ url, maxChars });

      const chatId = String((chatView as any)?.chatId ?? "").trim() || `chat_${Date.now()}`;
      const corpusRun = await corpus.writeFetchRun({
        chatId,
        url,
        fetch,
      });

      return {
        url: fetch.finalUrl || fetch.url,
        title: fetch.title,
        corpusIndexPath: corpusRun.indexPath,
        excerpt: excerptMarkdown(fetch.markdown || "", excerptMaxChars),
      };
    }
  );
}

