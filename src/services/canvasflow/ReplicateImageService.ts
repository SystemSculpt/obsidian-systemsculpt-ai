import { Platform, requestUrl } from "obsidian";
import { PlatformContext } from "../PlatformContext";

export interface ReplicateModelSearchResult {
  slug: string; // owner/name
  owner: string;
  name: string;
  description?: string;
  coverImageUrl?: string;
  tags?: string[];
}

export interface ReplicateModelDetails {
  slug: string;
  latestVersionId: string;
}

export type ReplicatePredictionStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export interface ReplicatePrediction {
  id: string;
  status: ReplicatePredictionStatus;
  error?: string | null;
  output?: unknown;
  urls?: { get?: string; cancel?: string } | null;
  metrics?: Record<string, unknown> | null;
  completed_at?: string | null;
  created_at?: string | null;
  started_at?: string | null;
}

type JsonRequestOptions = {
  method: "GET" | "POST" | "QUERY";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

type ArrayBufferRequestOptions = {
  method: "GET";
  headers?: Record<string, string>;
  timeoutMs?: number;
};

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

function safeJsonParse(text: string | undefined): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelSlug(slug: string): { owner: string; name: string } | null {
  const trimmed = String(slug || "").trim();
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

function preferredTransport(url: string): "fetch" | "requestUrl" {
  try {
    return PlatformContext.get().preferredTransport({ endpoint: url });
  } catch {
    // If platform detection explodes (shouldn't), prefer requestUrl for reliability.
    return "requestUrl";
  }
}

function assertOk(status: number, body: any, fallbackMessage: string): void {
  if (status >= 200 && status < 300) {
    return;
  }

  const message =
    typeof body?.detail === "string"
      ? body.detail
      : typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : fallbackMessage;
  const err: any = new Error(message);
  err.status = status;
  err.data = body;
  throw err;
}

function normalizeModelSearchResult(raw: unknown): ReplicateModelSearchResult | null {
  if (!raw) return null;
  const outer = isRecord(raw) ? raw : null;

  // `/search` returns `{ metadata, model }`, while legacy endpoints return model objects directly.
  const maybeModel = outer && isRecord(outer.model) ? (outer.model as Record<string, unknown>) : outer;
  const maybeMetadata = outer && isRecord(outer.metadata) ? (outer.metadata as Record<string, unknown>) : null;

  const owner = String((maybeModel as any)?.owner || (maybeModel as any)?.github_owner || (maybeModel as any)?.username || "").trim();
  const name = String((maybeModel as any)?.name || (maybeModel as any)?.model_name || "").trim();
  const slug = owner && name ? `${owner}/${name}` : String((maybeModel as any)?.slug || "").trim();
  if (!slug || !parseModelSlug(slug)) return null;
  const { owner: parsedOwner, name: parsedName } = parseModelSlug(slug)!;

  const coverImageUrl =
    typeof (maybeModel as any)?.cover_image_url === "string"
      ? String((maybeModel as any).cover_image_url)
      : typeof (maybeModel as any)?.avatar_url === "string"
        ? String((maybeModel as any).avatar_url)
        : undefined;

  const description =
    typeof (maybeModel as any)?.description === "string"
      ? String((maybeModel as any).description)
      : typeof maybeMetadata?.generated_description === "string"
        ? String(maybeMetadata.generated_description)
        : undefined;

  const tagsRaw = maybeMetadata?.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map((t) => String(t || "").trim()).filter(Boolean) : undefined;

  return {
    slug,
    owner: parsedOwner,
    name: parsedName,
    description,
    coverImageUrl,
    tags,
  } satisfies ReplicateModelSearchResult;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, Math.floor(ms));
  if (!delayMs) return;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ReplicateImageService {
  constructor(private readonly apiKey: string) {}

  private authHeaders(): Record<string, string> {
    const key = String(this.apiKey || "").trim();
    if (!key) return {};
    return { Authorization: `Bearer ${key}` };
  }

  private async requestJson(url: string, options: JsonRequestOptions): Promise<{ status: number; json: any; headers: Record<string, string> }> {
    const headers: Record<string, string> = { ...this.authHeaders(), ...(options.headers || {}) };
    const method = options.method;

    const tryFetch = async (): Promise<{ status: number; json: any; headers: Record<string, string> }> => {
      const res = await fetch(url, {
        method,
        headers: {
          ...headers,
          ...(options.body && !("Content-Type" in headers) ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body,
      } as RequestInit);
      const text = await res.text();
      const json = safeJsonParse(text) ?? text;
      const headersOut: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersOut[key.toLowerCase()] = value;
      });
      assertOk(res.status, json, `Replicate request failed: HTTP ${res.status}`);
      return { status: res.status, json, headers: headersOut };
    };

    const viaRequestUrl = async (): Promise<{ status: number; json: any; headers: Record<string, string> }> => {
      const response = await requestUrl({
        url,
        method,
        headers,
        body: options.body,
        throw: false,
      });
      const status = response.status || 0;
      const body = response.json ?? safeJsonParse(response.text) ?? response.text ?? null;
      const headersOut: Record<string, string> = {};
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") {
            headersOut[key.toLowerCase()] = value;
          }
        }
      }
      assertOk(status, body, `Replicate request failed: HTTP ${status || 0}`);
      return { status, json: body, headers: headersOut };
    };

    // Prefer requestUrl on mobile. On desktop, prefer PlatformContext, but always fall back to requestUrl.
    const preferred = Platform.isMobileApp ? "requestUrl" : preferredTransport(url);
    if (preferred === "fetch") {
      try {
        return await tryFetch();
      } catch {
        return await viaRequestUrl();
      }
    }
    return await viaRequestUrl();
  }

  private async requestArrayBuffer(
    url: string,
    options: ArrayBufferRequestOptions
  ): Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> {
    const headers: Record<string, string> = { ...this.authHeaders(), ...(options.headers || {}) };
    const method = options.method;

    const tryFetch = async (): Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> => {
      const res = await fetch(url, { method, headers } as RequestInit);
      const buf = await res.arrayBuffer();
      const headersOut: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersOut[key.toLowerCase()] = value;
      });
      if (!res.ok) {
        const err: any = new Error(`Download failed: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return { status: res.status, arrayBuffer: buf, headers: headersOut };
    };

    const viaRequestUrl = async (): Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> => {
      const response = await requestUrl({
        url,
        method,
        headers,
        throw: false,
      });
      const status = response.status || 0;
      if (status < 200 || status >= 300) {
        const err: any = new Error(`Download failed: HTTP ${status || 0}`);
        err.status = status;
        throw err;
      }
      const headersOut: Record<string, string> = {};
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") {
            headersOut[key.toLowerCase()] = value;
          }
        }
      }
      const buf = response.arrayBuffer;
      if (buf && buf instanceof ArrayBuffer) {
        return { status, arrayBuffer: buf, headers: headersOut };
      }
      // Some requestUrl builds may provide `text` only; attempt a best-effort decode.
      if (typeof response.text === "string") {
        const encoded = new TextEncoder().encode(response.text);
        return { status, arrayBuffer: encoded.buffer, headers: headersOut };
      }
      throw new Error("Download failed: empty response body");
    };

    const preferred = Platform.isMobileApp ? "requestUrl" : preferredTransport(url);
    if (preferred === "fetch") {
      try {
        return await tryFetch();
      } catch {
        return await viaRequestUrl();
      }
    }
    return await viaRequestUrl();
  }

  async listModelsPage(options?: {
    url?: string;
    sortBy?: "model_created_at" | "latest_version_created_at";
    sortDirection?: "asc" | "desc";
  }): Promise<{ results: ReplicateModelSearchResult[]; next: string | null; previous: string | null }> {
    const url =
      typeof options?.url === "string" && options.url.trim()
        ? options.url.trim()
        : `${REPLICATE_API_BASE}/models?sort_by=${encodeURIComponent(options?.sortBy || "latest_version_created_at")}&sort_direction=${encodeURIComponent(
            options?.sortDirection || "desc"
          )}`;
    const { json } = await this.requestJson(url, { method: "GET" });
    const resultsRaw = Array.isArray(json?.results) ? (json.results as unknown[]) : [];
    const results = resultsRaw.map(normalizeModelSearchResult).filter(Boolean) as ReplicateModelSearchResult[];
    const next = typeof json?.next === "string" && json.next.trim() ? json.next.trim() : null;
    const previous = typeof json?.previous === "string" && json.previous.trim() ? json.previous.trim() : null;
    return { results, next, previous };
  }

  async searchModels(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<ReplicateModelSearchResult[]> {
    const q = String(query || "").trim();
    if (q.length < 2) return [];
    const limit = Math.min(50, Math.max(1, Math.floor(options?.limit ?? 20)));

    // Prefer the newer search endpoint (beta). Fall back to legacy QUERY /models if unavailable.
    try {
      const url = `${REPLICATE_API_BASE}/search?query=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`;
      const { json } = await this.requestJson(url, { method: "GET" });
      const modelsRaw = Array.isArray(json?.models) ? (json.models as unknown[]) : [];
      return modelsRaw.map(normalizeModelSearchResult).filter(Boolean).slice(0, limit) as ReplicateModelSearchResult[];
    } catch {
      // Ignore and try legacy endpoint.
    }

    // Legacy QUERY search endpoint (https://replicate.com/docs/reference/http#models.query)
    const { json } = await this.requestJson(`${REPLICATE_API_BASE}/models`, {
      method: "QUERY",
      headers: { "Content-Type": "text/plain" },
      body: q,
    });

    const results = Array.isArray(json?.results) ? (json.results as any[]) : [];
    return results
      .map(normalizeModelSearchResult)
      .filter(Boolean)
      .slice(0, limit) as ReplicateModelSearchResult[];
  }

  async resolveLatestVersion(modelSlug: string): Promise<ReplicateModelDetails> {
    const parsed = parseModelSlug(modelSlug);
    if (!parsed) {
      throw new Error(`Invalid Replicate model slug: ${modelSlug}`);
    }
    const url = `${REPLICATE_API_BASE}/models/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
    const { json } = await this.requestJson(url, { method: "GET" });
    const latestVersionId = String(json?.latest_version?.id || "").trim();
    if (!latestVersionId) {
      throw new Error("Replicate model response did not include latest_version.id");
    }
    return { slug: `${parsed.owner}/${parsed.name}`, latestVersionId };
  }

  async createPrediction(options: { version: string; input: Record<string, unknown> }): Promise<ReplicatePrediction> {
    const url = `${REPLICATE_API_BASE}/predictions`;
    const { json } = await this.requestJson(url, {
      method: "POST",
      body: JSON.stringify({
        version: options.version,
        input: options.input,
      }),
    });
    return json as ReplicatePrediction;
  }

  async getPrediction(predictionId: string): Promise<ReplicatePrediction> {
    const id = String(predictionId || "").trim();
    if (!id) throw new Error("Missing prediction id");
    const url = `${REPLICATE_API_BASE}/predictions/${encodeURIComponent(id)}`;
    const { json } = await this.requestJson(url, { method: "GET" });
    return json as ReplicatePrediction;
  }

  async waitForPrediction(
    predictionId: string,
    options?: {
      pollIntervalMs?: number;
      signal?: AbortSignal;
      onUpdate?: (prediction: ReplicatePrediction) => void;
    }
  ): Promise<ReplicatePrediction> {
    const pollMs = Math.max(250, Math.floor(options?.pollIntervalMs ?? 1000));
    const signal = options?.signal;

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const prediction = await this.getPrediction(predictionId);
      options?.onUpdate?.(prediction);

      if (prediction.status === "succeeded") {
        return prediction;
      }
      if (prediction.status === "failed" || prediction.status === "canceled") {
        const message =
          typeof prediction.error === "string" && prediction.error.trim()
            ? prediction.error.trim()
            : `Replicate prediction ${prediction.status}`;
        throw new Error(message);
      }

      await sleep(pollMs, signal);
    }
  }

  async downloadOutput(url: string): Promise<{ arrayBuffer: ArrayBuffer; contentType?: string }> {
    const target = String(url || "").trim();
    if (!target) {
      throw new Error("Missing output URL");
    }

    const { arrayBuffer, headers } = await this.requestArrayBuffer(target, { method: "GET" });
    const contentType = typeof headers["content-type"] === "string" ? headers["content-type"] : undefined;
    return { arrayBuffer, contentType };
  }
}
