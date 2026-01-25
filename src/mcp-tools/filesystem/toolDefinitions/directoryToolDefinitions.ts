import { MCPToolInfo } from "../../../types/mcp";
import { FILESYSTEM_LIMITS } from "../constants";

export const directoryToolDefinitions: MCPToolInfo[] = [
  {
    name: "create_folders",
    description: "Create one or more directories. Creates full path including parent directories. Idempotent: succeeds silently if directory already exists.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Directory paths to create, relative to vault root (e.g., [\"Projects/2024/Q1\", \"Archive/old\"])"
        }
      },
      required: ["paths"],
      additionalProperties: false
    }
  },
  {
    name: "list_items",
    description: "List contents of one or more directories. Returns files and subdirectories with metadata (name, size, timestamps). Use filter to show only files or directories.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5,
          description: "Directory paths to list, relative to vault root. Use [\"\"] or [\".\"] for vault root."
        },
        filter: {
          type: "string",
          enum: ["all", "files", "directories"],
          default: "all",
          description: "Filter results: all (both), files (only files), directories (only folders)"
        },
        sort: {
          type: "string",
          enum: ["modified", "size", "name", "created"],
          default: "modified",
          description: "Sort order for results. Most recent/largest first for modified/size/created."
        },
        recursive: {
          type: "boolean",
          default: false,
          description: "If true, include contents of subdirectories. May be slow for large directory trees."
        }
      },
      required: ["paths"],
      additionalProperties: false
    }
  },
  {
    name: "move",
    description: "Move or rename files and folders. Automatically updates all internal wiki-links and embeds pointing to moved items. Creates destination directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: FILESYSTEM_LIMITS.MAX_OPERATIONS,
          items: {
            type: "object",
            properties: {
              source: {
                type: "string",
                description: "Current path of file or folder to move"
              },
              destination: {
                type: "string",
                description: "Target path. Same directory = rename, different directory = move."
              }
            },
            required: ["source", "destination"],
            additionalProperties: false
          },
          description: "Array of move operations. Each specifies source and destination paths."
        }
      },
      required: ["items"],
      additionalProperties: false
    }
  },
  {
    name: "trash",
    description: "Move files or folders to Obsidian's trash. Items can be restored from the .trash folder. Safer than permanent deletion.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 100,
          description: "Paths to move to trash, relative to vault root"
        }
      },
      required: ["paths"],
      additionalProperties: false
    }
  }
]; 
