import { GITHUB_API } from "../constants/externalServices";
import { API_BASE_URL, SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";

export interface ChangeLogEntry {
  version: string;
  date: string;
  notes: string;
  url: string;
}

const GITHUB_OWNER = "SystemSculpt";
const GITHUB_REPO = "obsidian-systemsculpt-ai";
const GITHUB_RELEASES_URL = GITHUB_API.RELEASES(GITHUB_OWNER, GITHUB_REPO);

let cachedReleases: ChangeLogEntry[] | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30 * 60 * 1000;

function parseLinkHeader(header: string | null): { [key: string]: string } {
  if (!header) return {};
  const links: { [key: string]: string } = {};
  const parts = header.split(',');
  parts.forEach((part) => {
    const section = part.split(';');
    if (section.length < 2) return;
    const url = section[0].replace(/<(.*)>/, '$1').trim();
    const name = section[1].replace(/rel="(.*)"/, '$1').trim();
    links[name] = url;
  });
  return links;
}

export class ChangeLogService {
  static getReleasesPageUrl(): string {
    return GITHUB_API.RELEASE_URL(GITHUB_OWNER, GITHUB_REPO);
  }

  static async getReleases(forceRefresh = false): Promise<ChangeLogEntry[]> {
    const now = Date.now();
    if (!forceRefresh && cachedReleases && now - lastFetchTime < CACHE_DURATION) {
      return cachedReleases;
    }

    let allReleases: ChangeLogEntry[] = [];
    const apiUrl = `${API_BASE_URL}${SYSTEMSCULPT_API_ENDPOINTS.PLUGINS.RELEASES('systemsculpt-ai')}?limit=50`;

    try {
      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({ url: apiUrl, method: 'GET' });
      if (response.status === 200) {
        const list = (response.json?.data || []) as any[];
        const entries = list.map((r) => ({
          version: r.version,
          date: r.date ? new Date(r.date).toLocaleDateString() : new Date().toLocaleDateString(),
          notes: r.notes || "No release notes provided.",
          url: r.url || ChangeLogService.getReleasesPageUrl(),
        }));
        allReleases = entries;
      } else {
        if (cachedReleases) return cachedReleases;
        return [
          {
            version: "Unavailable",
            date: new Date().toLocaleDateString(),
            notes: "Changelog unavailable due to a network error.",
            url: ChangeLogService.getReleasesPageUrl(),
          },
        ];
      }

      cachedReleases = allReleases;
      lastFetchTime = now;
      return allReleases;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (cachedReleases) return cachedReleases;
      return [
        {
          version: "Unavailable",
          date: new Date().toLocaleDateString(),
          notes: "Changelog unavailable due to a network error.",
          url: ChangeLogService.getReleasesPageUrl(),
        },
      ];
    }
  }

  static findIndexByVersion(entries: ChangeLogEntry[], version: string | undefined): number {
    if (!version) return 0;
    const candidates = [version, version.startsWith('v') ? version.substring(1) : `v${version}`];
    const index = entries.findIndex((e) => candidates.includes(e.version));
    return index >= 0 ? index : 0;
  }
}

export { GITHUB_OWNER, GITHUB_REPO };

