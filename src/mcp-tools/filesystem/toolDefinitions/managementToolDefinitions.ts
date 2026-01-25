import { MCPToolInfo } from "../../../types/mcp";

export const managementToolDefinitions: MCPToolInfo[] = [
  {
    name: "open",
    description: "Open files in the Obsidian workspace for the user to view. Files open in new tabs alongside the chat. Use this when the user would benefit from seeing file contents directly.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path relative to vault root"
              }
            },
            required: ["path"],
            additionalProperties: false
          },
          minItems: 1,
          maxItems: 5,
          description: "Files to open in Obsidian (max 5 at once)"
        }
      },
      required: ["files"],
      additionalProperties: false
    }
  },
  {
    name: "context",
    description: "Manage which files are included in the chat context. Adding files makes their contents available for reference in subsequent messages. Removing files reduces context size.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove"],
          description: "add: include file contents in chat context. remove: exclude files from context."
        },
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description: "File paths to add to or remove from context, relative to vault root"
        }
      },
      required: ["action", "paths"],
      additionalProperties: false
    }
  }
]; 