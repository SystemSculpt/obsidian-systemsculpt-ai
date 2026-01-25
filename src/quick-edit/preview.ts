import { App, TFile } from "obsidian";
import type { ToolCallRequest } from "../types/toolCalls";
import { generateDiff, type DiffResult } from "../utils/diffUtils";
import type { QuickEditMoveOperation } from "./controller";

export interface QuickEditDiffPreview {
  path: string;
  oldContent: string;
  newContent: string;
  diff: DiffResult;
  move?: QuickEditMoveOperation;
}

const getBaseToolName = (fullName: string): string => {
  return fullName.replace(/^mcp[-_][^_]+_/, "");
};

const readCurrentContent = async (app: App, file: TFile): Promise<string> => {
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
    return await app.vault.read(file);
  } catch {
    return "";
  }
};

const parseArgs = (call: ToolCallRequest): any => {
  const name = call.function?.name ?? "tool";
  const raw = String(call.function?.arguments ?? "{}");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Quick Edit: invalid JSON arguments for ${name}`);
  }
};

export async function buildQuickEditDiffPreview(
  app: App,
  file: TFile,
  toolCalls: ToolCallRequest[],
  move?: QuickEditMoveOperation
): Promise<QuickEditDiffPreview> {
  const oldContent = await readCurrentContent(app, file);
  let newContent = oldContent;

  for (const call of toolCalls) {
    const toolName = call.function?.name ?? "";
    const base = getBaseToolName(toolName);
    const args = parseArgs(call);

    if (base !== "write") continue;
    newContent = String(args.content ?? "");
    break;
  }

  const diff = generateDiff(oldContent, newContent, 200);
  return { path: file.path, oldContent, newContent, diff, move };
}
