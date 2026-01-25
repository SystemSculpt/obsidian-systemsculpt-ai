/**
 * Model Context Protocol (MCP) type definitions
 * 
 * MCP enables AI applications to connect to external tools and data sources
 * through a standardized protocol. This file defines the configuration types
 * for managing MCP servers and tools within SystemSculpt.
 */

/**
 * Information about a tool available from an MCP server
 */
export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: object; // JSON schema defining the tool's parameters
}

/**
 * Configuration for an MCP server connection
 * 
 * MCP supports three transport types:
 * - HTTP: Server accessible via REST API endpoint
 * - stdio: Server runs as a command-line program
 * - internal: Built-in server implementation within the plugin
 */
export interface MCPServer {
  id: string;
  name: string;
  transport: "http" | "stdio" | "internal";
  endpoint?: string; // Required for HTTP transport
  command?: string; // Required for stdio transport
  apiKey?: string; // Optional authentication for servers that require it
  isEnabled: boolean;
  lastTested?: number; // Timestamp of last connection test
  connectionStatus?: "connected" | "disconnected" | "error" | "untested";
  availableTools?: MCPToolInfo[]; // Cached list of tools from server discovery
}

/**
 * Connection status for MCP servers
 */
export type MCPConnectionStatus = "connected" | "disconnected" | "error" | "untested";

/**
 * Transport types supported by MCP
 */
export type MCPTransport = "http" | "stdio" | "internal";