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
    const headers = this.buildContractHeaders(licenseKey, {
      idempotencyKey: this.buildIdempotencyKey("web-search"),
    });

    const body = JSON.stringify({
      query: params.query,
      max_results: params.maxResults,
    });

    return (await this.makeRequest(endpoint, headers, body, "POST")) as WebSearchResponse;
  }

  async fetch(params: { url: string; maxChars?: number }): Promise<WebFetchResponse> {
    const licenseKey = this.ensureLicense();
    const endpoint = `${WEBSITE_API_BASE_URL}/web/fetch`;
    const headers = this.buildContractHeaders(licenseKey);

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
    const parseErrorMessage = (errorData: unknown, status: number): string => {
      if (errorData && typeof errorData === "object") {
        const record = errorData as Record<string, unknown>;
        const direct = record.error;
        if (typeof direct === "string" && direct.trim().length > 0) return direct;
        if (direct && typeof direct === "object") {
          const nested = (direct as Record<string, unknown>).message;
          if (typeof nested === "string" && nested.trim().length > 0) return nested;
        }
        const message = record.message;
        if (typeof message === "string" && message.trim().length > 0) return message;
      }
      return `HTTP ${status}`;
    };

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
        throw new Error(parseErrorMessage(errorData, response.status || 500));
      }

      return response.json;
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
      });
    } catch {
      const fallback = await requestUrl({
        url: endpoint,
        method,
        headers,
        body: method === "POST" ? body : undefined,
        throw: false,
      });
      if ((fallback.status || 500) >= 400) {
        const errorData = fallback.json || {};
        throw new Error(parseErrorMessage(errorData, fallback.status || 500));
      }
      return fallback.json;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(parseErrorMessage(errorData, response.status));
    }

    return await response.json();
  }

  private buildContractHeaders(
    licenseKey: string,
    options?: { idempotencyKey?: string }
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey),
      "x-plugin-version": this.plugin.manifest?.version ?? "0.0.0",
    };

    const idempotencyKey = String(options?.idempotencyKey || "").trim();
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    return headers;
  }

  private buildIdempotencyKey(prefix: string): string {
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }
}
