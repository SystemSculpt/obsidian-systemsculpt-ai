import type SystemSculptPlugin from "../../main";
import type {
  ManagedWebFetchResponse,
  ManagedWebSearchResponse,
  WebSearchResult as ManagedWebSearchResult,
} from "../managed/ManagedProductIntegrationClient";

export type WebSearchResult = ManagedWebSearchResult;
export type WebSearchResponse = ManagedWebSearchResponse;
export type WebFetchResponse = ManagedWebFetchResponse;

export class WebResearchApiService {
  constructor(private readonly plugin: SystemSculptPlugin) {}

  async search(params: { query: string; maxResults?: number }): Promise<WebSearchResponse> {
    return this.plugin.getManagedProductIntegrationClient().webSearch({
      idempotencyKey: this.idempotencyKey("web-search"),
      prepare: () => ({ query: params.query, maxResults: params.maxResults }),
    });
  }

  async fetch(params: { url: string; maxChars?: number }): Promise<WebFetchResponse> {
    return this.plugin.getManagedProductIntegrationClient().webFetch({
      idempotencyKey: this.idempotencyKey("web-fetch"),
      prepare: () => ({ url: params.url, maxChars: params.maxChars }),
    });
  }

  private idempotencyKey(prefix: "web-search" | "web-fetch"): string {
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }
}
