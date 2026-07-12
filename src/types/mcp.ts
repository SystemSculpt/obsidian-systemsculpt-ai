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
