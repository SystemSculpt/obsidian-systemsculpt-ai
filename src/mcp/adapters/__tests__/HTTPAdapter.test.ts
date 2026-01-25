/**
 * @jest-environment node
 */
import { HTTPAdapter } from "../HTTPAdapter";
import type { MCPServer } from "../../../types/mcp";

// Mock global Response since node doesn't have it
class MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  private body: string;

  constructor(body: string, init?: { status?: number; statusText?: string }) {
    this.body = body;
    this.status = init?.status ?? 200;
    this.statusText = init?.statusText ?? "";
    this.ok = this.status >= 200 && this.status < 300;
  }

  async json() {
    return JSON.parse(this.body);
  }
}

(global as any).Response = MockResponse;

// Mock dependencies
const mockHttpRequest = jest.fn();
jest.mock("../../../utils/httpClient", () => ({
  httpRequest: (...args: any[]) => mockHttpRequest(...args),
}));

const mockShowNoticeWhenReady = jest.fn();
jest.mock("../../../core/ui/notifications", () => ({
  showNoticeWhenReady: (...args: any[]) => mockShowNoticeWhenReady(...args),
}));

describe("HTTPAdapter", () => {
  let adapter: HTTPAdapter;
  let mockServer: MCPServer;
  let mockPlugin: any;
  let mockApp: any;
  let idCounter: number;

  const createMockServer = (overrides: Partial<MCPServer> = {}): MCPServer => ({
    id: "test-server",
    name: "Test MCP Server",
    transport: "http",
    endpoint: "https://api.example.com/mcp",
    enabled: true,
    ...overrides,
  } as MCPServer);

  beforeEach(() => {
    jest.clearAllMocks();
    idCounter = 0;
    mockServer = createMockServer();
    mockPlugin = {};
    mockApp = {};

    adapter = new HTTPAdapter(
      mockServer,
      mockPlugin,
      mockApp,
      () => ++idCounter
    );

    // Default successful response
    mockHttpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [] },
      }),
    });
  });

  describe("constructor", () => {
    it("creates adapter instance", () => {
      expect(adapter).toBeInstanceOf(HTTPAdapter);
    });
  });

  describe("listTools", () => {
    it("returns tools from MCP server", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "tool1", description: "First tool", inputSchema: { type: "object" } },
              { name: "tool2", description: "Second tool" },
            ],
          },
        }),
      });

      const tools = await adapter.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0]).toEqual({
        name: "tool1",
        description: "First tool",
        inputSchema: { type: "object" },
      });
      expect(tools[1].inputSchema).toEqual({});
    });

    it("sends correct JSON-RPC request", async () => {
      await adapter.listTools();

      expect(mockHttpRequest).toHaveBeenCalledWith({
        url: "https://api.example.com/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining('"method":"tools/list"'),
      });
    });

    it("includes authorization header when API key is set", async () => {
      mockServer.apiKey = "test-api-key";
      adapter = new HTTPAdapter(mockServer, mockPlugin, mockApp, () => ++idCounter);

      await adapter.listTools();

      expect(mockHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer test-api-key",
          },
        })
      );
    });

    it("throws error for invalid server configuration", async () => {
      mockServer.transport = "stdio";
      adapter = new HTTPAdapter(mockServer, mockPlugin, mockApp, () => ++idCounter);

      await expect(adapter.listTools()).rejects.toThrow("Invalid HTTP server configuration");
    });

    it("throws error when endpoint is missing", async () => {
      mockServer.endpoint = undefined;
      adapter = new HTTPAdapter(mockServer, mockPlugin, mockApp, () => ++idCounter);

      await expect(adapter.listTools()).rejects.toThrow("Invalid HTTP server configuration");
    });

    it("shows notice and throws on connection refused", async () => {
      mockHttpRequest.mockRejectedValue(new Error("Connection refused"));

      await expect(adapter.listTools()).rejects.toThrow("Connection refused");
      expect(mockShowNoticeWhenReady).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("Connection to MCP server"),
        expect.objectContaining({ type: "error" })
      );
    });

    it("throws error for 401 response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 401,
        text: JSON.stringify({ error: { message: "Unauthorized" } }),
      });

      await expect(adapter.listTools()).rejects.toThrow("Invalid authentication");
    });

    it("throws error for 403 response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 403,
        text: JSON.stringify({}),
      });

      await expect(adapter.listTools()).rejects.toThrow("Access denied");
    });

    it("throws error for 404 response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 404,
        text: JSON.stringify({}),
      });

      await expect(adapter.listTools()).rejects.toThrow("MCP endpoint not found");
    });

    it("throws error for other HTTP errors", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 500,
        text: JSON.stringify({ error: { message: "Internal server error" } }),
      });

      await expect(adapter.listTools()).rejects.toThrow("Internal server error");
    });

    it("throws error for JSON-RPC error response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "Invalid request" },
        }),
      });

      await expect(adapter.listTools()).rejects.toThrow("Invalid request");
    });

    it("throws error for invalid tools response format", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { notTools: [] },
        }),
      });

      await expect(adapter.listTools()).rejects.toThrow("Invalid tools response format");
    });

    it("throws error when result is missing", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
        }),
      });

      await expect(adapter.listTools()).rejects.toThrow("Invalid tools response format");
    });

    it("handles json property in response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "tool1", description: "Test" }] },
        },
        text: undefined,
      });

      const tools = await adapter.listTools();

      expect(tools).toHaveLength(1);
    });
  });

  describe("executeTool", () => {
    it("executes tool and returns result", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { output: "success" },
        }),
      });

      const result = await adapter.executeTool("testTool", { arg1: "value1" });

      expect(result).toEqual({ output: "success" });
    });

    it("sends correct JSON-RPC request", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {},
        }),
      });

      await adapter.executeTool("myTool", { key: "value" });

      expect(mockHttpRequest).toHaveBeenCalledWith({
        url: "https://api.example.com/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining('"method":"tools/call"'),
        timeoutMs: undefined,
      });

      const body = JSON.parse(mockHttpRequest.mock.calls[0][0].body);
      expect(body.params).toEqual({
        name: "myTool",
        arguments: { key: "value" },
      });
    });

    it("passes timeout option to httpRequest", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {},
        }),
      });

      await adapter.executeTool("myTool", {}, undefined, { timeoutMs: 5000 });

      expect(mockHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 5000,
        })
      );
    });

    it("throws error for non-OK response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 500,
        text: "Internal Server Error",
      });

      await expect(
        adapter.executeTool("myTool", {})
      ).rejects.toThrow("Tool execution failed");
    });

    it("throws error for JSON-RPC error response", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid params" },
        }),
      });

      await expect(
        adapter.executeTool("myTool", {})
      ).rejects.toThrow("Tool execution error: Invalid params");
    });

    it("increments request ID for each call", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {},
        }),
      });

      await adapter.executeTool("tool1", {});
      await adapter.executeTool("tool2", {});

      const body1 = JSON.parse(mockHttpRequest.mock.calls[0][0].body);
      const body2 = JSON.parse(mockHttpRequest.mock.calls[1][0].body);

      expect(body1.id).toBe(1);
      expect(body2.id).toBe(2);
    });

    it("handles empty arguments", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { data: "test" },
        }),
      });

      const result = await adapter.executeTool("noArgsTool", {});

      expect(result).toEqual({ data: "test" });
    });

    it("handles complex arguments", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {},
        }),
      });

      const complexArgs = {
        nested: { deep: { value: 123 } },
        array: [1, 2, 3],
        nullValue: null,
        boolValue: true,
      };

      await adapter.executeTool("complexTool", complexArgs);

      const body = JSON.parse(mockHttpRequest.mock.calls[0][0].body);
      expect(body.params.arguments).toEqual(complexArgs);
    });
  });
});
