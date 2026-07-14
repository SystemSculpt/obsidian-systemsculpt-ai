import type { FirstPartyToolDefinition } from "../../types";

export const searchToolDefinitions: FirstPartyToolDefinition[] = [
  {
    name: "find",
    description: "Search for files and folders by name. Returns matching items with path, size, and timestamps. Matches are ranked by relevance (exact matches first, then partial matches).",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Search terms to match against file/folder names. Multiple terms are OR-matched. (e.g., [\"meeting\", \"notes\"] finds files containing either word)"
        }
      },
      required: ["patterns"],
      additionalProperties: false
    }
  },
  {
    name: "search",
    description: "Full-text search across note contents. Returns matching lines with surrounding context (grep-like). Supports plain text and regex patterns.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Search patterns—plain text or regex. Multiple patterns are OR-matched. (e.g., [\"TODO\", \"FIXME\"] finds lines with either)"
        },
        searchIn: {
          type: "string",
          enum: ["content", "frontmatter", "both"],
          default: "content",
          description: "Where to search: content (note body), frontmatter (YAML properties), or both"
        },
        patternMode: {
          type: "string",
          enum: ["literal", "regex"],
          default: "literal",
          description: "literal matches patterns exactly as text; regex interprets each pattern as a regular expression"
        },
        pageTokens: {
          type: "number",
          minimum: 512,
          maximum: 4096,
          default: 2048,
          description: "Token budget for results. Increase to 4096 for broader searches. Results are truncated if they exceed budget."
        },
        cursor: {
          type: "string",
          maxLength: 4096,
          description: "Opaque next_cursor returned by the previous identical search"
        }
      },
      required: ["patterns"],
      additionalProperties: false
    }
  }
];
