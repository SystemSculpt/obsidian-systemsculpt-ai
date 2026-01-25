import type { App } from "obsidian";
import SystemSculptPlugin from "../../main";
import { MCPServer, MCPToolInfo } from "../../types/mcp";

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export class HTTPAdapter {
  private server: MCPServer;
  private plugin: SystemSculptPlugin;
  private app: App;
  private nextId: () => number;

  constructor(server: MCPServer, plugin: SystemSculptPlugin, app: App, nextId: () => number) {
    this.server = server;
    this.plugin = plugin;
    this.app = app;
    this.nextId = nextId;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.server.apiKey) headers["Authorization"] = `Bearer ${this.server.apiKey}`;
    return headers;
  }

  private assertEndpoint(): string {
    if (this.server.transport !== 'http' || !this.server.endpoint) {
      throw new Error("Invalid HTTP server configuration");
    }
    return this.server.endpoint;
  }

  async listTools(): Promise<MCPToolInfo[]> {
    const endpoint = this.assertEndpoint();
    const request: JSONRPCRequest = { jsonrpc: "2.0", id: this.nextId(), method: "tools/list", params: {} };

    let response: Response;
    try {
      const { httpRequest } = await import('../../utils/httpClient');
      const r = await httpRequest({ url: endpoint, method: 'POST', headers: this.getHeaders(), body: JSON.stringify(request) });
      response = new Response(r.text || JSON.stringify(r.json || {}), { status: r.status });
    } catch (error) {
      const { showNoticeWhenReady } = await import("../../core/ui/notifications");
      const message = `❌ Connection to MCP server '${this.server.name}' refused:\n\n${endpoint}\n\nPlease ensure the MCP server is running and accessible at this URL.`;
      showNoticeWhenReady(this.app, message, { type: "error", duration: 15000 });
      throw error;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("Invalid authentication. Please check your API key and try again.");
      if (response.status === 403) throw new Error("Access denied. Please verify your authentication has the correct permissions.");
      if (response.status === 404) throw new Error("MCP endpoint not found. Please check the URL and ensure the server supports JSON-RPC over HTTP.");
      throw new Error(`HTTP error: ${errorData.error?.message || response.statusText}`);
    }

    const jsonRpcResponse: JSONRPCResponse = await response.json();
    if (jsonRpcResponse.error) throw new Error(`MCP server error: ${jsonRpcResponse.error.message}`);

    const toolsResult = jsonRpcResponse.result;
    if (!toolsResult || !Array.isArray(toolsResult.tools)) {
      throw new Error("Invalid tools response format from MCP server");
    }

    return toolsResult.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || {}
    }));
  }

  async executeTool(toolName: string, args: any, _chatView?: any, options?: { timeoutMs?: number }): Promise<any> {
    const endpoint = this.assertEndpoint();
    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: { name: toolName, arguments: args }
    };

    const { httpRequest } = await import('../../utils/httpClient');
    const r = await httpRequest({
      url: endpoint,
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
      timeoutMs: options?.timeoutMs,
    });
    const response = new Response(r.text || JSON.stringify(r.json || {}), { status: r.status });
    if (!response.ok) throw new Error(`Tool execution failed: ${response.statusText}`);

    const jsonRpcResponse: JSONRPCResponse = await response.json();
    if (jsonRpcResponse.error) throw new Error(`Tool execution error: ${jsonRpcResponse.error.message}`);
    return jsonRpcResponse.result;
  }
}

