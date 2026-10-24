import { App, TFile, normalizePath } from "obsidian";
import { DiffViewer } from "../../components/DiffViewer";
import type { ToolCall } from "../../types/toolCalls";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { getFunctionDataFromToolCall } from "../../utils/toolDisplay";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import { localAgentChatDirectory } from "../../services/codex/CodexExecutionSettings";
import { extractPrimaryPathArg, splitToolName } from "../../utils/toolPolicy";
import { generateDiff, DiffResult } from "../../utils/diffUtils";
import { applyFileEdits } from "../../tools/vault/editApplication";
import { resolveExistingVaultFile } from "../../tools/vault/folderNotes";
import { normalizeLineEndings, normalizeVaultPath } from "../../tools/vault/utils";
import type { FileEdit, FileEditRange, SkippedEdit } from "../../tools/vault/types";

/**
 * Why a preview shows no diff. Only "identical" means the change is genuinely
 * a no-op; every other value is a reason the edit cannot be applied and must
 * be said out loud before the user approves it.
 */
export type WriteEditPreviewStatus = "changed" | "identical" | "unmatched" | "missing" | "unavailable";

export interface WriteEditPreview {
  path: string;
  oldContent: string;
  newContent: string;
  diff: DiffResult;
  status: WriteEditPreviewStatus;
  requestedCount: number;
  appliedCount: number;
  skipped: SkippedEdit[];
  notice?: string;
  isNewFile?: boolean;
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
    } catch {
      // A missing source file produces an empty-before preview.
    }
  }

  let newContent = "";
  let status: WriteEditPreviewStatus = "changed";
  let requestedCount = 0;
  let appliedCount = 0;
  let skipped: SkippedEdit[] = [];
  const { canonicalName: base } = splitToolName(fn.name);
  if (base === "write") {
    const content = String(fn.arguments.content ?? "");
    const ifExists = String(fn.arguments.ifExists ?? "overwrite");
    if (file && file instanceof TFile && ifExists === "append") {
      const appendNewline = fn.arguments.appendNewline === true;
      newContent = oldContent + (appendNewline && !oldContent.endsWith("\n") ? "\n" : "") + content;
    } else if (file && file instanceof TFile && ifExists === "skip") {
      newContent = oldContent;
    } else {
      newContent = content;
    }
  } else if (base === "edit") {
    const edits: FileEdit[] = Array.isArray(fn.arguments.edits)
      ? fn.arguments.edits as FileEdit[]
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
  return { path, oldContent, newContent, diff, status, requestedCount, appliedCount, skipped, ...(base === "write" && !file ? { isNewFile: true } : {}) };
}

function nativeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Lexical only: native-requested paths are never resolved through the filesystem. */
function normalizedNativePath(path: string): string {
  const slashPath = path.replace(/\\/gu, "/");
  const root = /^[A-Za-z]:\//u.exec(slashPath)?.[0]
    ?? (slashPath.startsWith("//") ? "//" : slashPath.startsWith("/") ? "/" : "");
  const segments: string[] = [];
  for (const segment of slashPath.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length && segments[segments.length - 1] !== "..") segments.pop();
    else if (segment === ".." && root) continue;
    else segments.push(segment);
  }
  return root + segments.join("/");
}

// Windows drive letters are case-insensitive; preserve the requested spelling.
function comparableNativePath(value: string): string {
  return /^[A-Za-z]:/u.test(value) ? value[0].toLowerCase() + value.slice(1) : value;
}

/** Resolve against the request cwd, but display relative only to Chat's vault roots. */
export function nativeToolPath(path: string, workingDirectory: string, vaultRoot = workingDirectory, vaultRootAlias?: string, homeDirectory?: string): { displayPath: string; vaultPath: string | null } {
  const absolute = (value: string) => /^(?:[/\\]|[A-Za-z]:[/\\])/u.test(value);
  if (!path || path.includes("\0") || !absolute(vaultRoot) || (!absolute(path) && !absolute(workingDirectory)) || /^~(?:\/|\\|$)/u.test(path)) {
    return { displayPath: `${path} (vault location unverified)`, vaultPath: null };
  }
  const target = normalizedNativePath(absolute(path) ? path : `${workingDirectory}/${path}`);
  for (const value of [vaultRoot, vaultRootAlias]) {
    if (!value || !absolute(value)) continue;
    const root = normalizedNativePath(value);
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const relative = comparableNativePath(target) === comparableNativePath(root) ? ""
      : comparableNativePath(target).startsWith(comparableNativePath(prefix)) ? target.slice(prefix.length) : null;
    if (relative !== null) return { displayPath: relative === "" ? "Vault root" : relative, vaultPath: relative || null };
  }
  const home = homeDirectory && absolute(homeDirectory) ? normalizedNativePath(homeDirectory).replace(/\/$/u, "") : undefined;
  const fromHome = home && comparableNativePath(target).startsWith(comparableNativePath(`${home}/`)) ? `~/${target.slice(home.length + 1)}` : target;
  return { displayPath: `${fromHome} (outside vault)`, vaultPath: null };
}

/** Native edits use literal strings, never the hosted tool's fuzzy/range applier. */
export async function prepareNativeWriteEditPreview(app: App, part: AgentToolPart): Promise<WriteEditPreview | null> {
  if (part.native?.agent !== "claude" || !["Edit", "MultiEdit", "Write"].includes(part.name)) return null;
  const input = nativeRecord(part.input);
  if (typeof input.file_path !== "string" || !input.file_path) return null;
  const { workingDirectory, vaultRoot: nativeRoot = workingDirectory, vaultRootAlias, homeDirectory } = part.native;
  const target = nativeToolPath(input.file_path, workingDirectory, nativeRoot, vaultRootAlias, homeDirectory);
  const adapter = app.vault.adapter as { getBasePath?: () => string } | undefined;
  const hostRoot = adapter?.getBasePath?.() ?? resolveAbsoluteVaultPath(adapter, ".");
  let vaultRoot = hostRoot;
  const samePath = (first: string, second: string) => comparableNativePath(normalizedNativePath(first))
    === comparableNativePath(normalizedNativePath(second));
  const sameRoot = (root: string) => samePath(root, nativeRoot);
  if (target.vaultPath) {
    if (vaultRoot && !sameRoot(vaultRoot)) {
      try { vaultRoot = await localAgentChatDirectory(app); }
      catch { vaultRoot = null; }
    }
    // Saved native metadata is not authority to read a same-named file in another vault.
    if (!vaultRoot || !sameRoot(vaultRoot)
      || (vaultRootAlias && (!hostRoot || !samePath(vaultRootAlias, hostRoot)))) target.vaultPath = null;
  }
  const edits = part.name === "MultiEdit" ? (Array.isArray(input.edits) ? input.edits : []) : [input];
  const requestedCount = part.name === "Write" ? 0 : edits.length;
  const result = (oldContent: string, newContent: string, status: WriteEditPreviewStatus, appliedCount = 0, skipped: SkippedEdit[] = [], notice?: string): WriteEditPreview => ({
    path: target.displayPath, oldContent, newContent, status, requestedCount, appliedCount, skipped,
    diff: generateDiff(oldContent, newContent, 5), notice,
  });
  if (!target.vaultPath) return result("", "", "unavailable", 0, [], "This file is outside your vault or its vault location could not be verified. Its current contents were not read; review the requested change in Details.");
  // Never use folder-note aliases or synthesize a missing file's before-content.
  const file = app.vault.getAbstractFileByPath(target.vaultPath);
  if (file && !(file instanceof TFile)) return result("", "", "unavailable", 0, [], "This path is a folder, not a file.");
  let original = "";
  if (file instanceof TFile) {
    try { original = await app.vault.read(file); }
    catch { return result("", "", "unavailable", 0, [], "The current file could not be read. Review the requested change in Details."); }
  }
  if (part.name === "Write") {
    if (typeof input.content !== "string") return result(original, original, "unavailable", 0, [], "The file content is not available yet.");
    const status = file && input.content === original ? "identical" : "changed";
    const preview = result(original, input.content, status);
    if (!file) { preview.notice = "Create a new file."; preview.isNewFile = true; }
    else if (status === "changed" && !preview.diff.stats.additions && !preview.diff.stats.deletions) preview.notice = "Change the final line break.";
    return preview;
  }
  if (!file) return result("", "", "missing");
  if (!edits.length) return result(original, original, "unavailable", 0, [], "The requested edits are not available yet.");
  let changed = original;
  for (const [index, value] of edits.entries()) {
    const edit = nativeRecord(value);
    const before = edit.old_string, after = edit.new_string;
    let reason: string | undefined;
    if (typeof before !== "string" || typeof after !== "string") reason = "The original and replacement text are required.";
    else if (!before && changed) reason = "The text to replace is empty, but the file is not.";
    else if (before && !changed.includes(before)) reason = "The original text does not match exactly, including spaces and line endings.";
    else if (before && edit.replace_all !== true && changed.indexOf(before, changed.indexOf(before) + before.length) !== -1) reason = "The original text appears more than once. This request does not replace every occurrence.";
    if (reason) {
      // MultiEdit is one proposed operation: an unmatched step must not look like
      // the remaining steps succeeded, or expose a fictitious partial after-file.
      return result(original, original, "unmatched", 0, [{ index, reason }], `Edit ${index + 1}: ${reason} No proposed changes are shown for this request.`);
    }
    const oldText = before as string, newText = after as string;
    changed = oldText === "" ? newText : edit.replace_all === true
      ? changed.split(oldText).join(newText)
      : changed.replace(oldText, () => newText);
  }
  const preview = result(original, changed, changed === original ? "identical" : "changed", edits.length);
  if (preview.status === "changed" && !preview.diff.stats.additions && !preview.diff.stats.deletions) preview.notice = "Change the final line break.";
  return preview;
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
  return renderPreparedWriteEditPreviews(hostElement, previews, { approval: true });
}

/** Shared appearance for native exact previews and hosted executor previews. */
export function renderPreparedWriteEditPreviews(hostElement: HTMLElement, previews: readonly WriteEditPreview[], options: { approval?: boolean } = {}): HTMLElement | null {
  if (previews.length === 0) return null;

  // Remove any existing inline diff to avoid duplicates
  const existing = hostElement.querySelector(".systemsculpt-inline-diff");
  if (existing) existing.remove();

  const container = hostElement.createDiv({ cls: "systemsculpt-inline-diff" });

  if (previews.length > 1) renderInlineDiffSummary(container, previews);
  if (options.approval) hostElement.dataset.changeSize = `+${previews.reduce((sum, preview) => sum + preview.diff.stats.additions, 0)} −${previews.reduce((sum, preview) => sum + preview.diff.stats.deletions, 0)}`;

  for (const preview of previews) {
    const section = options.approval && previews.length > 1 ? container.createEl("details", { cls: "systemsculpt-inline-diff__file" }) : container;
    if (section !== container) section.createEl("summary", { text: `${preview.path} · +${preview.diff.stats.additions} −${preview.diff.stats.deletions}` });
    const body = section.createDiv({ cls: "systemsculpt-inline-diff__body" });
    if (preview.status === "unavailable" || (preview.notice && preview.status === "changed" && !preview.diff.stats.additions && !preview.diff.stats.deletions)) {
      if (!options.approval || previews.length > 1) body.createDiv({ cls: "systemsculpt-diff-filename", text: preview.path });
      body.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: preview.notice ?? "The change preview is unavailable. Review Details before approving." });
      continue;
    }
    if (preview.isNewFile) body.createDiv({ cls: "systemsculpt-inline-diff__new-file", text: "New file" });
    if (preview.notice) body.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: preview.notice });
    const viewer = new DiffViewer({
      container: body.createDiv(),
      diffResult: preview.diff,
      fileName: preview.path,
      maxContextLines: 3,
      showLineNumbers: true,
      hideHeader: options.approval === true,
      ...(options.approval ? { maxVisibleLines: 12 } : {}),
      emptyReason: preview.status === "changed" ? "identical" : preview.status,
      emptyDetail: preview.notice ? undefined : describeSkippedEdits(preview),
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
  const args = (fn.arguments ?? {});

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
      .map((item: unknown) => {
        const record = item && typeof item === "object" && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {};
        return {
          source: String(record.source ?? record.path ?? record.from ?? ""),
          destination: String(record.destination ?? destinationFallback ?? ""),
        };
      })
      .filter((item) => item.source && item.destination)
      .filter((item) => {
        const key = `${item.source}\u0000${item.destination}`;
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

  if (base === "trash" || base === "create_folders") {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    const items = [...new Set(paths.map((path: unknown) => String(path)).filter(Boolean))]
      .map(path => ({ path }));
    return items.length ? { type: base, items } : null;
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
  } else {
    // Keep full paths visible so folders with the same base name stay distinct.
    const li = list.createEl("li");
    li.createSpan({ text: preview.type === "trash" ? "Trash: " : "Create folders: " });
    preview.items.forEach((it, idx) => {
      const code = li.createEl("code", { cls: "ss-modal__inline-code" });
      code.textContent = it.path;
      if (idx < preview.items.length - 1) li.appendChild(li.ownerDocument.createTextNode(", "));
    });
  }

  return container;
}
