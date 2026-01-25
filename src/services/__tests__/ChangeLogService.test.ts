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

jest.mock("../../constants/api", () => ({
  API_BASE_URL: "https://api.example.com",
  SYSTEMSCULPT_API_ENDPOINTS: {
    PLUGINS: {
      RELEASES: (id: string) => `/plugins/${id}/releases`,
    },
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

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Re-mock httpClient after resetModules
    jest.doMock("../../utils/httpClient", () => ({
      httpRequest: mockHttpRequest,
    }));
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
        json: {
          data: [
            {
              version: "1.0.0",
              date: "2025-01-01",
              notes: "Initial release",
              url: "https://github.com/test/releases/1.0.0",
            },
            {
              version: "0.9.0",
              date: "2024-12-01",
              notes: "Beta release",
              url: "https://github.com/test/releases/0.9.0",
            },
          ],
        },
      });

      const releases = await ChangeLogService.getReleases();

      expect(mockHttpRequest).toHaveBeenCalledWith({
        url: expect.stringContaining("/plugins/systemsculpt-ai/releases"),
        method: "GET",
      });
      expect(releases).toHaveLength(2);
      expect(releases[0].version).toBe("1.0.0");
      expect(releases[1].version).toBe("0.9.0");
    });

    it("returns cached releases when not expired", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          data: [{ version: "1.0.0", date: "2025-01-01", notes: "Test", url: "" }],
        },
      });

      // First call - fetches from API
      await ChangeLogService.getReleases();
      // Second call - should use cache
      await ChangeLogService.getReleases();

      expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    });

    it("refreshes cache when forceRefresh is true", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          data: [{ version: "1.0.0", date: "2025-01-01", notes: "Test", url: "" }],
        },
      });

      // First call
      await ChangeLogService.getReleases();
      // Force refresh
      await ChangeLogService.getReleases(true);

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });

    it("handles missing release notes", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          data: [
            { version: "1.0.0", date: "2025-01-01" }, // No notes or url
          ],
        },
      });

      const releases = await ChangeLogService.getReleases(true);

      expect(releases[0].notes).toBe("No release notes provided.");
      expect(releases[0].url).toBe("https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases");
    });

    it("handles missing date", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          data: [
            { version: "1.0.0", notes: "Test" }, // No date
          ],
        },
      });

      const releases = await ChangeLogService.getReleases(true);

      // Should use current date
      expect(releases[0].date).toBeDefined();
    });

    it("returns fallback on non-200 status", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 500,
        json: null,
      });

      const releases = await ChangeLogService.getReleases(true);

      expect(releases).toHaveLength(1);
      expect(releases[0].version).toBe("Unavailable");
      expect(releases[0].notes).toContain("network error");
    });

    it("returns cached data on error if available", async () => {
      // First successful call
      mockHttpRequest.mockResolvedValueOnce({
        status: 200,
        json: {
          data: [{ version: "1.0.0", date: "2025-01-01", notes: "Cached", url: "" }],
        },
      });

      await ChangeLogService.getReleases();

      // Second call fails
      mockHttpRequest.mockRejectedValueOnce(new Error("Network error"));

      const releases = await ChangeLogService.getReleases(true);

      expect(releases[0].version).toBe("1.0.0");
      expect(releases[0].notes).toBe("Cached");
    });

    it("returns fallback on error with no cache", async () => {
      mockHttpRequest.mockRejectedValue(new Error("Network error"));

      const releases = await ChangeLogService.getReleases(true);

      expect(releases).toHaveLength(1);
      expect(releases[0].version).toBe("Unavailable");
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
