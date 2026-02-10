import { requestUrl } from "obsidian";
import { PlatformContext } from "../PlatformContext";
import type SystemSculptPlugin from "../../main";
import { SYSTEMSCULPT_API_HEADERS, WEBSITE_API_BASE_URL } from "../../constants/api";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResponse = {
  query: string;
  results: WebSearchResult[];
  fetchedAt: string;
};

export type WebFetchResponse = {
  url: string;
  finalUrl: string;
  title: string | null;
  markdown: string;
  contentType: string | null;
  fetchedAt: string;
  truncated: boolean;
};

export class WebResearchApiService {
  private plugin: SystemSculptPlugin;
  private platform: PlatformContext;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.platform = PlatformContext.get();
  }

  private ensureLicense(): string {
    const key = this.plugin.settings.licenseKey;
    if (!key || !this.plugin.settings.licenseValid) {
      throw new Error("A valid SystemSculpt license is required to use web research.");
    }
    return key;
  }

  async search(params: { query: string; maxResults?: number }): Promise<WebSearchResponse> {
    const licenseKey = this.ensureLicense();
    const endpoint = `${WEBSITE_API_BASE_URL}/web/search`;
    const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey);

    const body = JSON.stringify({
      query: params.query,
      max_results: params.maxResults,
    });

    return (await this.makeRequest(endpoint, headers, body, "POST")) as WebSearchResponse;
  }

  async fetch(params: { url: string; maxChars?: number }): Promise<WebFetchResponse> {
    const licenseKey = this.ensureLicense();
    const endpoint = `${WEBSITE_API_BASE_URL}/web/fetch`;
    const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey);

    const body = JSON.stringify({
      url: params.url,
      max_chars: params.maxChars,
    });

    return (await this.makeRequest(endpoint, headers, body, "POST")) as WebFetchResponse;
  }

  private async makeRequest(
    endpoint: string,
    headers: Record<string, string>,
    body?: string,
    method: "GET" | "POST" = "POST"
  ): Promise<any> {
    const preferredTransport = this.platform.preferredTransport({ endpoint });

    if (preferredTransport === "requestUrl") {
      const response = await requestUrl({
        url: endpoint,
        method,
        headers,
        body: method === "POST" ? body : undefined,
        throw: false,
      });

      if ((response.status || 500) >= 400) {
        const errorData = response.json || {};
        throw new Error((errorData as any).error || `HTTP ${response.status}`);
      }

      return response.json;
    }

    const response = await fetch(endpoint, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error((errorData as any).error || `HTTP ${response.status}`);
    }

    return await response.json();
  }
}

