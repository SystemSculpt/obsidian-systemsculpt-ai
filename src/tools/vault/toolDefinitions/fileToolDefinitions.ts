import type { FirstPartyToolDefinition } from "../../types";

export const fileToolDefinitions: FirstPartyToolDefinition[] = [
  {
    name: "read",
    description: "Read file contents with automatic pagination for large files, including agent-readable .systemsculpt Studio projects. Returns content, file size, and timestamps. For files over 25KB, use offset/length to paginate—metadata.hasMore indicates if more content exists.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description: "File paths relative to vault root (e.g., [\"Notes/meeting.md\", \"Projects/readme.md\"])"
        },
        offset: {
          type: "number",
          minimum: 0,
          default: 0,
          description: "Character position to start reading from. Use metadata.windowEnd from previous read to continue pagination."
        },
        length: {
          type: "number",
          minimum: 1,
          maximum: 25000,
          default: 25000,
          description: "Maximum characters to return (capped at 25000). Omit to get full window."
        }
      },
      required: ["paths"],
      additionalProperties: false
    }
  },
  {
    name: "write",
    description: "Create a new file or overwrite an existing file. Parent directories are created automatically. Existing .systemsculpt Studio projects use this same tool and are checked before writing; create a new Studio project in Studio once. For partial modifications to existing files, use the edit tool instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Destination path relative to vault root (e.g., \"Notes/new-note.md\")"
        },
        content: {
          type: "string",
          description: "Complete file content to write"
        },
        createDirs: {
          type: "boolean",
          default: true,
          description: "If true (default), creates parent directories that don't exist"
        },
        ifExists: {
          type: "string",
          enum: ["overwrite", "skip", "error", "append"],
          default: "overwrite",
          description: "Action when file exists: overwrite (replace), skip (no-op), error (fail), append (add to end)"
        },
        appendNewline: {
          type: "boolean",
          default: false,
          description: "When using append mode, add newline before appending if file doesn't end with one"
        }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "edit",
    description: "Apply find-and-replace edits to an existing file, including .systemsculpt Studio projects. Studio edits are parsed and graph-validated before write; edit the project file only, using its embedded agentGuide and nodeKindReference. Supports exact matching, regex patterns, loose whitespace matching, and line range targeting. Returns a diff plus appliedCount/requestedCount and a skipped[] list (each {index, reason}). When strict is false, check appliedCount: if it is less than requestedCount, the skipped edits did NOT apply (e.g. oldText not found) — fix their oldText and retry. success is false when appliedCount is 0, meaning nothing was written.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file to edit, relative to vault root"
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Text to find. Must match exactly unless mode is 'loose' or isRegex is true."
              },
              newText: {
                type: "string",
                description: "Replacement text. Use empty string to delete matched text."
              },
              isRegex: {
                type: "boolean",
                default: false,
                description: "If true, treat oldText as a regex pattern"
              },
              flags: {
                type: "string",
                description: "Regex flags when isRegex is true (e.g., 'gi' for global case-insensitive)"
              },
              occurrence: {
                type: "string",
                enum: ["first", "last", "all"],
                default: "first",
                description: "Which matches to replace: first, last, or all occurrences"
              },
              mode: {
                type: "string",
                enum: ["exact", "loose"],
                default: "exact",
                description: "exact: match verbatim. loose: ignore leading/trailing whitespace and CRLF differences."
              },
              range: {
                type: "object",
                properties: {
                  startLine: { type: "number", minimum: 1, description: "First line to search (1-indexed)" },
                  endLine: { type: "number", minimum: 1, description: "Last line to search (inclusive)" },
                  startIndex: { type: "number", minimum: 0, description: "Start character index (overrides line range)" },
                  endIndex: { type: "number", minimum: 0, description: "End character index (overrides line range)" }
                },
                additionalProperties: false,
                description: "Optional: constrain search to a specific region. Use either startLine/endLine or startIndex/endIndex, never both pairs."
              },
              preserveIndent: {
                type: "boolean",
                default: true,
                description: "In loose mode, apply original line's indentation to replacement"
              }
            },
            required: ["oldText", "newText"],
            additionalProperties: false
          },
          minItems: 1,
          description: "Array of edits to apply sequentially. Each edit operates on the result of previous edits."
        },
        strict: {
          type: "boolean",
          default: true,
          description: "If true (default), fail the whole operation if any edit doesn't match. If false, apply the edits that match and report the rest in skipped[] (appliedCount tells you how many landed)."
        }
      },
      required: ["path", "edits"],
      additionalProperties: false
    }
  },
  {
    name: "multi_edit",
    description: "Edit multiple existing files in one reviewed operation, including valid .systemsculpt project documents. Every file is checked before any write. If checking fails, nothing is written. Returns explicit per-file results; a write-time conflict can still produce a partial result.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Existing file path relative to vault root" },
              edits: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    oldText: { type: "string" },
                    newText: { type: "string" },
                    isRegex: { type: "boolean", default: false },
                    flags: { type: "string" },
                    occurrence: { type: "string", enum: ["first", "last", "all"], default: "first" },
                    mode: { type: "string", enum: ["exact", "loose"], default: "exact" },
                    range: {
                      type: "object",
                      properties: {
                        startLine: { type: "number", minimum: 1 },
                        endLine: { type: "number", minimum: 1 },
                        startIndex: { type: "number", minimum: 0 },
                        endIndex: { type: "number", minimum: 0 }
                      },
                      additionalProperties: false,
                      description: "Use either startLine/endLine or startIndex/endIndex, never both pairs."
                    },
                    preserveIndent: { type: "boolean", default: true }
                  },
                  required: ["oldText", "newText"],
                  additionalProperties: false
                }
              },
              strict: {
                type: "boolean",
                default: true,
                description: "Fail this file's preflight if any requested edit does not apply"
              }
            },
            required: ["path", "edits"],
            additionalProperties: false
          }
        }
      },
      required: ["files"],
      additionalProperties: false
    }
  }
]; 
