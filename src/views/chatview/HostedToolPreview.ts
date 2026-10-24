import { TFile, type App, type Component } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { DiffViewer } from "../../components/DiffViewer";
import { createSurfaceElement, createUiAction } from "../../core/ui/surface";
import { generateDiff } from "../../utils/diffUtils";
import { splitToolName } from "../../utils/toolPolicy";
import { isAbsoluteFilesystemPath, normalizeVaultRelativePath } from "../../utils/vaultPathUtils";

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
    host.createSpan({ text: display });
    return;
  }
  const anchor = host.createEl("a", { text: display, cls: "internal-link", attr: { href: path, "data-href": path } });
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
  const list = host.createEl("ul", { cls: "ss-hosted-tool-list" });
  const append = (entries: readonly T[]) => {
    for (const item of entries) render(list.createEl("li"), item);
  };
  append(items.slice(0, 50));
  if (items.length > 50) {
    const all = createUiAction(host, { label: `Show all ${items.length} items`, testId: "chat.tool.show-items", size: "small", tooltip: false });
    all.onclick = () => { append(items.slice(50)); all.remove(); };
  }
}

function renderContent(host: HTMLElement, content: string): void {
  if (!content) {
    host.createEl("p", { text: "The requested content is empty." });
    return;
  }
  const lines = content.split("\n");
  const pre = host.createEl("pre", { cls: "ss-native-tool-output", attr: { tabindex: "0" } });
  const code = pre.createEl("code", { text: lines.slice(0, 20).join("\n") });
  if (lines.length > 20) {
    const all = createUiAction(host, { label: `Show all ${lines.length} lines`, testId: "chat.tool.show-output", size: "small", tooltip: false });
    all.onclick = () => { code.textContent = content; all.remove(); };
  }
}

function renderNotices(host: HTMLElement, result: RecordValue): void {
  for (const value of [result.error, result.notice]) {
    if (text(value)) host.createEl("p", { text: value as string });
  }
}

function renderRead(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions): void {
  if (Array.isArray(output.files)) {
    const files = records(output.files);
    if (!files.length) host.createEl("p", { text: "No file results were recorded." });
    else renderList(host, files, (row, file) => {
      renderPath(app, row, file.path, options);
      if (text(file.error)) row.createSpan({ text: ` · ${file.error as string}` });
      else if (record(file.metadata).hasMore === true) row.createSpan({ text: " · Partial file read" });
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
  if (!output.results.length) host.createEl("p", { text: "No folder results were recorded." });
  for (const result of records(output.results)) {
    const section = host.createDiv();
    renderPath(app, section.createEl("p"), result.path, options, false);
    renderNotices(section, result);
    const entries: Array<RecordValue & { folder: boolean }> = [
      ...records(result.directories).map(entry => ({ ...entry, folder: true })),
      ...records(result.files).map(entry => ({ ...entry, folder: false })),
    ];
    renderList(section, entries, (row, entry) => {
      renderPath(app, row, entry.path, options, !entry.folder);
      if (entry.folder) row.createSpan({ text: " · Folder" });
    });
    const total = count(result.totalItems);
    const offset = count(result.offset) ?? 0;
    if (total !== undefined) section.createEl("p", { text: `${entries.length} returned of ${total} items${offset ? ` · Starting at item ${offset + 1}` : ""}.` });
    if (count(result.nextOffset) !== undefined) section.createEl("p", { text: "More items are available in another tool result; Show all only expands the returned items." });
  }
}

function renderSearch(app: App, host: HTMLElement, output: RecordValue, options: HostedToolPreviewOptions, snippets: boolean): void {
  const results = records(output.results);
  if (results.length) renderList(host, results, (row, result) => renderPath(app, row, result.path, options));
  const matches = snippets ? strings(output.snippets) : [];
  if (matches.length) {
    // SearchOperations emits `${path}:${line}  ${context}`. Only associate a
    // snippet with a path present in the recorded result, never a guessed path.
    const paths = results.flatMap(result => text(result.path) ?? []).sort((a, b) => b.length - a.length);
    renderList(host, matches, (row, snippet) => {
      const path = paths.find(candidate => snippet.startsWith(`${candidate}:`)
        && /^\d+  /u.test(snippet.slice(candidate.length + 1)));
      if (path) {
        const suffix = snippet.slice(path.length + 1);
        const separator = suffix.indexOf("  ");
        renderPath(app, row, path, options);
        row.createSpan({ text: ` · Line ${suffix.slice(0, separator)}` });
        renderContent(row, suffix.slice(separator + 2));
      } else renderContent(row, snippet);
    });
  }
  const total = count(output.totalFound);
  if (total !== undefined) host.createEl("p", { text: `${total} file${total === 1 ? "" : "s"} found · ${results.length} returned.` });
  const page = record(output.page);
  const omitted = count(page.omitted_matches);
  if (omitted) host.createEl("p", { text: `${omitted} more matches were not included in this tool result.` });
  else if (text(page.next_cursor)) host.createEl("p", { text: "More matches are available in another tool result." });
  if (output.truncated === true) host.createEl("p", { text: "The tool returned a partial result." });
  renderNotices(host, output);
}

function renderEdit(app: App, host: HTMLElement, input: RecordValue, output: RecordValue, options: HostedToolPreviewOptions, multiple: boolean): void {
  host.createEl("p", { text: "Requested text changes only. Original file line numbers are unavailable; this preview does not verify where or how many times the text was replaced." });
  const files = multiple ? records(input.files) : [input];
  const results = multiple ? records(output.results) : [output];
  for (const file of files) {
    const section = host.createDiv({ cls: "systemsculpt-inline-diff__body" });
    renderPath(app, section.createEl("p"), file.path, options);
    const result = results.find(entry => entry.path === file.path) ?? {};
    const applied = count(result.appliedCount);
    const requested = count(result.requestedCount);
    if (applied !== undefined && requested !== undefined) section.createEl("p", { text: `${applied} of ${requested} requested edits applied.` });
    renderNotices(section, result);
    for (const skipped of records(result.skipped)) {
      if (text(skipped.reason)) section.createEl("p", { text: `Skipped${count(skipped.index) !== undefined ? ` edit ${(skipped.index as number) + 1}` : ""}: ${skipped.reason as string}` });
    }
    for (const [index, edit] of records(file.edits).entries()) {
      if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue;
      const body = section.createDiv();
      body.createEl("p", { text: `Requested edit ${index + 1}` });
      if (edit.isRegex === true) body.createEl("p", { text: "Regular expression and replacement, not literal removed and added file text." });
      if (edit.mode === "loose") body.createEl("p", { text: "Loose matching may change whitespace beyond the requested text shown here." });
      if (text(edit.occurrence)) body.createEl("p", { text: `Requested occurrence: ${edit.occurrence as string}.` });
      const context = Math.max(edit.oldText.split("\n").length, edit.newText.split("\n").length);
      const diff = generateDiff(edit.oldText, edit.newText, context);
      if (!diff.stats.additions && !diff.stats.deletions) {
        body.createEl("p", { text: edit.oldText === edit.newText ? "The requested text is unchanged." : "The request changes the final line break." });
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
    if (hasResults) host.createEl("p", { text: "No item results were recorded." });
    return;
  }
  renderList(host, items, (row, item) => {
    const success = hasResults && item.success === true;
    if (name === "move") {
      renderPath(app, row, item.source, options, !success);
      row.createSpan({ text: " → " });
      renderPath(app, row, item.destination, options, success);
    } else renderPath(app, row, item.path, options, false);
    const status = success ? name === "trash" ? "In trash" : name === "move" ? "Moved" : "Folder ready"
      : hasResults && item.success === false ? "Failed" : "Requested";
    row.createSpan({ text: ` · ${status}` });
    renderNotices(row, item);
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
  switch (name) {
    case "read": renderRead(app, container, input, output, options); break;
    case "list_items": renderDirectory(app, container, input, output, options); break;
    case "find":
    case "search": renderSearch(app, container, output, options, name === "search"); break;
    case "write":
      renderPath(app, container.createEl("p"), output.path ?? input.path, options);
      container.createEl("p", { text: "Requested file content. The original file is unavailable; this is not a before-and-after diff." });
      if (input.ifExists === "append") container.createEl("p", { text: "Append to an existing file, or create it if missing." });
      if (input.ifExists === "skip") container.createEl("p", { text: "Skip an existing file. A successful request does not confirm that this content was written." });
      if (input.ifExists === "error") container.createEl("p", { text: "Create only if the file does not already exist." });
      renderNotices(container, output);
      if (typeof input.content === "string") renderContent(container, input.content);
      break;
    case "edit":
    case "multi_edit": renderEdit(app, container, input, output, options, name === "multi_edit"); break;
    case "move":
    case "trash":
    case "create_folders": renderMutationList(app, container, input, output, options, name); break;
    default: return false;
  }
  host.querySelector(":scope > .ss-hosted-tool-preview")?.remove();
  if (!container.childElementCount) return false;
  host.appendChild(container);
  return true;
}
