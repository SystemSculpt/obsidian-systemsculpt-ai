import { MCPToolInfo } from "../../types/mcp";
import { fileToolDefinitions } from "./toolDefinitions/fileToolDefinitions";
import { directoryToolDefinitions } from "./toolDefinitions/directoryToolDefinitions";
import { searchToolDefinitions } from "./toolDefinitions/searchToolDefinitions";
import { managementToolDefinitions } from "./toolDefinitions/managementToolDefinitions";

/**
 * Combined tool definitions for MCP Filesystem Server
 */
export const toolDefinitions: MCPToolInfo[] = [
  ...fileToolDefinitions,
  ...directoryToolDefinitions,
  ...searchToolDefinitions,
  ...managementToolDefinitions
];
