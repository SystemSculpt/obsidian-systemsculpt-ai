import { GITHUB_API } from "../constants/externalServices";
import type SystemSculptPlugin from "../main";
import type { StorageManager } from "../core/storage/StorageManager";

export interface ChangeLogEntry {
  version: string;
  date: string;
  notes: string;
  url: string;
}

const GITHUB_OWNER = "SystemSculpt";
const GITHUB_REPO = "obsidian-systemsculpt-ai";

type ChangeLogCacheFile = {
  schemaVersion: 1;
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
  rateLimitedUntil?: number;
  entries: ChangeLogEntry[];
};

const CACHE_FILE_NAME = "changelog-github-releases.v1.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let memoryCache: ChangeLogCacheFile | null = null;
let inFlightFetch: Promise<ChangeLogEntry[]> | null = null;

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function toIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatReleaseDate(iso: string | undefined): string {
  if (!iso) return new Date().toLocaleDateString();
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return new Date().toLocaleDateString();
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function normalizeVersion(raw: unknown): string {
  if (typeof raw !== "string") return "Unknown";
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("v") && trimmed.length > 1 && /\d/.test(trimmed[1])) {
    return trimmed.slice(1);
  }
  return trimmed;
}

function isValidCacheFile(value: unknown): value is ChangeLogCacheFile {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<ChangeLogCacheFile>;
  if (cache.schemaVersion !== 1) return false;
  if (typeof cache.fetchedAt !== "number") return false;
  if (!Array.isArray(cache.entries)) return false;
  return true;
}

function rateLimitRetryMs(err: any): number {
  const headers = (err?.headers || err?.response?.headers || {}) as Record<string, string> | undefined;
  const resetRaw = getHeader(headers, "x-ratelimit-reset");
  const remainingRaw = getHeader(headers, "x-ratelimit-remaining");
  const status = typeof err?.status === "number" ? err.status : undefined;
  const remaining = remainingRaw ? Number.parseInt(remainingRaw, 10) : NaN;
  const resetSeconds = resetRaw ? Number.parseInt(resetRaw, 10) : NaN;
  const isPrimaryLimit =
    status === 403
    && Number.isFinite(remaining)
    && remaining <= 0
    && Number.isFinite(resetSeconds)
    && resetSeconds > 0;
  if (!isPrimaryLimit) return 0;
  const retryAtMs = resetSeconds * 1000;
  return Math.max(0, retryAtMs - Date.now());
}

function buildFallbackEntry(message: string): ChangeLogEntry[] {
  return [
    {
      version: "Unavailable",
      date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
      notes: message,
      url: ChangeLogService.getReleasesPageUrl(),
    },
  ];
}

export class ChangeLogService {
  static getReleasesPageUrl(): string {
    return GITHUB_API.RELEASE_URL(GITHUB_OWNER, GITHUB_REPO);
  }

  static async warmCache(plugin: Pick<SystemSculptPlugin, "storage">): Promise<void> {
    try {
      await ChangeLogService.getReleases(plugin, { forceRefresh: false, allowStale: true });
    } catch {
      // Best effort only
    }
  }

  static async getReleases(
    plugin: Pick<SystemSculptPlugin, "storage">,
    options: { forceRefresh?: boolean; allowStale?: boolean } = {}
  ): Promise<ChangeLogEntry[]> {
    if (!plugin?.storage) {
      return buildFallbackEntry("Changelog unavailable: storage not initialized.");
    }

    const now = Date.now();
    const forceRefresh = options.forceRefresh ?? false;
    const allowStale = options.allowStale ?? true;

    const storage = plugin.storage as unknown as Pick<StorageManager, "readFile" | "writeFile">;

    const cacheFromDisk = await storage.readFile<ChangeLogCacheFile>("cache", CACHE_FILE_NAME, true);
    const diskCache = isValidCacheFile(cacheFromDisk) ? cacheFromDisk : null;
    if (diskCache) memoryCache = diskCache;

    const cache = memoryCache;

    const isFresh = !!(cache && now - cache.fetchedAt < CACHE_TTL_MS);
    const isRateLimited = !!(cache?.rateLimitedUntil && now < cache.rateLimitedUntil);

    if (!forceRefresh) {
      if (cache?.entries?.length && (isFresh || isRateLimited)) {
        return cache.entries;
      }
    }

    // Deduplicate concurrent loads (especially from settings + modal).
    if (inFlightFetch && !forceRefresh) {
      return await inFlightFetch;
    }

    const fetchPromise = (async (): Promise<ChangeLogEntry[]> => {
      const apiUrl = `${GITHUB_API.RELEASES(GITHUB_OWNER, GITHUB_REPO)}?per_page=100`;

      try {
        const headers: Record<string, string> = {
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (!forceRefresh && cache?.etag) {
          headers["If-None-Match"] = cache.etag;
        } else if (!forceRefresh && cache?.lastModified) {
          headers["If-Modified-Since"] = cache.lastModified;
        }

        const { httpRequest } = await import("../utils/httpClient");
        const response = await httpRequest({
          url: apiUrl,
          method: "GET",
          headers,
          timeoutMs: 15_000,
        });

        // 304 = not modified; reuse cached entries but extend freshness.
        if (response.status === 304) {
          if (cache?.entries?.length) {
            const updated: ChangeLogCacheFile = {
              ...cache,
              fetchedAt: now,
              rateLimitedUntil: undefined,
            };
            memoryCache = updated;
            await storage.writeFile("cache", CACHE_FILE_NAME, updated);
            return updated.entries;
          }
          // No cached data to reuse; treat as a transient failure.
          return buildFallbackEntry("Changelog temporarily unavailable (no cached copy).");
        }

        if (response.status !== 200) {
          if (allowStale && cache?.entries?.length) return cache.entries;
          return buildFallbackEntry("Changelog temporarily unavailable due to a network error.");
        }

        const list = Array.isArray(response.json) ? (response.json as any[]) : [];
        const entries: ChangeLogEntry[] = list
          .filter((r) => r && typeof r === "object" && !r.draft)
          .map((r) => {
            const publishedAt = toIsoOrUndefined(r.published_at) ?? toIsoOrUndefined(r.created_at);
            return {
              version: normalizeVersion(r.tag_name),
              date: formatReleaseDate(publishedAt),
              notes: (typeof r.body === "string" && r.body.trim().length > 0) ? r.body : "No release notes provided.",
              url: typeof r.html_url === "string" ? r.html_url : ChangeLogService.getReleasesPageUrl(),
            };
          })
          .filter((entry) => entry.version !== "Unknown");

        const etag = getHeader(response.headers, "etag");
        const lastModified = getHeader(response.headers, "last-modified");
        const nextCache: ChangeLogCacheFile = {
          schemaVersion: 1,
          fetchedAt: now,
          etag,
          lastModified,
          entries,
        };

        memoryCache = nextCache;
        await storage.writeFile("cache", CACHE_FILE_NAME, nextCache);
        return entries;
      } catch (error: any) {
        const retryInMs = rateLimitRetryMs(error);
        if (retryInMs > 0) {
          const until = Date.now() + retryInMs;
          if (memoryCache) {
            memoryCache = { ...memoryCache, rateLimitedUntil: until };
            await storage.writeFile("cache", CACHE_FILE_NAME, memoryCache);
          }

          if (allowStale && cache?.entries?.length) {
            return cache.entries;
          }

          const retryAt = new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
          return buildFallbackEntry(`Changelog temporarily unavailable due to GitHub API rate limiting. Try again after ${retryAt}.`);
        }

        if (allowStale && cache?.entries?.length) {
          return cache.entries;
        }

        const message = error?.message ? String(error.message) : "";
        if (message.toLowerCase().includes("timed out")) {
          return buildFallbackEntry("Changelog temporarily unavailable (request timed out).");
        }
        return buildFallbackEntry("Changelog temporarily unavailable due to a network error.");
      } finally {
        if (inFlightFetch === fetchPromise) {
          inFlightFetch = null;
        }
      }
    })();

    inFlightFetch = fetchPromise;
    return await fetchPromise;
  }

  static findIndexByVersion(entries: ChangeLogEntry[], version: string | undefined): number {
    if (!version) return 0;
    const candidates = [version, version.startsWith('v') ? version.substring(1) : `v${version}`];
    const index = entries.findIndex((e) => candidates.includes(e.version));
    return index >= 0 ? index : 0;
  }
}

export { GITHUB_OWNER, GITHUB_REPO };
