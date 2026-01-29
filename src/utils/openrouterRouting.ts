type OpenRouterModelEndpoint = {
  tag: string;
  provider_name?: string;
  supported_parameters?: string[];
  status?: number;
  supports_implicit_caching?: boolean;
};

type OpenRouterModelEndpointsResponse = {
  data?: {
    endpoints?: OpenRouterModelEndpoint[];
  };
};

const DEFAULT_ENDPOINT_CACHE_TTL_MS = 10 * 60 * 1000;

const endpointsCache = new Map<string, { fetchedAt: number; endpoints: OpenRouterModelEndpoint[] }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeOpenRouterModelId(modelId: string): string {
  const trimmed = String(modelId || "").trim();
  if (trimmed.startsWith("openrouter/")) return trimmed.slice("openrouter/".length);
  return trimmed;
}

function parseOpenRouterModelId(modelId: string): { author: string; slug: string } | null {
  const normalized = normalizeOpenRouterModelId(modelId);
  const [author, slug, ...rest] = normalized.split("/");
  if (!author || !slug || rest.length > 0) return null;
  return { author, slug };
}

export function normalizeOpenRouterApiBase(endpointOrChatUrl: string): string {
  const trimmed = String(endpointOrChatUrl || "").trim().replace(/\/$/, "");
  if (!trimmed) return "";

  const chatSuffix = "/chat/completions";
  if (trimmed.endsWith(chatSuffix)) {
    return trimmed.slice(0, -chatSuffix.length);
  }
  const modelsSuffix = "/models";
  if (trimmed.endsWith(modelsSuffix)) {
    return trimmed.slice(0, -modelsSuffix.length);
  }
  return trimmed;
}

async function fetchOpenRouterModelEndpoints(opts: {
  apiBase: string;
  apiKey: string;
  modelId: string;
  signal?: AbortSignal;
}): Promise<OpenRouterModelEndpoint[] | undefined> {
  const parsed = parseOpenRouterModelId(opts.modelId);
  if (!parsed) return undefined;

  const base = normalizeOpenRouterApiBase(opts.apiBase);
  if (!base) return undefined;

  const url = `${base}/models/${encodeURIComponent(parsed.author)}/${encodeURIComponent(parsed.slug)}/endpoints`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://systemsculpt.com",
      "X-Title": "SystemSculpt AI",
    },
    signal: opts.signal,
  });

  if (!response.ok) return undefined;

  const data = (await response.json().catch(() => ({}))) as OpenRouterModelEndpointsResponse;
  const endpoints = data?.data?.endpoints;
  return Array.isArray(endpoints) ? endpoints : undefined;
}

async function getOpenRouterModelEndpointsCached(opts: {
  apiBase: string;
  apiKey: string;
  modelId: string;
  ttlMs?: number;
  signal?: AbortSignal;
}): Promise<OpenRouterModelEndpoint[] | undefined> {
  const normalizedModelId = normalizeOpenRouterModelId(opts.modelId);
  const cacheKey = `${normalizeOpenRouterApiBase(opts.apiBase)}::${normalizedModelId}`;
  const now = Date.now();
  const ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_ENDPOINT_CACHE_TTL_MS;

  const cached = endpointsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < ttlMs) return cached.endpoints;

  const fresh = await fetchOpenRouterModelEndpoints({
    apiBase: opts.apiBase,
    apiKey: opts.apiKey,
    modelId: normalizedModelId,
    signal: opts.signal,
  });

  if (fresh && fresh.length > 0) {
    endpointsCache.set(cacheKey, { fetchedAt: now, endpoints: fresh });
    return fresh;
  }

  return cached?.endpoints;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (via shifts to keep in 32-bit)
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

function rendezvousOrder(key: string, tags: string[]): string[] {
  const unique = Array.from(new Set(tags));
  return unique
    .map((tag) => ({ tag, score: fnv1a32(`${key}:${tag}`) }))
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
    .map((x) => x.tag);
}

function buildStableOrderPreferCaching(opts: {
  tags: string[];
  cachingTags: string[];
  healthyTags?: string[];
  routingKey: string;
  modelId: string;
}): string[] {
  const key = `${opts.routingKey}:${opts.modelId}`;
  const orderedAll = rendezvousOrder(key, opts.tags);
  if (orderedAll.length <= 1) return orderedAll;

  const healthySet = new Set(opts.healthyTags ?? []);
  const orderedByHealth =
    opts.healthyTags && opts.healthyTags.length > 0
      ? [...orderedAll.filter((t) => healthySet.has(t)), ...orderedAll.filter((t) => !healthySet.has(t))]
      : orderedAll;

  const cachingSet = new Set(opts.cachingTags);
  const primary =
    orderedByHealth.find((t) => healthySet.has(t) && cachingSet.has(t)) ??
    orderedByHealth.find((t) => healthySet.has(t)) ??
    orderedByHealth.find((t) => cachingSet.has(t)) ??
    orderedByHealth[0];

  return [primary, ...orderedByHealth.filter((t) => t !== primary)];
}

export function findOpenRouterEndpointTagForProviderName(
  endpoints: OpenRouterModelEndpoint[],
  providerName: string | undefined
): string | undefined {
  const name = String(providerName || "").trim().toLowerCase();
  if (!name) return undefined;

  const match = endpoints.find((e) => {
    if (!e) return false;
    const pn = typeof e.provider_name === "string" ? e.provider_name.trim().toLowerCase() : "";
    const tag = typeof e.tag === "string" ? e.tag.trim().toLowerCase() : "";
    return pn === name || tag === name;
  });
  return typeof match?.tag === "string" && match.tag.trim().length > 0 ? match.tag.trim() : undefined;
}

export async function getOpenRouterProviderOrderForModel(opts: {
  apiBase: string;
  apiKey: string;
  modelId: string;
  hasTools: boolean;
  ttlMs?: number;
  signal?: AbortSignal;
}): Promise<{ order: string[]; endpoints: OpenRouterModelEndpoint[] } | null> {
  const endpoints = await getOpenRouterModelEndpointsCached({
    apiBase: opts.apiBase,
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    ttlMs: opts.ttlMs,
    signal: opts.signal,
  });

  if (!endpoints || endpoints.length === 0) return null;

  let candidates = endpoints.filter((e) => e && typeof e.tag === "string" && e.tag.trim().length > 0);
  // Include "degraded" endpoints (e.g. status -2) but exclude hard-down (-5).
  candidates = candidates.filter((e) => typeof e.status === "number" && e.status > -5);

  if (opts.hasTools) {
    candidates = candidates.filter(
      (e) => Array.isArray(e.supported_parameters) && (e.supported_parameters as string[]).includes("tools")
    );
  }

  const tags = candidates.map((e) => String(e.tag)).filter((t) => t.trim().length > 0);
  if (tags.length === 0) return null;

  const healthyTags = candidates.filter((e) => e.status === 0).map((e) => String(e.tag));
  const cachingTags = candidates
    .filter((e) => e.supports_implicit_caching === true)
    .map((e) => String(e.tag));

  const routingKey = fnv1a32(String(opts.apiKey || "")).toString(16);
  const order = buildStableOrderPreferCaching({
    tags,
    cachingTags,
    healthyTags,
    routingKey,
    modelId: normalizeOpenRouterModelId(opts.modelId),
  });

  return { order, endpoints: candidates };
}

export function isRetryableOpenRouterProviderError(status: number, errorData: unknown): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;

  if (status !== 400) return false;
  if (!isRecord(errorData)) return false;

  const error = isRecord(errorData.error) ? errorData.error : undefined;
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("provider returned error");
}
