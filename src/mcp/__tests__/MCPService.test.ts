/**
 * @jest-environment jsdom
 */
import { MCPService } from "../MCPService";
import type { MCPServer } from "../../types/mcp";

const mockFilesystemAdapter = {
  listTools: jest.fn(),
  executeTool: jest.fn(),
  setAllowedPaths: jest.fn(),
};
const mockYouTubeAdapter = {
  listTools: jest.fn(),
  executeTool: jest.fn(),
};

jest.mock("../adapters/FilesystemAdapter", () => ({
  FilesystemAdapter: jest.fn(() => mockFilesystemAdapter),
}));
jest.mock("../adapters/YouTubeAdapter", () => ({
  YouTubeAdapter: jest.fn(() => mockYouTubeAdapter),
}));

describe("MCPService", () => {
  let service: MCPService;
  let mockPlugin: any;

  const retiredHTTPServer = (): MCPServer => ({
    id: "legacy-http",
    name: "Legacy HTTP",
    transport: "http",
    endpoint: "https://legacy.invalid/jsonrpc",
    apiKey: "sentinel-token",
    isEnabled: true,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = {
      settings: {
        mcpEnabled: true,
        mcpServers: [],
        mcpEnabledTools: [],
      },
    };
    service = new MCPService(mockPlugin, {} as any);
    mockFilesystemAdapter.listTools.mockResolvedValue([]);
    mockYouTubeAdapter.listTools.mockResolvedValue([]);
    mockFilesystemAdapter.executeTool.mockResolvedValue({ result: "filesystem" });
    mockYouTubeAdapter.executeTool.mockResolvedValue({ result: "youtube" });
  });

  it("lists built-in filesystem and YouTube tools while ignoring legacy settings", async () => {
    mockPlugin.settings.mcpEnabled = false;
    mockPlugin.settings.mcpServers = [retiredHTTPServer()];
    mockFilesystemAdapter.listTools.mockResolvedValue([
      { name: "read", description: "Read file" },
    ]);
    mockYouTubeAdapter.listTools.mockResolvedValue([
      { name: "youtube_transcript", description: "Get transcript" },
    ]);

    const tools = await service.getAvailableTools();

    expect(tools.map((tool) => tool.function.name)).toEqual([
      "mcp-filesystem_read",
      "mcp-youtube_youtube_transcript",
    ]);
  });

  it("skips malformed tool definitions from a retained built-in", async () => {
    mockFilesystemAdapter.listTools.mockResolvedValue([
      { name: "", description: "Invalid" },
    ]);

    await expect(service.getAvailableTools()).resolves.toEqual([]);
  });

  it("passes canonical filesystem aliases through the filesystem adapter", async () => {
    const result = await service.executeTool("read", { paths: ["Inbox/Test.md"] });

    expect(mockFilesystemAdapter.executeTool).toHaveBeenCalledWith(
      "read",
      { paths: ["Inbox/Test.md"] },
      undefined,
      undefined,
    );
    expect(result).toEqual({ result: "filesystem" });
  });

  it("preserves the named first-party YouTube execution path", async () => {
    const chatView = { id: "chat" };
    const options = { timeoutMs: 1_000 };

    const result = await service.executeTool(
      "mcp-youtube_youtube_transcript",
      { url: "https://youtu.be/abcdefghijk" },
      chatView,
      options,
    );

    expect(mockYouTubeAdapter.executeTool).toHaveBeenCalledWith(
      "youtube_transcript",
      { url: "https://youtu.be/abcdefghijk" },
      chatView,
      options,
    );
    expect(result).toEqual({ result: "youtube" });
  });

  it("rejects cancellation before any adapter is reached", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(service.executeTool("read", {}, undefined, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "TOOL_CANCELLED_BEFORE_START" });
    expect(mockFilesystemAdapter.executeTool).not.toHaveBeenCalled();
    expect(mockYouTubeAdapter.executeTool).not.toHaveBeenCalled();
  });

  it("rejects malformed and unknown tool names", async () => {
    await expect(service.executeTool("invalidformat", {})).rejects.toThrow(
      "Invalid tool name format",
    );
    await expect(service.executeTool("unknown-server_tool", {})).rejects.toThrow(
      "MCP server not found: unknown-server",
    );
  });

  it("maps filesystem paths under the configured root", async () => {
    const root = ".systemsculpt/temp/runtime-smoke";
    service.setFilesystemRoot(root);

    await service.executeTool("mcp-filesystem_read", {
      paths: ["Inbox/Meeting.md", `/${root}/Inbox/Notes.md`],
    });

    expect(mockFilesystemAdapter.executeTool).toHaveBeenCalledWith(
      "read",
      { paths: [`${root}/Inbox/Meeting.md`, `${root}/Inbox/Notes.md`] },
      undefined,
      undefined,
    );
  });

  it("maps canonical filesystem path args and display-root aliases", async () => {
    const root = ".systemsculpt/temp/runtime-smoke";
    service.setFilesystemRoot(root, ["SandboxRoot"]);

    await service.executeTool("read", { path: "SandboxRoot/Inbox/Meeting.md" });

    expect(mockFilesystemAdapter.executeTool).toHaveBeenCalledWith(
      "read",
      {
        path: "SandboxRoot/Inbox/Meeting.md",
        paths: [`${root}/Inbox/Meeting.md`],
      },
      undefined,
      undefined,
    );
  });

  it("forwards filesystem allowed paths without involving settings", () => {
    service.setFilesystemAllowedPaths(["Inbox"]);
    expect(mockFilesystemAdapter.setAllowedPaths).toHaveBeenCalledWith(["Inbox"]);
  });

  it("rejects non-built-in adapter construction", () => {
    expect(() => (service as any).getAdapterForServer({
      id: "stdio-server",
      name: "stdio",
      transport: "stdio",
      isEnabled: true,
    })).toThrow("Only built-in internal MCP servers are supported");
  });

  it("reuses the retained filesystem adapter", async () => {
    await service.getAvailableTools();
    await service.getAvailableTools();

    const { FilesystemAdapter } = require("../adapters/FilesystemAdapter");
    expect(FilesystemAdapter).toHaveBeenCalledTimes(1);
  });
});
