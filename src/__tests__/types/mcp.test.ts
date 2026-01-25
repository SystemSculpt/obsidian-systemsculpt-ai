/**
 * @jest-environment node
 */
import type {
  MCPToolInfo,
  MCPServer,
  MCPConnectionStatus,
  MCPTransport,
} from "../../types/mcp";

describe("MCPToolInfo type", () => {
  it("can create a basic tool info", () => {
    const tool: MCPToolInfo = {
      name: "file_read",
      description: "Reads the contents of a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
        },
        required: ["path"],
      },
    };

    expect(tool.name).toBe("file_read");
    expect(tool.description).toBe("Reads the contents of a file");
    expect(tool.inputSchema).toBeDefined();
  });

  it("can have complex input schema", () => {
    const tool: MCPToolInfo = {
      name: "search_files",
      description: "Searches for files matching criteria",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          directory: { type: "string" },
          recursive: { type: "boolean", default: true },
          maxResults: { type: "number", default: 100 },
          fileTypes: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
    };

    expect(tool.inputSchema).toHaveProperty("properties");
  });

  it("can have empty input schema", () => {
    const tool: MCPToolInfo = {
      name: "get_current_time",
      description: "Returns the current time",
      inputSchema: {},
    };

    expect(tool.inputSchema).toEqual({});
  });
});

describe("MCPServer type", () => {
  describe("HTTP transport", () => {
    it("can create an HTTP server config", () => {
      const server: MCPServer = {
        id: "server_1",
        name: "My MCP Server",
        transport: "http",
        endpoint: "https://mcp.example.com/api",
        isEnabled: true,
      };

      expect(server.id).toBe("server_1");
      expect(server.transport).toBe("http");
      expect(server.endpoint).toBe("https://mcp.example.com/api");
    });

    it("can have authentication", () => {
      const server: MCPServer = {
        id: "auth_server",
        name: "Authenticated Server",
        transport: "http",
        endpoint: "https://secure-mcp.example.com",
        apiKey: "sk-xxx-xxx",
        isEnabled: true,
      };

      expect(server.apiKey).toBe("sk-xxx-xxx");
    });
  });

  describe("stdio transport", () => {
    it("can create a stdio server config", () => {
      const server: MCPServer = {
        id: "stdio_server",
        name: "Local MCP Tool",
        transport: "stdio",
        command: "npx mcp-tool",
        isEnabled: true,
      };

      expect(server.transport).toBe("stdio");
      expect(server.command).toBe("npx mcp-tool");
      expect(server.endpoint).toBeUndefined();
    });
  });

  describe("internal transport", () => {
    it("can create an internal server config", () => {
      const server: MCPServer = {
        id: "internal_fs",
        name: "Filesystem Tools",
        transport: "internal",
        isEnabled: true,
      };

      expect(server.transport).toBe("internal");
      expect(server.command).toBeUndefined();
      expect(server.endpoint).toBeUndefined();
    });
  });

  describe("connection status", () => {
    it("can be connected", () => {
      const server: MCPServer = {
        id: "s1",
        name: "Server",
        transport: "http",
        endpoint: "https://example.com",
        isEnabled: true,
        connectionStatus: "connected",
        lastTested: Date.now(),
      };

      expect(server.connectionStatus).toBe("connected");
    });

    it("can be disconnected", () => {
      const server: MCPServer = {
        id: "s1",
        name: "Server",
        transport: "http",
        endpoint: "https://example.com",
        isEnabled: false,
        connectionStatus: "disconnected",
      };

      expect(server.connectionStatus).toBe("disconnected");
    });

    it("can be error", () => {
      const server: MCPServer = {
        id: "s1",
        name: "Server",
        transport: "http",
        endpoint: "https://example.com",
        isEnabled: true,
        connectionStatus: "error",
      };

      expect(server.connectionStatus).toBe("error");
    });

    it("can be untested", () => {
      const server: MCPServer = {
        id: "s1",
        name: "Server",
        transport: "http",
        endpoint: "https://example.com",
        isEnabled: true,
        connectionStatus: "untested",
      };

      expect(server.connectionStatus).toBe("untested");
    });
  });

  it("can have cached tools", () => {
    const server: MCPServer = {
      id: "cached_server",
      name: "Cached Tools Server",
      transport: "http",
      endpoint: "https://example.com",
      isEnabled: true,
      availableTools: [
        { name: "tool1", description: "First tool", inputSchema: {} },
        { name: "tool2", description: "Second tool", inputSchema: {} },
      ],
    };

    expect(server.availableTools?.length).toBe(2);
    expect(server.availableTools?.[0].name).toBe("tool1");
  });
});

describe("MCPConnectionStatus type", () => {
  it("can be connected", () => {
    const status: MCPConnectionStatus = "connected";
    expect(status).toBe("connected");
  });

  it("can be disconnected", () => {
    const status: MCPConnectionStatus = "disconnected";
    expect(status).toBe("disconnected");
  });

  it("can be error", () => {
    const status: MCPConnectionStatus = "error";
    expect(status).toBe("error");
  });

  it("can be untested", () => {
    const status: MCPConnectionStatus = "untested";
    expect(status).toBe("untested");
  });
});

describe("MCPTransport type", () => {
  it("can be http", () => {
    const transport: MCPTransport = "http";
    expect(transport).toBe("http");
  });

  it("can be stdio", () => {
    const transport: MCPTransport = "stdio";
    expect(transport).toBe("stdio");
  });

  it("can be internal", () => {
    const transport: MCPTransport = "internal";
    expect(transport).toBe("internal");
  });
});
