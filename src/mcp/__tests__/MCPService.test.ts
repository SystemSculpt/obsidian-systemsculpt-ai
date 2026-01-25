/**
 * @jest-environment jsdom
 */
import { MCPService } from "../MCPService";
import { MCPServer } from "../../types/mcp";

// Mock adapters
const mockFilesystemAdapter = {
  listTools: jest.fn(),
  executeTool: jest.fn(),
};

const mockYouTubeAdapter = {
  listTools: jest.fn(),
  executeTool: jest.fn(),
};

const mockHTTPAdapter = {
  listTools: jest.fn(),
  executeTool: jest.fn(),
};

jest.mock("../adapters/FilesystemAdapter", () => ({
  FilesystemAdapter: jest.fn(() => mockFilesystemAdapter),
}));

jest.mock("../adapters/YouTubeAdapter", () => ({
  YouTubeAdapter: jest.fn(() => mockYouTubeAdapter),
}));

jest.mock("../adapters/HTTPAdapter", () => ({
  HTTPAdapter: jest.fn(() => mockHTTPAdapter),
}));

describe("MCPService", () => {
  let service: MCPService;
  let mockPlugin: any;
  let mockApp: any;

  const createMockServer = (overrides: Partial<MCPServer> = {}): MCPServer => ({
    id: "test-server",
    name: "Test Server",
    transport: "http",
    endpoint: "https://api.example.com/mcp",
    enabled: true,
    isEnabled: true,
    ...overrides,
  } as MCPServer);

  beforeEach(() => {
    jest.clearAllMocks();

    // Clear static caches
    (MCPService as any).connectionTestCache = new Map();
    (MCPService as any).connectionTestPromises = new Map();

    mockPlugin = {
      settings: {
        mcpEnabled: true,
        mcpServers: [],
        mcpEnabledTools: [],
      },
    };

    mockApp = {};

    service = new MCPService(mockPlugin, mockApp);

    // Default mock behaviors - internal servers return empty tools by default
    mockFilesystemAdapter.listTools.mockResolvedValue([]);
    mockYouTubeAdapter.listTools.mockResolvedValue([]);
    mockHTTPAdapter.listTools.mockResolvedValue([]);
    mockFilesystemAdapter.executeTool.mockResolvedValue({ result: "success" });
    mockYouTubeAdapter.executeTool.mockResolvedValue({ result: "success" });
    mockHTTPAdapter.executeTool.mockResolvedValue({ result: "success" });
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(MCPService);
    });
  });

  describe("clearCache", () => {
    it("clears connection caches", () => {
      (MCPService as any).connectionTestCache.set("test", { result: {}, timestamp: Date.now() });
      (MCPService as any).connectionTestPromises.set("test", Promise.resolve({}));

      service.clearCache();

      expect((MCPService as any).connectionTestCache.size).toBe(0);
      expect((MCPService as any).connectionTestPromises.size).toBe(0);
    });
  });

  describe("testConnection", () => {
    it("returns success for valid server", async () => {
      const server = createMockServer({ transport: "http" });
      mockHTTPAdapter.listTools.mockResolvedValue([
        { name: "tool1", description: "Test tool" },
      ]);

      const result = await service.testConnection(server);

      expect(result.success).toBe(true);
      expect(result.tools).toHaveLength(1);
    });

    it("returns cached result on subsequent calls", async () => {
      const server = createMockServer({ transport: "http" });
      mockHTTPAdapter.listTools.mockResolvedValue([]);

      const result1 = await service.testConnection(server);
      const result2 = await service.testConnection(server);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(mockHTTPAdapter.listTools).toHaveBeenCalledTimes(1);
    });

    it("returns failure on connection error", async () => {
      const server = createMockServer({ transport: "http" });
      mockHTTPAdapter.listTools.mockRejectedValue(new Error("Connection refused"));

      const result = await service.testConnection(server);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection refused");
    });

    it("handles abort error specially", async () => {
      const server = createMockServer({ transport: "http" });
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      mockHTTPAdapter.listTools.mockRejectedValue(abortError);

      const result = await service.testConnection(server);

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("handles non-Error rejection", async () => {
      const server = createMockServer({ transport: "http" });
      mockHTTPAdapter.listTools.mockRejectedValue("string error");

      const result = await service.testConnection(server);

      expect(result.success).toBe(false);
      expect(result.error).toContain("unexpected error");
    });

    it("uses FilesystemAdapter for internal mcp-filesystem server", async () => {
      const server = createMockServer({
        id: "mcp-filesystem",
        transport: "internal" as any,
      });
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "fs_read", description: "Read file" },
      ]);

      const result = await service.testConnection(server);

      expect(result.success).toBe(true);
    });
  });

  describe("getAvailableTools", () => {
    // NOTE: With the new "always enabled" behavior, internal servers (filesystem, youtube)
    // are always included. These tests verify the new behavior.

    it("always returns internal server tools regardless of mcpEnabled setting", async () => {
      mockPlugin.settings.mcpEnabled = false; // This setting is now deprecated/ignored
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "read", description: "Read file" },
      ]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);

      const tools = await service.getAvailableTools();

      // Internal servers always provide tools regardless of settings
      expect(tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.some(t => t.function.name.startsWith("mcp-filesystem_"))).toBe(true);
    });

    it("always returns internal server tools regardless of mcpEnabledTools setting", async () => {
      mockPlugin.settings.mcpEnabledTools = []; // This setting is now deprecated/ignored
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "read", description: "Read file" },
      ]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);

      const tools = await service.getAvailableTools();

      // Internal server tools are always included
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });

    it("always includes internal servers even when custom servers are disabled", async () => {
      mockPlugin.settings.mcpServers = [createMockServer({ isEnabled: false })];
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "read", description: "Read file" },
      ]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);

      const tools = await service.getAvailableTools();

      // Internal servers are always available
      expect(tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.some(t => t.function.name.startsWith("mcp-filesystem_"))).toBe(true);
    });

    it("returns tools from both internal servers and custom HTTP servers", async () => {
      const server = createMockServer();
      mockPlugin.settings.mcpServers = [server];
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "read", description: "Read file" },
      ]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);
      mockHTTPAdapter.listTools.mockResolvedValue([
        { name: "tool1", description: "Test tool", inputSchema: { type: "object" } },
      ]);

      const tools = await service.getAvailableTools();

      // Should have both internal and custom server tools
      expect(tools.length).toBeGreaterThanOrEqual(2);
      expect(tools.some(t => t.function.name.startsWith("mcp-filesystem_"))).toBe(true);
      expect(tools.some(t => t.function.name === "test-server_tool1")).toBe(true);
    });

    it("returns all tools from servers (no filtering)", async () => {
      const server = createMockServer();
      mockPlugin.settings.mcpServers = [server];
      mockFilesystemAdapter.listTools.mockResolvedValue([]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);
      mockHTTPAdapter.listTools.mockResolvedValue([
        { name: "tool1", description: "First tool" },
        { name: "tool2", description: "Second tool" },
      ]);

      const tools = await service.getAvailableTools();

      // All tools should be included (no filtering by mcpEnabledTools)
      expect(tools.filter(t => t.function.name.startsWith("test-server_")).length).toBe(2);
    });

    it("handles connection failure gracefully", async () => {
      const server = createMockServer();
      mockPlugin.settings.mcpServers = [server];
      mockFilesystemAdapter.listTools.mockResolvedValue([]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);
      mockHTTPAdapter.listTools.mockRejectedValue(new Error("Connection failed"));

      const tools = await service.getAvailableTools();

      // Should still return internal server tools even if custom server fails
      expect(Array.isArray(tools)).toBe(true);
    });

    it("skips tools with invalid names", async () => {
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "", description: "Invalid tool" },
      ]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);

      const tools = await service.getAvailableTools();

      // Invalid tools should be skipped
      expect(tools.every(t => t.function.name && t.function.name.length > 0)).toBe(true);
    });

    it("includes tools from internal servers with proper naming", async () => {
      mockFilesystemAdapter.listTools.mockResolvedValue([
        { name: "read", description: "Read file" },
      ]);
      mockYouTubeAdapter.listTools.mockResolvedValue([
        { name: "youtube_transcript", description: "Get transcript" },
      ]);

      const tools = await service.getAvailableTools();

      expect(tools.some(t => t.function.name === "mcp-filesystem_read")).toBe(true);
      expect(tools.some(t => t.function.name === "mcp-youtube_youtube_transcript")).toBe(true);
    });
  });

  describe("executeTool", () => {
    beforeEach(() => {
      const server = createMockServer();
      mockPlugin.settings.mcpServers = [server];
    });

    it("executes tool on correct server", async () => {
      mockHTTPAdapter.executeTool.mockResolvedValue({ output: "success" });

      const result = await service.executeTool("test-server_toolName", { arg: "value" });

      expect(mockHTTPAdapter.executeTool).toHaveBeenCalledWith(
        "toolName",
        { arg: "value" },
        undefined,
        undefined
      );
      expect(result).toEqual({ output: "success" });
    });

    it("passes chatView and options to adapter", async () => {
      const mockChatView = {};
      const options = { timeoutMs: 5000 };
      mockHTTPAdapter.executeTool.mockResolvedValue({});

      await service.executeTool("test-server_tool", {}, mockChatView, options);

      expect(mockHTTPAdapter.executeTool).toHaveBeenCalledWith(
        "tool",
        {},
        mockChatView,
        options
      );
    });

    it("throws error for invalid tool name format", async () => {
      await expect(
        service.executeTool("invalidformat", {})
      ).rejects.toThrow("Invalid tool name format");
    });

    it("throws error for unknown server", async () => {
      await expect(
        service.executeTool("unknown-server_tool", {})
      ).rejects.toThrow("MCP server not found");
    });

    it("throws error for disabled server", async () => {
      mockPlugin.settings.mcpServers = [createMockServer({ isEnabled: false })];

      await expect(
        service.executeTool("test-server_tool", {})
      ).rejects.toThrow("MCP server is disabled");
    });

    it("handles tools with underscores in name", async () => {
      mockHTTPAdapter.executeTool.mockResolvedValue({});

      await service.executeTool("test-server_tool_with_underscores", {});

      expect(mockHTTPAdapter.executeTool).toHaveBeenCalledWith(
        "tool_with_underscores",
        {},
        undefined,
        undefined
      );
    });

    it("maps filesystem paths when a root is set", async () => {
      const fsServer = createMockServer({
        id: "mcp-filesystem",
        name: "Filesystem",
        transport: "internal" as any,
      });
      mockPlugin.settings.mcpServers = [fsServer];
      const root = ".systemsculpt/benchmarks/v2/active";
      service.setFilesystemRoot(root);

      await service.executeTool("mcp-filesystem_read", {
        paths: ["Inbox/Meeting.md", "/.systemsculpt/benchmarks/v2/active/Inbox/Notes.md"],
      });

      expect(mockFilesystemAdapter.executeTool).toHaveBeenCalledWith(
        "read",
        {
          paths: [`${root}/Inbox/Meeting.md`, `${root}/Inbox/Notes.md`],
        },
        undefined,
        undefined
      );
    });

    it("maps filesystem paths when a display root alias is used", async () => {
      const fsServer = createMockServer({
        id: "mcp-filesystem",
        name: "Filesystem",
        transport: "internal" as any,
      });
      mockPlugin.settings.mcpServers = [fsServer];
      const root = ".systemsculpt/benchmarks/v2/active";
      service.setFilesystemRoot(root, ["BenchmarkVault"]);

      await service.executeTool("mcp-filesystem_read", {
        paths: ["BenchmarkVault/Inbox/Meeting.md", "/BenchmarkVault/Inbox/Notes.md"],
      });

      expect(mockFilesystemAdapter.executeTool).toHaveBeenCalledWith(
        "read",
        {
          paths: [`${root}/Inbox/Meeting.md`, `${root}/Inbox/Notes.md`],
        },
        undefined,
        undefined
      );
    });

    it("maps absolute paths that include the real root", async () => {
      const fsServer = createMockServer({
        id: "mcp-filesystem",
        name: "Filesystem",
        transport: "internal" as any,
      });
      mockPlugin.settings.mcpServers = [fsServer];
      const root = ".systemsculpt/benchmarks/v2/active";
      service.setFilesystemRoot(root);

      await service.executeTool("mcp-filesystem_read", {
        paths: [`/vault/${root}/Inbox/Meeting.md`],
      });

      expect(mockFilesystemAdapter.executeTool).toHaveBeenCalledWith(
        "read",
        {
          paths: [`${root}/Inbox/Meeting.md`],
        },
        undefined,
        undefined
      );
    });
  });

  describe("testAllServers", () => {
    it("always includes internal servers plus enabled custom servers", async () => {
      const server1 = createMockServer({ id: "server1", name: "Server 1" });
      const server2 = createMockServer({ id: "server2", name: "Server 2" });
      mockPlugin.settings.mcpServers = [server1, server2];
      mockFilesystemAdapter.listTools.mockResolvedValue([]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);
      mockHTTPAdapter.listTools.mockResolvedValue([]);

      const results = await service.testAllServers();

      // Should include internal servers + custom servers
      expect(results["mcp-filesystem"]).toBeDefined();
      expect(results["mcp-youtube"]).toBeDefined();
      expect(results["server1"]).toBeDefined();
      expect(results["server2"]).toBeDefined();
      expect(results["mcp-filesystem"].success).toBe(true);
      expect(results["server1"].success).toBe(true);
    });

    it("skips disabled custom servers but always includes internal servers", async () => {
      const enabledServer = createMockServer({ id: "enabled" });
      const disabledServer = createMockServer({ id: "disabled", isEnabled: false });
      mockPlugin.settings.mcpServers = [enabledServer, disabledServer];
      mockFilesystemAdapter.listTools.mockResolvedValue([]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);
      mockHTTPAdapter.listTools.mockResolvedValue([]);

      const results = await service.testAllServers();

      // Internal servers always included
      expect(results["mcp-filesystem"]).toBeDefined();
      expect(results["mcp-youtube"]).toBeDefined();
      // Enabled custom server included
      expect(results["enabled"]).toBeDefined();
      // Disabled custom server excluded
      expect(results["disabled"]).toBeUndefined();
    });

    it("always includes internal servers even when no custom servers configured", async () => {
      mockPlugin.settings.mcpServers = [];
      mockFilesystemAdapter.listTools.mockResolvedValue([]);
      mockYouTubeAdapter.listTools.mockResolvedValue([]);

      const results = await service.testAllServers();

      // Internal servers should always be present
      expect(results["mcp-filesystem"]).toBeDefined();
      expect(results["mcp-youtube"]).toBeDefined();
      expect(results["mcp-filesystem"].success).toBe(true);
      expect(results["mcp-youtube"].success).toBe(true);
    });
  });

  describe("getAdapterForServer", () => {
    it("throws error for unsupported transport", () => {
      const server = createMockServer({ transport: "stdio" as any });

      expect(() => {
        (service as any).getAdapterForServer(server);
      }).toThrow("Only HTTP and internal transports are currently supported");
    });

    it("reuses adapter for same server", async () => {
      const server = createMockServer({ transport: "http" });

      await service.testConnection(server);
      await service.testConnection(server);

      // Should use cached adapter, only one HTTPAdapter should be created
      const { HTTPAdapter } = require("../adapters/HTTPAdapter");
      expect(HTTPAdapter).toHaveBeenCalledTimes(1);
    });
  });
});
