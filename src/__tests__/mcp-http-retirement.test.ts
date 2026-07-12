/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCPService } from "../mcp/MCPService";
import { httpRequest } from "../utils/httpClient";

const mockFilesystemAdapter = {
  listTools: jest.fn().mockResolvedValue([]),
  executeTool: jest.fn(),
};
const mockYouTubeAdapter = {
  listTools: jest.fn().mockResolvedValue([]),
  executeTool: jest.fn(),
};

jest.mock("../mcp/adapters/FilesystemAdapter", () => ({
  FilesystemAdapter: jest.fn(() => mockFilesystemAdapter),
}));
jest.mock("../mcp/adapters/YouTubeAdapter", () => ({
  YouTubeAdapter: jest.fn(() => mockYouTubeAdapter),
}));
jest.mock("../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

describe("retired custom HTTP MCP settings", () => {
  const loadPersistedSettings = (): any => JSON.parse(readFileSync(
    path.resolve(process.cwd(), "testing/fixtures/settings/retired-http-mcp.json"),
    "utf8",
  ));

  beforeEach(() => {
    jest.clearAllMocks();
    mockFilesystemAdapter.listTools.mockResolvedValue([]);
    mockYouTubeAdapter.listTools.mockResolvedValue([]);
    (httpRequest as jest.Mock).mockRejectedValue(new Error("network must not be reached"));
  });

  it("keeps persisted legacy entries inert and byte-equivalent in memory", async () => {
    const settings = loadPersistedSettings();
    const before = JSON.stringify(settings);
    const service = new MCPService({ settings } as any, {} as any);

    await expect(service.getAvailableTools()).resolves.toEqual([]);
    await expect(service.testAllServers()).resolves.toMatchObject({
      "mcp-filesystem": { success: true },
      "mcp-youtube": { success: true },
    });

    expect(httpRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(settings)).toBe(before);
  });

  it("returns one bounded typed failure for direct stale-ID test and execute calls", async () => {
    const settings = loadPersistedSettings();
    const legacyServer = settings.mcpServers[0];
    const service = new MCPService({ settings } as any, {} as any);

    await expect(service.testConnection(legacyServer)).resolves.toEqual({
      success: false,
      code: "unsupported_retired_http_mcp",
      error: "Custom HTTP MCP servers are no longer supported.",
      timestamp: expect.any(Number),
    });

    let failure: unknown;
    try {
      await service.executeTool("legacy-http_any_tool", { value: "sentinel" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "unsupported_retired_http_mcp",
      message: "Custom HTTP MCP servers are no longer supported.",
    });
    expect(String((failure as Error).message)).not.toContain(legacyServer.endpoint);
    expect(String((failure as Error).message)).not.toContain(legacyServer.apiKey);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
