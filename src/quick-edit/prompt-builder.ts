import type { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { ChatMessage } from "../types";
import { QUICK_EDIT_TOOLING_RULES } from "../constants/prompts/quick-edit";

export interface QuickEditSelection {
  text: string;
  range?: {
    start?: number;
    end?: number;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  };
}

export interface QuickEditPromptOptions {
  app: App;
  plugin: SystemSculptPlugin;
  file: TFile;
  prompt: string;
  selection?: QuickEditSelection;
}

export interface QuickEditMessages {
  systemPrompt: string;
  user: ChatMessage;
}

const globalCrypto: { randomUUID?: () => string } | undefined =
  typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;

const makeMessageId = (): string => {
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  return `msg_${Math.random().toString(36).slice(2, 14)}`;
};

export async function buildQuickEditMessages(options: QuickEditPromptOptions): Promise<QuickEditMessages> {
  const { app, file, prompt, selection } = options;
  const frontmatter = app.metadataCache?.getFileCache(file)?.frontmatter ?? null;
  const frontmatterKeys = frontmatter ? Object.keys(frontmatter).sort() : [];

  const readCurrentContent = async (): Promise<string> => {
    const filePath = file.path;

    try {
      const leaves = (app as any)?.workspace?.getLeavesOfType?.("markdown") ?? [];
      for (const leaf of leaves) {
        const view = leaf?.view;
        if (view?.file?.path !== filePath) continue;
        const editor = view?.editor;
        if (editor && typeof editor.getValue === "function") {
          return String(editor.getValue() ?? "");
        }
      }
    } catch {}

    try {
      const cachedRead = (app.vault as any)?.cachedRead;
      if (typeof cachedRead === "function") {
        return await cachedRead(file);
      }
    } catch {}

    try {
      return await app.vault.read(file);
    } catch {
      return "";
    }
  };

  let fileContent = "";
  fileContent = await readCurrentContent();

  const characterCount = fileContent.length;
  const wordCount = fileContent.trim().split(/\s+/).filter(Boolean).length;
  const lastModified = file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : "unknown";
  const frontmatterLine = frontmatterKeys.length > 0 ? `Frontmatter keys: ${frontmatterKeys.join(", ")}` : "Frontmatter keys: none";

  const selectionLines: string[] = [];
  if (selection && selection.text.trim().length > 0) {
    const snippet = selection.text.length > 500 ? `${selection.text.slice(0, 497)}…` : selection.text;
    selectionLines.push("Selection preview:");
    selectionLines.push("```");
    selectionLines.push(snippet);
    selectionLines.push("```");
    if (selection.range) {
      const { start, end, startLine, startColumn, endLine, endColumn } = selection.range;
      let rangeLabel = "";
      if (typeof start === "number" && typeof end === "number") {
        rangeLabel = `${start} → ${end}`;
      } else if (typeof startLine === "number" && typeof endLine === "number") {
        const startCol = typeof startColumn === "number" ? `:${startColumn}` : "";
        const endCol = typeof endColumn === "number" ? `:${endColumn}` : "";
        rangeLabel = `lines ${startLine}${startCol} → ${endLine}${endCol}`;
      }
      if (rangeLabel) {
        selectionLines.push(`Selection range: ${rangeLabel}`);
      }
    }
  }

  const metadataLines = [
    `Path: ${file.path}`,
    `Filename: ${file.basename}`,
    `Characters: ~${characterCount}`,
    `Words: ~${wordCount}`,
    `Last modified: ${lastModified}`,
    frontmatterLine,
  ];

  const userInstructions = [
    "Context about the target file:",
    ...metadataLines,
    "",
    ...selectionLines,
    selectionLines.length ? "" : undefined,
    "Current file contents (exact):",
    "```markdown",
    fileContent,
    "```",
    "",
    "Task:",
    prompt.trim(),
    "",
    "Execution details:",
    "- This Quick Edit session is scoped to this file.",
    `- Current file path: ${file.path}`,
    "- For content changes, use `mcp-filesystem_write` targeting the current (or new, after move) path.",
    "- For rename/relocate, use `mcp-filesystem_move` with source = current path.",
    "- You may use `mcp-filesystem_list_items` to explore folder structure before deciding where to move.",
    "- For edits, use tool calls rather than outputting the full file as plain text.",
    "- If no file changes are needed, respond concisely without tool calls.",
  ].filter((line): line is string => line !== undefined);

  const systemParts = [
    "You are SystemSculpt Quick Edit's file-editing agent with MCP tool access.",
    "You can modify file content, rename files, and relocate files to different folders.",
    "Work autonomously until the requested change is proposed via tool calls.",
    "You may explore the vault structure with `mcp-filesystem_list_items` before deciding where to move files.",
    "The UI will preview changes and ask the user to Apply/Discard.",
    "Preserve YAML frontmatter, existing heading hierarchy, and Markdown conventions.",
    ...QUICK_EDIT_TOOLING_RULES,
  ];

  const systemPrompt = systemParts.join("\n");

  const userMessage: ChatMessage = {
    role: "user",
    content: userInstructions.join("\n"),
    message_id: makeMessageId(),
  };

  return { systemPrompt, user: userMessage };
}
