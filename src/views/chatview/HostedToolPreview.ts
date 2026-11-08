import { TFile, type App, type Component } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { DiffViewer } from "../../components/DiffViewer";
import { createSurfaceElement, createUiAction } from "../../core/ui/surface";
import { generateDiff } from "../../utils/diffUtils";
import { splitToolName } from "../../utils/toolPolicy";
import { isAbsoluteFilesystemPath, normalizeVaultRelativePath } from "../../utils/vaultPathUtils";
import { renderSystemSculptToolCard } from "./SystemSculptToolCard";
import { createToolCard, folderLink, inputFields, renderFields, renderNotice, renderText, toolOutputText } from "./ToolCardBlocks";

type RecordValue = Record<string, unknown>;
export type HostedToolPreviewOptions = Readonly<{
  onOpenPath?: (path: string) => void | Promise<void>;
}>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter(entry => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeVaultPath(value: string): string | null {
  const raw = value.trim().replace(/\\/gu, "/");
  // Normalization strips absolute roots; never turn an external path into a
  // vault link. Literal vault filenames are not URI-decoded or link-parsed.
  if (!raw || isAbsoluteFilesystemPath(raw) || raw.startsWith("~/")
    || /^[a-z][a-z\d+.-]*:/iu.test(raw) || raw.includes("\u0000")
    || raw.split("/").some(segment => segment === "." || segment === "..")) return null;
  return normalizeVaultRelativePath(raw) || null;
}

function renderPath(app: App, host: HTMLElement, value: unknown, options: HostedToolPreviewOptions, link = true): void {
  if (typeof value !== "string") return;
  const root = !value.trim() || value === "." || value === "/";
  const display = root ? "Vault root" : value;
  const path = link && !root ? safeVaultPath(display) : null;
  if (!path) {
    host.createSpan({ cls: "ss-tool-path", text: display });
    return;
  }
  const anchor = host.createEl("a", { text: display, cls: "internal-link ss-tool-path", attr: { href: path, "data-href": path, title: path } });
  anchor.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    if (options.onOpenPath) void options.onOpenPath(path);
    else {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) void app.workspace.getLeaf(false).openFile(file);
    }
  };
}

function renderList<T>(host: HTMLElement, items: readonly T[], render: (row: HTMLElement, item: T) => void): void {
  const list = host.createEl("ul", { cls: "ss-tool-paths" });
  const append = (entries: readonly T[]) => {
    for (const item of entries) render(list.createEl("li"), item);
  };
  append(items.slice(0, 50));
  if (items.length > 50) {
    const all = createUiAction(host, { label: `Show all ${items.length} items`, testId: "chat.tool.show-items", size: "small", tooltip: false });
    all.addClass("ss-tool-more");
    all.onclick = () => { append(items.slice(50)); all.remove(); };
  }
}

function renderContent(host: HTMLElement, content: string): void {
  if (!content) {
    caption(host, "The requested content is empty.");
    return;
  }
  const lines = content.split("\n");
  const pre = host.createEl("pre", { cls: "ss-native-tool-output", attr: { tabindex: "0" } });
  const code = pre.createEl("code", { text: lines.slice(0, 20).join("\n") });
  if (lines.length > 20) {
    const all = createUiAction(host, { label: `Show all ${lines.length} lines`, testId: "chat.tool.show-output", size: "small", tooltip: false });
    all.addClass("ss-tool-more");
    all.onclick = () => { code.textContent = content; all.remove(); };
  }
}

/** Muted supporting line: what the preview can and cannot show. */
function caption(host: HTMLElement, value: string): HTMLElement {
  return host.createEl("p", { cls: "ss-tool-caption", text: value });
}

/** A secondary fact beside a path: " · Folder", " · Moved". */
function note(row: HTMLElement, value: string, tone?: "warning"): void {
  // The separator stays with its note, never stranded at a line end.
  row.createSpan({ cls: `ss-tool-path-note${tone ? ` is-${tone}` : ""}`, text: ` ·\u00a0${value}` });
}

function renderNotices(host: HTMLElement, result: RecordValue): void {
  if (text(result.error)) renderNotice(host, { tone: "warning", text: result.error as string });
  if (text(result.notice)) renderNotice(host, { tone: "info", text: result.notice as string });
}

function renderOpen(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions): void {
  const opened = strings(output.opened);
  const requested = [...records(input.files).flatMap(file => text(file.path) ?? []), ...strings(input.path)];
  renderList(host, Array.isArray(output.opened) ? opened : requested, (row, path) => renderPath(app, row, path, options));
  for (const error of strings(output.errors)) renderNotice(host, { tone: "warning", text: error });
}

function renderContext(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions): void {
  if (!Array.isArray(output.results)) {
    renderList(host, [...strings(input.paths), ...strings(input.path)], (row, path) => renderPath(app, row, path, options));
    return;
  }
  const pinning = String(input.action ?? "").toLowerCase() !== "remove";
  renderList(host, records(output.results), (row, result) => {
    renderPath(app, row, result.path, options);
    if (result.success === true) note(row, pinning ? "Pinned" : "Unpinned");
    else if (text(result.reason)) note(row, result.reason as string);
    else if (result.success === false) note(row, "Not pinned");
    if (text(result.notice)) row.createDiv({ cls: "ss-tool-caption", text: result.notice as string });
  });
  if (text(output.summary)) caption(host, output.summary as string);
}

/** A vault tool this version has no card for: its input in words, its text result if any. */
function renderUnknown(app: App, host: HTMLElement, input: RecordValue, output: unknown): void {
  renderFields(app, host, inputFields(input));
  const result = toolOutputText(output);
  if (result) renderText(host, result, 6);
}

function renderRead(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions): void {
  if (Array.isArray(output.files)) {
    const files = records(output.files);
    if (!files.length) caption(host, "No file results were recorded.");
    else renderList(host, files, (row, file) => {
      renderPath(app, row, file.path, options);
      if (text(file.error)) note(row, file.error as string, "warning");
      else if (record(file.metadata).hasMore === true) note(row, "Partial file read");
    });
  } else {
    renderList(host, strings(input.paths), (row, path) => renderPath(app, row, path, options));
  }
}

function renderDirectory(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions): void {
  if (!Array.isArray(output.results)) {
    renderList(host, strings(input.paths), (row, path) => renderPath(app, row, path, options, false));
    return;
  }
  if (!output.results.length) caption(host, "No folder results were recorded.");
  for (const result of records(output.results)) {
    const section = host.createDiv({ cls: "ss-tool-section" });
    renderPath(app, section.createDiv({ cls: "ss-tool-section-title" }), result.path, options, false);
    renderNotices(section, result);
    const entries: Array<RecordValue & { folder: boolean }> = [
      ...records(result.directories).map(entry => ({ ...entry, folder: true })),
      ...records(result.files).map(entry => ({ ...entry, folder: false })),
    ];
    renderList(section, entries, (row, entry) => {
      if (entry.folder && typeof entry.path === "string") {
        folderLink(app, row, entry.path);
        note(row, "Folder");
      } else renderPath(app, row, entry.path, options);
    });
    const total = count(result.totalItems);
    const offset = count(result.offset) ?? 0;
    // Counts say only what the list itself can't: an empty folder or a part of a longer one.
    if (total === 0 && !entries.length) caption(section, "This folder is empty.");
    else if (total !== undefined && (total !== entries.length || offset)) caption(section, `${entries.length} returned of ${total} items${offset ? ` · Starting at item ${offset + 1}` : ""}.`);
    if (count(result.nextOffset) !== undefined) caption(section, "More items are available in another tool result.");
  }
}

function renderSearch(app: App, host: HTMLElement, output: RecordValue, options: HostedToolPreviewOptions, snippets: boolean): void {
  const results = records(output.results);
  const matches = snippets ? strings(output.snippets) : [];
  // SearchOperations emits `${path}:${line}  ${context}`. Only associate a
  // snippet with a path present in the recorded result, never a guessed path.
  const paths = results.flatMap(result => text(result.path) ?? []).sort((a, b) => b.length - a.length);
  const snippetPath = (snippet: string): string | undefined => paths.find(candidate => snippet.startsWith(`${candidate}:`)
    && /^\d+ {2}/u.test(snippet.slice(candidate.length + 1)));
  // A file shown with its matching lines is not listed a second time on its own.
  const matched = new Set(matches.flatMap(snippet => snippetPath(snippet) ?? []));
  const unmatched = results.filter(result => !matched.has(text(result.path) ?? ""));
  if (unmatched.length) renderList(host, unmatched, (row, result) => renderPath(app, row, result.path, options));
  if (matches.length) {
    renderList(host, matches, (row, snippet) => {
      const path = snippetPath(snippet);
      if (path) {
        const suffix = snippet.slice(path.length + 1);
        const separator = suffix.indexOf("  ");
        renderPath(app, row, path, options);
        note(row, `Line ${suffix.slice(0, separator)}`);
        renderContent(row, suffix.slice(separator + 2));
      } else renderContent(row, snippet);
    });
  }
  const total = count(output.totalFound);
  if (total === 0 && !results.length) caption(host, "No matches.");
  else if (total !== undefined && total !== results.length) caption(host, `${total} file${total === 1 ? "" : "s"} found · ${results.length} returned.`);
  const page = record(output.page);
  const omitted = count(page.omitted_matches);
  if (omitted) caption(host, `${omitted} more matches were not included in this tool result.`);
  else if (text(page.next_cursor)) caption(host, "More matches are available in another tool result.");
  if (output.truncated === true) caption(host, "The tool returned a partial result.");
  renderNotices(host, output);
}

function renderEdit(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions, multiple: boolean): void {
  const files = multiple ? records(input.files) : [input];
  // The disclaimer describes a preview, so it shows only when there is one.
  const literal = (edit: RecordValue) => typeof edit.oldText === "string" && typeof edit.newText === "string";
  if (files.some(file => records(file.edits).some(literal))) caption(host, "Requested text changes only. Original file line numbers are unavailable.");
  const results = multiple ? records(output.results) : [output];
  for (const file of files) {
    const section = host.createDiv({ cls: "systemsculpt-inline-diff__body ss-tool-section" });
    renderPath(app, section.createDiv({ cls: "ss-tool-section-title" }), file.path, options);
    const result = results.find(entry => entry.path === file.path) ?? {};
    const applied = count(result.appliedCount);
    const requested = count(result.requestedCount);
    if (applied !== undefined && requested !== undefined) caption(section, `${applied} of ${requested} requested edits applied.`);
    renderNotices(section, result);
    for (const skipped of records(result.skipped)) {
      if (text(skipped.reason)) caption(section, `Skipped${count(skipped.index) !== undefined ? ` edit ${(skipped.index as number) + 1}` : ""}: ${skipped.reason as string}`);
    }
    for (const [index, edit] of records(file.edits).entries()) {
      if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue;
      const body = section.createDiv();
      if (records(file.edits).length > 1) caption(body, `Requested edit ${index + 1}`);
      if (edit.isRegex === true) caption(body, "Regular expression and replacement, not literal removed and added file text.");
      if (edit.mode === "loose") caption(body, "Loose matching may change whitespace beyond the requested text shown here.");
      if (text(edit.occurrence)) caption(body, `Requested occurrence: ${edit.occurrence as string}.`);
      const context = Math.max(edit.oldText.split("\n").length, edit.newText.split("\n").length);
      const diff = generateDiff(edit.oldText, edit.newText, context);
      if (!diff.stats.additions && !diff.stats.deletions) {
        caption(body, edit.oldText === edit.newText ? "The requested text is unchanged." : "The request changes the final line break.");
        continue;
      }
      new DiffViewer({
        container: body.createDiv(), fileName: text(file.path) ?? "File",
        diffResult: { ...diff, lines: diff.lines.map(({ type, content }) => ({ type, content })) },
        hideHeader: true, showLineNumbers: false, maxContextLines: 3, maxVisibleLines: 20,
      }).render();
    }
  }
}

function renderMutationList(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions, name: string): void {
  const hasResults = Array.isArray(output.results);
  const items: RecordValue[] = hasResults ? records(output.results) : name === "move" ? records(input.items) : strings(input.paths).map(path => ({ path }));
  if (!items.length) {
    if (hasResults) caption(host, "No item results were recorded.");
    return;
  }
  renderList(host, items, (row, item) => {
    const success = hasResults && item.success === true;
    if (name === "move") {
      renderPath(app, row, item.source, options, !success);
      row.createSpan({ cls: "ss-tool-path-arrow", text: " → " });
      renderPath(app, row, item.destination, options, success);
    } else renderPath(app, row, item.path, options, false);
    const status = success ? name === "trash" ? "In trash" : name === "move" ? "Moved" : "Folder ready"
      : hasResults && item.success === false ? "Failed" : "Requested";
    note(row, status, hasResults && item.success === false ? "warning" : undefined);
    // A row's own reason stays on its row; the card-level notice says what it means.
    for (const value of [item.error, item.notice]) if (text(value)) row.createDiv({ cls: "ss-tool-caption", text: value as string });
  });
}

/** Readable known vault payloads only; raw Details and approval previews stay with the caller. */
export function renderHostedToolPreview(
  app: App,
  host: HTMLElement,
  part: AgentToolPart,
  _component?: Component,
  options: HostedToolPreviewOptions = {},
): boolean {
  // Public hosted web-search results contain a count/query only. Source URLs
  // belong to the separate source-url message projection, not tool evidence.
  if (part.native || part.location !== "vault") return false;
  const { canonicalName: name } = splitToolName(part.name);
  const input = record(part.input);
  const output = record(part.output?.data);
  const container = createSurfaceElement(host.ownerDocument, "div");
  container.className = "ss-hosted-tool-preview";
  if (!renderSystemSculptToolCard(app, container, part)) {
    const card = createToolCard(container, `hosted:${name}`);
    switch (name) {
      case "read": renderRead(app, card, input, output, options); break;
      case "list_items": renderDirectory(app, card, input, output, options); break;
      case "find":
      case "search": renderSearch(app, card, output, options, name === "search"); break;
      case "write":
        renderPath(app, card.createDiv({ cls: "ss-tool-section-title" }), output.path ?? input.path, options);
        caption(card, "Requested content, not a before-and-after diff.");
        if (input.ifExists === "append") caption(card, "Append to an existing file, or create it if missing.");
        if (input.ifExists === "skip") caption(card, "Skip an existing file. A successful request does not confirm that this content was written.");
        if (input.ifExists === "error") caption(card, "Create only if the file does not already exist.");
        renderNotices(card, output);
        if (typeof input.content === "string") renderContent(card, input.content);
        break;
      case "edit":
      case "multi_edit": renderEdit(app, card, input, output, options, name === "multi_edit"); break;
      case "move":
      case "trash":
      case "create_folders": renderMutationList(app, card, input, output, options, name); break;
      case "open": renderOpen(app, card, input, output, options); break;
      case "context": renderContext(app, card, input, output, options); break;
      default: renderUnknown(app, card, input, part.output?.data);
    }
    if (!card.childElementCount) card.remove();
  }
  host.querySelector(":scope > .ss-hosted-tool-preview")?.remove();
  if (!container.childElementCount) return false;
  host.appendChild(container);
  return true;
}
