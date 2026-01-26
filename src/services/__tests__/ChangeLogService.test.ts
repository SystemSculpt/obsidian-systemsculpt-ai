/**
 * @jest-environment node
 */

// Mock dependencies BEFORE imports
jest.mock("../../constants/externalServices", () => ({
  GITHUB_API: {
    RELEASES: (owner: string, repo: string) => `https://api.github.com/repos/${owner}/${repo}/releases`,
    RELEASE_URL: (owner: string, repo: string) => `https://github.com/${owner}/${repo}/releases`,
  },
}));

// Store mock reference
const mockHttpRequest = jest.fn();

jest.mock("../../utils/httpClient", () => ({
  httpRequest: mockHttpRequest,
}));

describe("ChangeLogService", () => {
  // Reimport module fresh for each test to reset module-level cache
  let ChangeLogService: any;
  let ChangeLogEntry: any;
  let GITHUB_OWNER: string;
  let GITHUB_REPO: string;
  let mockPlugin: any;
  let mockStorage: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Re-mock httpClient after resetModules
    jest.doMock("../../utils/httpClient", () => ({
      httpRequest: mockHttpRequest,
    }));
    mockStorage = {
      readFile: jest.fn().mockResolvedValue(null),
      writeFile: jest.fn().mockResolvedValue({ success: true }),
    };
    mockPlugin = { storage: mockStorage };
    // Reimport the module to get fresh cache
    const module = require("../ChangeLogService");
    ChangeLogService = module.ChangeLogService;
    GITHUB_OWNER = module.GITHUB_OWNER;
    GITHUB_REPO = module.GITHUB_REPO;
  });

  describe("getReleasesPageUrl", () => {
    it("returns GitHub releases URL", () => {
      const url = ChangeLogService.getReleasesPageUrl();

      expect(url).toBe("https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases");
    });
  });

  describe("getReleases", () => {
    it("fetches releases from API", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: [
          {
            tag_name: "4.4.7",
            published_at: "2026-01-26T00:00:00Z",
            body: "Release notes",
            html_url: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/4.4.7",
            draft: false,
          },
          {
            tag_name: "v4.4.6",
            published_at: "2026-01-20T00:00:00Z",
            body: "Older release notes",
            html_url: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/v4.4.6",
            draft: false,
          },
        ],
        headers: { etag: "\"test-etag\"" },
      });

      const releases = await ChangeLogService.getReleases(mockPlugin);

      expect(mockHttpRequest).toHaveBeenCalledWith({
        url: "https://api.github.com/repos/SystemSculpt/obsidian-systemsculpt-ai/releases?per_page=100",
        method: "GET",
        headers: expect.objectContaining({
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
        timeoutMs: expect.any(Number),
      });
      expect(releases).toHaveLength(2);
      expect(releases[0].version).toBe("4.4.7");
      expect(releases[0].notes).toBe("Release notes");
      expect(releases[1].version).toBe("4.4.6");
    });

    it("returns cached releases when not expired", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: [
          {
            tag_name: "4.4.7",
            published_at: "2026-01-26T00:00:00Z",
            body: "Test",
            html_url: "https://github.com/test/releases/4.4.7",
            draft: false,
          },
        ],
      });

      // First call - fetches from API
      await ChangeLogService.getReleases(mockPlugin);
      // Second call - should use cache
      await ChangeLogService.getReleases(mockPlugin);

      expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    });

    it("refreshes cache when forceRefresh is true", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: [
          {
            tag_name: "4.4.7",
            published_at: "2026-01-26T00:00:00Z",
            body: "Test",
            html_url: "https://github.com/test/releases/4.4.7",
            draft: false,
          },
        ],
      });

      // First call
      await ChangeLogService.getReleases(mockPlugin);
      // Force refresh
      await ChangeLogService.getReleases(mockPlugin, { forceRefresh: true });

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });

    it("handles missing release notes", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: [
          { tag_name: "4.4.7", published_at: "2026-01-26T00:00:00Z", draft: false }, // No body or url
        ],
      });

      const releases = await ChangeLogService.getReleases(mockPlugin, { forceRefresh: true });

      expect(releases[0].notes).toBe("No release notes provided.");
      expect(releases[0].url).toBe("https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases");
    });

    it("handles missing date", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: [
          { tag_name: "4.4.7", body: "Test", html_url: "https://github.com/test/releases/4.4.7", draft: false }, // No date
        ],
      });

      const releases = await ChangeLogService.getReleases(mockPlugin, { forceRefresh: true });

      // Should use current date
      expect(releases[0].date).toBeDefined();
    });

    it("returns fallback on non-200 status", async () => {
      mockHttpRequest.mockRejectedValue({ status: 500, headers: {} });

      const releases = await ChangeLogService.getReleases(mockPlugin, { forceRefresh: true });

      expect(releases).toHaveLength(1);
      expect(releases[0].version).toBe("Unavailable");
      expect(releases[0].notes).toContain("network error");
    });

    it("returns cached data on error if available", async () => {
      // First successful call
      mockHttpRequest.mockResolvedValueOnce({
        status: 200,
        json: [
          {
            tag_name: "4.4.7",
            published_at: "2026-01-26T00:00:00Z",
            body: "Cached",
            html_url: "https://github.com/test/releases/4.4.7",
            draft: false,
          },
        ],
      });

      await ChangeLogService.getReleases(mockPlugin);

      // Second call fails
      mockHttpRequest.mockRejectedValueOnce(new Error("Network error"));

      const releases = await ChangeLogService.getReleases(mockPlugin, { forceRefresh: true });

      expect(releases[0].version).toBe("4.4.7");
      expect(releases[0].notes).toBe("Cached");
    });

    it("returns fallback on error with no cache", async () => {
      mockHttpRequest.mockRejectedValue(new Error("Network error"));

      const releases = await ChangeLogService.getReleases(mockPlugin, { forceRefresh: true });

      expect(releases).toHaveLength(1);
      expect(releases[0].version).toBe("Unavailable");
    });

    it("uses ETag conditional request and honors 304", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      const cached = {
        schemaVersion: 1,
        fetchedAt: Date.now() - (60 * 60 * 1000) - 1, // stale
        etag: "\"etag-1\"",
        entries: [{ version: "4.4.7", date: "Jan 1, 2026", notes: "Cached", url: "url" }],
      };
      mockStorage.readFile.mockResolvedValueOnce(cached);

      mockHttpRequest.mockResolvedValueOnce({
        status: 304,
        json: null,
        headers: { etag: "\"etag-1\"" },
      });

      const releases = await ChangeLogService.getReleases(mockPlugin);

      expect(releases[0].notes).toBe("Cached");
      expect(mockHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "If-None-Match": "\"etag-1\"",
          }),
        })
      );
      expect(mockStorage.writeFile).toHaveBeenCalledWith(
        "cache",
        expect.stringContaining("changelog-github-releases"),
        expect.objectContaining({ schemaVersion: 1 })
      );

      jest.useRealTimers();
    });

    it("returns cached entries on GitHub rate limiting and avoids re-requesting until reset", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      const cached = {
        schemaVersion: 1,
        fetchedAt: Date.now() - (60 * 60 * 1000) - 1, // stale
        entries: [{ version: "4.4.7", date: "Jan 1, 2026", notes: "Cached", url: "url" }],
      };
      mockStorage.readFile.mockResolvedValueOnce(cached);

      const resetSeconds = Math.floor((Date.now() + (5 * 60 * 1000)) / 1000);
      mockHttpRequest.mockRejectedValueOnce({
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
        },
      });

      const first = await ChangeLogService.getReleases(mockPlugin);
      expect(first[0].notes).toBe("Cached");

      // Second call should short-circuit due to rateLimitedUntil.
      mockStorage.readFile.mockResolvedValueOnce({
        ...cached,
        rateLimitedUntil: Date.now() + (5 * 60 * 1000),
      });
      const second = await ChangeLogService.getReleases(mockPlugin);
      expect(second[0].notes).toBe("Cached");
      expect(mockHttpRequest).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });

  describe("findIndexByVersion", () => {
    const entries = [
      { version: "2.0.0", date: "2025-02-01", notes: "", url: "" },
      { version: "1.5.0", date: "2025-01-15", notes: "", url: "" },
      { version: "v1.0.0", date: "2025-01-01", notes: "", url: "" },
    ];

    it("finds index by exact version", () => {
      const index = ChangeLogService.findIndexByVersion(entries, "1.5.0");
      expect(index).toBe(1);
    });

    it("finds version with v prefix", () => {
      const index = ChangeLogService.findIndexByVersion(entries, "v1.0.0");
      expect(index).toBe(2);
    });

    it("finds version without v prefix when entry has v", () => {
      const index = ChangeLogService.findIndexByVersion(entries, "1.0.0");
      expect(index).toBe(2);
    });

    it("returns 0 for undefined version", () => {
      const index = ChangeLogService.findIndexByVersion(entries, undefined);
      expect(index).toBe(0);
    });

    it("returns 0 for non-existent version", () => {
      const index = ChangeLogService.findIndexByVersion(entries, "99.99.99");
      expect(index).toBe(0);
    });

    it("handles empty entries array", () => {
      const index = ChangeLogService.findIndexByVersion([], "1.0.0");
      expect(index).toBe(0);
    });
  });

  describe("exports", () => {
    it("exports GITHUB_OWNER", () => {
      expect(GITHUB_OWNER).toBe("SystemSculpt");
    });

    it("exports GITHUB_REPO", () => {
      expect(GITHUB_REPO).toBe("obsidian-systemsculpt-ai");
    });
  });
});
