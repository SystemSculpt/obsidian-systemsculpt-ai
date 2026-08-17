import { App, TFile, normalizePath } from "obsidian";
import { DiffViewer } from "../components/DiffViewer";
import type { ToolCall } from "../types/toolCalls";
import { getFunctionDataFromToolCall } from "./toolDisplay";
import { extractPrimaryPathArg, splitToolName } from "./toolPolicy";
import { generateDiff, DiffResult } from "./diffUtils";
import { applyFileEdits } from "../tools/vault/editApplication";
import { resolveExistingVaultFile } from "../tools/vault/folderNotes";
import { normalizeLineEndings, normalizeVaultPath } from "../tools/vault/utils";
import type { FileEdit, FileEditRange, SkippedEdit } from "../tools/vault/types";

/**
 * Why a preview shows no diff. Only "identical" means the change is genuinely
 * a no-op; every other value is a reason the edit cannot be applied and must
 * be said out loud before the user approves it.
 */
export type WriteEditPreviewStatus = "changed" | "identical" | "unmatched" | "missing";

export interface WriteEditPreview {
  path: string;
  oldContent: string;
  newContent: string;
  diff: DiffResult;
  status: WriteEditPreviewStatus;
  requestedCount: number;
  appliedCount: number;
  skipped: SkippedEdit[];
}

export function isWriteOrEditTool(toolName: string): boolean {
  const { canonicalName } = splitToolName(toolName);
  return canonicalName === "write" || canonicalName === "edit" || canonicalName === "multi_edit";
}

export async function prepareWriteEditPreviews(app: App, toolCall: ToolCall): Promise<WriteEditPreview[]> {
  const fn = getFunctionDataFromToolCall(toolCall);
  if (!fn) return [];
  if (splitToolName(fn.name).canonicalName !== "multi_edit") {
    const preview = await prepareWriteEditPreview(app, toolCall);
    return preview ? [preview] : [];
  }
  const files = Array.isArray((fn.arguments as { files?: unknown }).files)
    ? (fn.arguments as { files: Array<Record<string, unknown>> }).files
    : [];
  const previews: WriteEditPreview[] = [];
  for (const [index, file] of files.entries()) {
    const path = typeof file.path === "string" ? file.path : "";
    const edits = Array.isArray(file.edits) ? file.edits : [];
    if (!path || edits.length === 0) continue;
    const preview = await prepareWriteEditPreview(app, {
      ...toolCall,
      id: `${toolCall.id}:file:${index}`,
      request: {
        ...toolCall.request,
        id: `${toolCall.request.id}:file:${index}`,
        function: {
          name: "edit",
          arguments: JSON.stringify({ path, edits, strict: file.strict }),
        },
      },
    });
    if (preview) previews.push(preview);
  }
  return previews;
}

export async function prepareWriteEditPreview(app: App, toolCall: ToolCall): Promise<WriteEditPreview | null> {
  const fn = getFunctionDataFromToolCall(toolCall);
  if (!fn) return null;
  if (!isWriteOrEditTool(fn.name)) return null;

  const path = extractPrimaryPathArg(fn.name, fn.arguments);
  if (!path) return null;

  let oldContent = "";
  const file = resolveExistingVaultFile(app, normalizePath(normalizeVaultPath(path)));
  if (file && file instanceof TFile) {
    try {
      // The executor edits normalized text, so the preview must diff against the
      // same normalization or a CRLF file reads as a whole-file rewrite.
      oldContent = normalizeLineEndings(await app.vault.read(file));
    } catch {}
  }

  let newContent = "";
  let status: WriteEditPreviewStatus = "changed";
  let requestedCount = 0;
  let appliedCount = 0;
  let skipped: SkippedEdit[] = [];
  const { canonicalName: base } = splitToolName(fn.name);
  if (base === "write") {
    const content = String((fn.arguments as any).content ?? "");
    const ifExists = String((fn.arguments as any).ifExists ?? "overwrite");
    if (file && file instanceof TFile && ifExists === "append") {
      const appendNewline = (fn.arguments as any).appendNewline === true;
      newContent = oldContent + (appendNewline && !oldContent.endsWith("\n") ? "\n" : "") + content;
    } else if (file && file instanceof TFile && ifExists === "skip") {
      newContent = oldContent;
    } else {
      newContent = content;
    }
  } else if (base === "edit") {
    const edits: FileEdit[] = Array.isArray((fn.arguments as any).edits)
      ? (fn.arguments as any).edits
      : [];
    requestedCount = edits.length;
    const applied = applyFileEdits(oldContent, edits, false);
    newContent = applied.modifiedContent;
    appliedCount = applied.appliedCount;
    skipped = applied.skipped;
    if (!file) status = "missing";
    else if (appliedCount === 0 && requestedCount > 0) status = "unmatched";
  }

  if (status === "changed" && newContent === oldContent) status = "identical";

  const diff = generateDiff(oldContent ?? "", newContent ?? "", 5);
  return { path, oldContent, newContent, diff, status, requestedCount, appliedCount, skipped };
}

export type ToolEditOccurrence = "first" | "last" | "all";
export type ToolEditMode = "exact" | "loose";
export type ToolEditRange = FileEditRange;
export type ToolFileEdit = FileEdit;

/**
 * Preview-side application of a tool's edits. Delegates to the executor's
 * applier in non-strict mode so an unmatched edit is reported rather than
 * silently returning the file unchanged.
 */
export function applyEditsLocally(original: string, edits: ToolFileEdit[]): string {
  return applyFileEdits(original, edits, false).modifiedContent;
}


/**
 * Render a unified inline diff block under a host element for write/edit tool calls.
 * Returns the created diff container or null if not applicable.
 */
export async function renderWriteEditInlineDiff(app: App, hostElement: HTMLElement, toolCall: ToolCall): Promise<HTMLElement | null> {
  const previews = await prepareWriteEditPreviews(app, toolCall);
  if (previews.length === 0) return null;

  // Remove any existing inline diff to avoid duplicates
  const existing = hostElement.querySelector(".systemsculpt-inline-diff");
  if (existing) existing.remove();

  const container = hostElement.createDiv({ cls: "systemsculpt-inline-diff" });

  if (previews.length > 1) renderInlineDiffSummary(container, previews);

  for (const preview of previews) {
    const body = container.createDiv({ cls: "systemsculpt-inline-diff__body" });
    const viewer = new DiffViewer({
      container: body,
      diffResult: preview.diff,
      fileName: preview.path,
      maxContextLines: 3,
      showLineNumbers: true,
      emptyReason: preview.status === "changed" ? "identical" : preview.status,
      emptyDetail: describeSkippedEdits(preview),
    });
    viewer.render();
  }

  return container;
}

function describeSkippedEdits(preview: WriteEditPreview): string | undefined {
  if (preview.status === "changed" || preview.requestedCount === 0) return undefined;
  const failed = preview.requestedCount - preview.appliedCount;
  if (failed <= 0) return undefined;
  return `${failed} of ${preview.requestedCount} edit${preview.requestedCount === 1 ? "" : "s"} did not match.`;
}

/**
 * A multi-file change is approved as one unit, so the totals belong at the top.
 * Without this the user has to scroll every file to learn whether anything is
 * wrong with the batch.
 */
function renderInlineDiffSummary(container: HTMLElement, previews: readonly WriteEditPreview[]): void {
  const additions = previews.reduce((sum, preview) => sum + preview.diff.stats.additions, 0);
  const deletions = previews.reduce((sum, preview) => sum + preview.diff.stats.deletions, 0);
  const blocked = previews.filter((preview) => preview.status === "unmatched" || preview.status === "missing");

  const summary = container.createDiv({ cls: "systemsculpt-inline-diff__summary" });
  summary.createSpan({
    cls: "systemsculpt-inline-diff__summary-count",
    text: `${previews.length} files`,
  });
  if (additions > 0) {
    summary.createSpan({ cls: "systemsculpt-diff-additions", text: `+${additions}` });
  }
  if (deletions > 0) {
    summary.createSpan({ cls: "systemsculpt-diff-deletions", text: `-${deletions}` });
  }
  if (blocked.length > 0) {
    summary.createSpan({
      cls: "systemsculpt-inline-diff__summary-blocked",
      text: `${blocked.length} can't apply`,
    });
  }
}


// -----------------------------
// Operations (move/trash/create_folders) preview
// -----------------------------

export type OperationsPreview =
  | { type: "move"; items: Array<{ source: string; destination: string }> }
  | { type: "trash"; items: Array<{ path: string }> }
  | { type: "create_folders"; items: Array<{ path: string }> };

export function isMoveTool(toolName: string): boolean {
  return splitToolName(toolName).canonicalName === "move";
}

export function isTrashTool(toolName: string): boolean {
  return splitToolName(toolName).canonicalName === "trash";
}

export function isCreateFoldersTool(toolName: string): boolean {
  return splitToolName(toolName).canonicalName === "create_folders";
}

export function prepareOperationsPreview(toolCall: ToolCall): OperationsPreview | null {
  const fn = getFunctionDataFromToolCall(toolCall);
  if (!fn) return null;
  const base = splitToolName(fn.name).canonicalName;
  const args = (fn.arguments ?? {}) as Record<string, any>;

  if (base === "move") {
    const destinationFallback =
      typeof args.destination === "string"
        ? args.destination
        : typeof args.target === "string"
          ? args.target
          : typeof args.to === "string"
            ? args.to
            : typeof args.targetPath === "string"
              ? args.targetPath
              : "";

    const rawItems = Array.isArray(args.items) ? args.items : [];
    // De-duplicate identical move pairs (source,destination)
    const seen = new Set<string>();
    const items = rawItems
      .map((it: any) => ({
        source: String(it?.source ?? it?.path ?? it?.from ?? ""),
        destination: String(it?.destination ?? destinationFallback ?? ""),
      }))
      .filter((it: any) => it.source && it.destination)
      .filter((it: any) => {
        const key = `${it.source}\u0000${it.destination}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (items.length === 0 && Array.isArray(args.paths) && destinationFallback) {
      for (const path of args.paths) {
        const source = String(path ?? "");
        if (!source) continue;
        const key = `${source}\u0000${destinationFallback}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ source, destination: destinationFallback });
      }
    }

    if (items.length === 0) return null;
    return { type: "move", items };
  }

  if (base === "trash") {
    const raw = Array.isArray(args.paths) ? args.paths : [];
    const seen = new Set<string>();
    const items = raw
      .map((p: any) => ({ path: String(p) }))
      .filter((it: any) => !!it.path)
      .filter((it: any) => {
        if (seen.has(it.path)) return false;
        seen.add(it.path);
        return true;
      });
    if (items.length === 0) return null;
    return { type: "trash", items };
  }

  if (base === "create_folders") {
    const raw = Array.isArray(args.paths) ? args.paths : [];
    const seen = new Set<string>();
    const items = raw
      .map((p: any) => ({ path: String(p) }))
      .filter((it: any) => !!it.path)
      .filter((it: any) => {
        if (seen.has(it.path)) return false;
        seen.add(it.path);
        return true;
      });
    if (items.length === 0) return null;
    return { type: "create_folders", items };
  }

  return null;
}

export async function renderOperationsInlinePreview(hostElement: HTMLElement, toolCall: ToolCall): Promise<HTMLElement | null> {
  const preview = prepareOperationsPreview(toolCall);
  if (!preview) return null;

  // Remove any existing inline ops preview to avoid duplicates
  const existing = hostElement.querySelector(".systemsculpt-inline-ops");
  if (existing) existing.remove();

  const container = hostElement.createDiv({ cls: "systemsculpt-inline-ops" });

  const body = container.createDiv({ cls: "systemsculpt-inline-ops__body" });

  const list = body.createEl("ul");
  if (preview.type === "move") {
    // Render as a single compact line with FULL paths: "Move: path/src → path/dst, ..."
    const li = list.createEl("li");
    li.createSpan({ text: "Move: " });
    preview.items.forEach((it, idx) => {
      const src = li.createEl("code", { cls: "ss-modal__inline-code" });
      src.textContent = it.source;
      li.createSpan({ text: " → " });
      const dst = li.createEl("code", { cls: "ss-modal__inline-code" });
      dst.textContent = it.destination;
      if (idx < preview.items.length - 1) li.appendChild(li.ownerDocument.createTextNode(", "));
    });
  } else if (preview.type === "trash") {
    // Render as a single compact line: "Trash: a.md, b.md, c.md"
    const li = list.createEl("li");
    li.createSpan({ text: "Trash: " });
    preview.items.forEach((it, idx) => {
      const code = li.createEl("code", { cls: "ss-modal__inline-code" });
      code.textContent = it.path;
      if (idx < preview.items.length - 1) li.appendChild(li.ownerDocument.createTextNode(", "));
    });
  } else if (preview.type === "create_folders") {
    // Keep full paths visible so folders with the same base name stay distinct.
    const li = list.createEl("li");
    li.createSpan({ text: "Create folders: " });
    preview.items.forEach((it, idx) => {
      const code = li.createEl("code", { cls: "ss-modal__inline-code" });
      code.textContent = it.path;
      if (idx < preview.items.length - 1) li.appendChild(li.ownerDocument.createTextNode(", "));
    });
  }

  return container;
}
