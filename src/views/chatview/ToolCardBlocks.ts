import { setIcon, TFile, TFolder, type App } from "obsidian";
import { createUiAction } from "../../core/ui/surface";
import { openExternalUrl } from "../../utils/externalUrl";

/**
 * The building blocks every tool card body is made of, so a read, a command, a
 * web search, a generated image and an unknown tool share one look: fields,
 * vault links, sources, a terminal, text, media thumbnails and one calm notice.
 */

type RecordValue = Record<string, unknown>;

export type ToolCardField = Readonly<{
  label: string;
  value: string;
  /** Vault-relative path: the value opens the file. */
  path?: string;
  /** http(s) address: the value opens in the browser. */
  url?: string;
  mono?: boolean;
  /** Several values (files, changes, queries), one per line in the value column. */
  list?: readonly ToolCardPathRow[];
}>;

/** One row of a list: a vault path that opens (link false: plain text), with an optional muted note. */
export type ToolCardPathRow = Readonly<{ path: string; text?: string; note?: string; link?: boolean }>;

export type ToolCardMedia = Readonly<{ kind: "image" | "video"; path: string; label?: string }>;

export type ToolCardNotice = Readonly<{
  /** gate: a plan or credits stop, the calm lock the whole-turn gate uses. */
  tone: "danger" | "warning" | "info" | "gate";
  text: string;
  action?: Readonly<{ label: string; url: string }>;
}>;

export type ToolCardLink = Readonly<{ title: string; url: string }>;

const NOTICE_ICONS: Readonly<Record<ToolCardNotice["tone"], string>> = {
  danger: "circle-alert",
  warning: "circle-alert",
  info: "info",
  gate: "lock",
};

/** "+3 −1", "+1", "−2": a change's added and removed lines, without a count of zero. */
export function changeCounts(stats: Readonly<{ additions: number; deletions: number }>): string {
  return [stats.additions ? `+${stats.additions}` : "", stats.deletions ? `−${stats.deletions}` : ""].filter(Boolean).join(" ") || "No changes";
}

/** A note as Obsidian names it, without ".md" ("Notes/Garden"); other files keep their extension. */
export function notePathText(path: string): string {
  return /.\.md$/iu.test(path) ? path.slice(0, -3) : path;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

/** The card body; every block below goes inside it with one rhythm. */
export function createToolCard(parent: HTMLElement, kind: string): HTMLElement {
  return parent.createDiv({ cls: "ss-tool-card", attr: { "data-card": kind } });
}

export function openVaultPath(app: App, path: string, event?: MouseEvent): void {
  event?.preventDefault();
  event?.stopPropagation();
  void app.workspace.openLinkText(path, "", false);
}

/**
 * A vault file that opens on click. A file that isn't there (not found, never
 * written, since deleted) is plain text: opening it would create an empty note.
 */
export function vaultLink(app: App, parent: HTMLElement, path: string, text = notePathText(path)): HTMLElement {
  if (app.vault.getAbstractFileByPath(path) === null) return parent.createSpan({ cls: "ss-tool-missing-path", text });
  const link = parent.createEl("a", {
    text,
    cls: "internal-link",
    attr: { href: path, "data-href": path, title: path },
  });
  link.onclick = event => openVaultPath(app, path, event);
  return link;
}

/** A vault folder, shown where it lives in the file explorer. */
export function folderLink(app: App, parent: HTMLElement, path: string, text = path): HTMLElement {
  const folder = app.vault.getAbstractFileByPath(path);
  if (!(folder instanceof TFolder)) return parent.createSpan({ cls: "ss-tool-path", text });
  const link = parent.createEl("a", {
    text,
    cls: "ss-tool-path ss-tool-folder-link",
    attr: { href: "#", title: `Show ${path} in the file explorer`, "data-folder": path },
  });
  link.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    void revealFolder(app, folder);
  };
  return link;
}

/** Shows a folder in the file explorer, loading the explorer first when its sidebar has not drawn it yet. */
export async function revealFolder(app: App, folder: TFolder): Promise<void> {
  const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!leaf) return;
  await app.workspace.revealLeaf(leaf);
  await (leaf as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
  const explorer = leaf.view as { revealInFolder?: (file: TFolder) => void };
  if (typeof explorer.revealInFolder === "function") explorer.revealInFolder(folder);
}

export function externalLink(parent: HTMLElement, url: string, text = url): HTMLAnchorElement {
  const link = parent.createEl("a", {
    text,
    cls: "external-link",
    attr: { href: url, title: url, rel: "noopener noreferrer", target: "_blank" },
  });
  link.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url, parent.ownerDocument.defaultView ?? undefined);
  };
  return link;
}

/** Label and value pairs: what the tool was asked, in words. */
export function renderFields(app: App, card: HTMLElement, fields: readonly ToolCardField[]): void {
  if (!fields.length) return;
  const list = card.createEl("dl", { cls: "ss-tool-fields" });
  for (const field of fields) {
    const row = list.createDiv({ cls: "ss-tool-field" });
    row.createEl("dt", { text: field.label });
    const value = row.createEl("dd");
    if (field.list?.length) renderPathList(app, value, field.list);
    else if (field.path) vaultLink(app, value, field.path, field.value);
    else if (field.url) externalLink(value, field.url, field.value);
    else if (field.mono) value.createEl("code", { text: field.value });
    else value.setText(field.value);
  }
}

/** Vault files and folders, one per row, each opening in the vault. */
export function renderPathList(
  app: App,
  card: HTMLElement,
  rows: readonly ToolCardPathRow[],
  limit = 50,
): void {
  if (!rows.length) return;
  const list = card.createEl("ul", { cls: "ss-tool-paths" });
  const append = (entries: typeof rows) => {
    for (const row of entries) {
      const item = list.createEl("li");
      if (row.link === false) item.createSpan({ cls: "ss-tool-path", text: row.text ?? row.path });
      else vaultLink(app, item, row.path, row.text ?? notePathText(row.path)).addClass("ss-tool-path");
      if (row.note) item.createSpan({ cls: "ss-tool-path-note", text: ` ·\u00a0${row.note}` });
    }
  };
  append(rows.slice(0, limit));
  if (rows.length > limit) {
    const all = createUiAction(card, { label: `Show all ${rows.length}`, testId: "chat.tool.show-items", size: "small", tooltip: false });
    all.addClass("ss-tool-more");
    all.onclick = () => { append(rows.slice(limit)); all.remove(); };
  }
}

/** Web sources: the page title as the link, its site beside it. */
export function renderLinks(card: HTMLElement, links: readonly ToolCardLink[]): void {
  if (!links.length) return;
  const list = card.createEl("ul", { cls: "ss-tool-links" });
  for (const link of links.slice(0, 20)) {
    const item = list.createEl("li");
    externalLink(item, link.url, link.title || hostOf(link.url));
    item.createSpan({ cls: "ss-tool-link-host", text: hostOf(link.url) });
  }
}

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./u, ""); } catch { return url; }
}

/** A command and the end of its output, the way a terminal shows it. */
export function renderTerminal(card: HTMLElement, options: Readonly<{ command?: string; output?: string; tailLines?: number }>): void {
  const output = options.output?.replace(/\s+$/u, "") ?? "";
  if (!options.command && !output) return;
  const tail = options.tailLines ?? 20;
  const block = card.createDiv({ cls: "ss-tool-terminal" });
  const pre = block.createEl("pre", { attr: { tabindex: "0" } });
  if (options.command) {
    const line = pre.createEl("code", { cls: "ss-tool-terminal-command" });
    line.createSpan({ cls: "ss-tool-terminal-prompt", text: "$ " });
    line.appendText(options.command);
  }
  if (output) {
    const lines = output.split("\n");
    const body = pre.createEl("code", { cls: "ss-tool-terminal-output", text: lines.length > tail ? lines.slice(-tail).join("\n") : output });
    if (lines.length > tail) {
      const all = createUiAction(card, { label: `Show all ${lines.length} lines`, testId: "chat.tool.show-output", size: "small", tooltip: false });
      all.addClass("ss-tool-more");
      all.onclick = () => { body.textContent = output; all.remove(); };
    }
  }
}

/** Prose a tool returned (a subagent's answer, an MCP result), in the reading font. */
export function renderText(card: HTMLElement, text: string, lineLimit = 8): void {
  const content = text.trim();
  if (!content) return;
  const block = card.createDiv({ cls: "ss-tool-text", text: content });
  const lines = content.split("\n").length;
  if (lines > lineLimit || content.length > lineLimit * 110) {
    block.addClass("is-clamped");
    block.setCssProps({ "--ss-tool-text-lines": String(lineLimit) });
    const all = createUiAction(card, { label: "Show all", testId: "chat.tool.show-text", size: "small", tooltip: false });
    all.addClass("ss-tool-more");
    all.onclick = () => { block.removeClass("is-clamped"); all.remove(); };
  }
}

/**
 * A file's content as written, from its first line: the box every card shows file text in. Text
 * the call wrote reads at full strength, like a diff's added lines; text found in a note stays muted.
 */
export function renderFileContent(card: HTMLElement, content: string, lineLimit = 20, written = false): void {
  if (!content) {
    card.createEl("p", { cls: "ss-tool-caption", text: "Empty" });
    return;
  }
  const lines = content.replace(/\n$/u, "").split("\n");
  const pre = card.createEl("pre", { cls: written ? "ss-tool-file-text is-written" : "ss-tool-file-text", attr: { tabindex: "0" } });
  const code = pre.createEl("code", { text: lines.slice(0, lineLimit).join("\n") });
  if (lines.length > lineLimit) {
    const all = createUiAction(card, { label: `Show all ${lines.length} lines`, testId: "chat.tool.show-output", size: "small", tooltip: false });
    all.addClass("ss-tool-more");
    all.onclick = () => { code.textContent = content; all.remove(); };
  }
}

/** One calm line for errors, gates and partial results: an icon, plain words and at most one action. */
export function renderNotice(card: HTMLElement, notice: ToolCardNotice): HTMLElement {
  const line = card.createDiv({ cls: `ss-tool-notice is-${notice.tone}`, attr: { "data-testid": "chat.tool.notice" } });
  if (notice.tone === "danger") line.setAttribute("role", "alert");
  const icon = line.createSpan({ cls: "ss-tool-notice-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, NOTICE_ICONS[notice.tone]);
  const copy = line.createSpan({ cls: "ss-tool-notice-text", text: notice.text });
  if (notice.action) {
    copy.appendText(" ");
    externalLink(copy, notice.action.url, notice.action.label).addClass("ss-tool-notice-action");
  }
  return line;
}

/**
 * A media file's name as people read it: chat names generated files by time
 * and prompt words, so the time stamp and extension drop off.
 */
export function mediaDisplayName(path: string, label?: string): string {
  if (label?.trim()) return label.trim();
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.[a-z0-9]{2,5}$/iu, "");
  return stem.replace(/^\d{4}-\d{2}-\d{2}[ _T]\d{4,6}\s+/u, "").trim() || stem;
}

const TURN_MEDIA_ITEM = ":scope > .systemsculpt-agent-turn-media [data-media-path]";

/**
 * Media the reply already shows full size is not shown again in its tool card:
 * the reply's own caption names and opens it. Runs when the reply's media
 * renders and when a card renders into its turn.
 */
export function syncToolMediaWithReply(turnBody: Element | null): void {
  if (!turnBody) return;
  const below = new Set(Array.from(turnBody.querySelectorAll(TURN_MEDIA_ITEM), item => item.getAttribute("data-media-path")));
  try {
    const shown: unknown = JSON.parse(turnBody.getAttribute("data-reply-media") ?? "[]");
    if (Array.isArray(shown)) for (const path of shown) if (typeof path === "string") below.add(path);
  } catch { /* An unreadable list hides nothing. */ }
  for (const media of Array.from(turnBody.querySelectorAll<HTMLElement>(".ss-tool-media"))) {
    const paths = Array.from(media.querySelectorAll("[data-media-path]"), tile => tile.getAttribute("data-media-path"));
    const shown = paths.length > 0 && paths.every(path => below.has(path));
    media.classList.toggle("is-shown-in-reply", shown);
  }
  // A failed generation's reason is its slim row under the call; the card doesn't say it again.
  const failed = new Set(Array.from(
    turnBody.querySelectorAll(":scope > .systemsculpt-agent-turn-media [data-pending-id$=':failed']"),
    tile => (tile.getAttribute("data-pending-id") ?? "").slice(0, -":failed".length),
  ));
  for (const notice of Array.from(turnBody.querySelectorAll<HTMLElement>(".ss-tool-notice[data-media-failure]"))) {
    notice.classList.toggle("is-shown-in-reply", failed.has(notice.getAttribute("data-media-failure") ?? ""));
  }
}

/** Thumbnails of generated or viewed media; each opens its vault file. */
export function renderMedia(app: App, card: HTMLElement, media: readonly ToolCardMedia[]): void {
  if (!media.length) return;
  // When the reply below shows the same files, the strip hides (syncToolMediaWithReply): the reply names them.
  const strip = card.createDiv({ cls: "ss-tool-media", attr: { "data-testid": "chat.tool.media" } });
  if (media.length > 1) {
    strip.addClass("is-multiple");
    strip.setCssProps({ "--ss-tool-media-columns": String(Math.min(media.length, 4)) });
  }
  for (const item of media) {
    const name = mediaDisplayName(item.path, item.label);
    const file = app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) {
      strip.createDiv({ cls: "ss-tool-media-tile is-missing", text: "Moved or deleted", attr: { title: item.path } });
      continue;
    }
    const tile = strip.createEl("button", {
      cls: `ss-tool-media-tile is-${item.kind}`,
      attr: { type: "button", title: item.path, "aria-label": `Open ${name}`, "data-testid": "chat.tool.media.open", "data-media-path": item.path },
    });
    const source = app.vault.getResourcePath(file);
    if (item.kind === "video") {
      // The first frame stands in for a poster; the video plays in the vault, not inside a tool card.
      tile.createEl("video", { attr: { src: `${source}#t=0.1`, preload: "metadata", muted: "", playsinline: "", tabindex: "-1", "aria-hidden": "true" } });
      const play = tile.createSpan({ cls: "ss-tool-media-play", attr: { "aria-hidden": "true" } });
      setIcon(play, "play");
    } else {
      tile.createEl("img", { attr: { src: source, alt: "", loading: "lazy", decoding: "async" } });
    }
    tile.onclick = event => openVaultPath(app, item.path, event);
  }
}

/** Raw request and result for whoever needs them; never the first thing a card shows. */
/**
 * A result as Details shows it: the plugin's "systemsculpt_tool" marker, which only lets Chat find
 * media in a saved result, is left out, so no call reads as one SystemSculpt ran when it didn't.
 * A saved chat nests the result under "data".
 */
export function detailsOutput(data: unknown): unknown {
  const unmarked = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("systemsculpt_tool" in value)) return value;
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    delete copy.systemsculpt_tool;
    return copy;
  };
  const outer = unmarked(data);
  if (!outer || typeof outer !== "object" || Array.isArray(outer) || !("data" in outer)) return outer;
  const record = outer as Record<string, unknown>;
  const inner = unmarked(record.data);
  return inner === record.data ? outer : { ...record, data: inner };
}

export function renderRawDetails(
  card: HTMLElement,
  payload: () => unknown,
  options: Readonly<{ open?: boolean; awaitingResult?: boolean }> = {},
): HTMLDetailsElement {
  const raw = card.createEl("details", { cls: "systemsculpt-agent-tool-raw" });
  // While a picture, video or Studio run is made, an open frame already has the height its result
  // fills, so nothing under it moves when the files land.
  raw.toggleClass("is-awaiting-result", Boolean(options.awaitingResult));
  const summary = raw.createEl("summary", { attr: { "data-testid": "chat.tool.raw" } });
  const chevron = summary.createSpan({ cls: "systemsculpt-agent-tool-raw-chevron", attr: { "aria-hidden": "true" } });
  setIcon(chevron, "chevron-right");
  summary.appendText("Details");
  const pre = raw.createEl("pre");
  // The code scrolls inside the frame's padding, so the frame never cuts a line and keeps its inset at both ends.
  const code = pre.createEl("code", { attr: { tabindex: "0" } });
  // A block taller than its frame fades at the bottom until scrolled to its end, so a cut line reads as "more below".
  const syncOverflow = (): void => {
    const overflowing = code.scrollHeight > code.clientHeight + 1;
    code.toggleClass("is-overflowing", overflowing);
    code.toggleClass("is-at-end", !overflowing || code.scrollTop + code.clientHeight >= code.scrollHeight - 1);
  };
  code.addEventListener("scroll", syncOverflow, { passive: true });
  // Measured again once it is laid out: opened inside a closed fold, it has no size yet.
  const view = pre.ownerDocument.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
  if (view?.ResizeObserver) new view.ResizeObserver(syncOverflow).observe(code);
  raw.addEventListener("toggle", () => {
    if (raw.open && !code.hasChildNodes()) renderJsonLines(code, JSON.stringify(payload(), null, 2));
    if (raw.open) syncOverflow();
  });
  // Opened before the result landed: it stays open, with the result in it.
  if (options.open) {
    raw.open = true;
    renderJsonLines(code, JSON.stringify(payload(), null, 2));
  }
  return raw;
}

/**
 * Indented text (JSON) one line per block, each keeping its leading spaces. A
 * long line wraps under its own start, two characters in, instead of falling
 * back to the left edge and breaking the tree. Copying keeps lines and spaces.
 */
export function renderJsonLines(code: HTMLElement, text: string): void {
  code.empty();
  code.addClass("ss-json-lines");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const indent = /^ */u.exec(line)?.[0].length ?? 0;
    const block = code.createSpan({ cls: "ss-json-line" });
    appendJsonLine(block, line);
    // The line's own end stays outside every piece, so a copy keeps the lines as they were.
    if (index < lines.length - 1) block.appendText("\n");
    if (indent) block.setCssProps({ "--ss-json-indent": String(indent) });
  });
}

/** A value this short moves whole after its key when the line can't hold both. */
const SHORT_VALUE = 32;

function appendJsonLine(block: HTMLElement, line: string): void {
  if (appendCommandLine(block, line)) return;
  // A short value ("2 Studio workflows.", "Notes/Archive") moves whole to the next line, never
  // leaving a word or a name behind on its key's line.
  const keyed = /^(\s*"(?:[^"\\]|\\.)*":\s)("(?:[^"\\]|\\.)*",?)$/u.exec(line);
  if (keyed && keyed[2].length <= SHORT_VALUE) {
    appendJsonWords(block, keyed[1]);
    appendJsonWords(block.createSpan({ cls: "ss-json-path" }), keyed[2]);
    return;
  }
  // Entries a value lists line by line ("a.md\nb.md", a read's numbered lines) each move to the next
  // line whole when they fit there, each with the "\n" that ends it; the first stays on its key's line.
  const entries = jsonLineEntries(line);
  appendJsonValue(block, entries[0], entries[0].length > SHORT_VALUE);
  for (const entry of entries.slice(1)) appendJsonValue(block.createSpan({ cls: "ss-json-path" }), entry, true);
}

/** A path breaks after a "/" and an escape ("\n") stays whole, so a wrapped value never splits a name. */
function appendJsonValue(parent: HTMLElement, text: string, breakable: boolean): void {
  if (breakable && /[/\\]/u.test(text)) appendBreakableValue(parent, text);
  else appendJsonWords(parent, text);
}

/** A line cut after each "\n" escape it holds; an escaped backslash before an "n" is no break. */
function jsonLineEntries(line: string): string[] {
  const entries: string[] = [];
  let start = 0;
  for (const match of line.matchAll(/\\./gu)) {
    const end = (match.index ?? 0) + match[0].length;
    if (match[0] !== "\\n" || end >= line.length) continue;
    entries.push(line.slice(start, end));
    start = end;
  }
  entries.push(line.slice(start));
  return entries;
}

/**
 * A command line ("rm -rf build && npm run build") breaks between its commands, after the
 * "&&", "||", "|" or ";" that joins them, never inside one that fits on a line. The closing
 * quote and comma stay on the last command. False when the line holds no joined commands.
 */
function appendCommandLine(block: HTMLElement, content: string): boolean {
  const line = /^(\s*"(?:command|cmd)":\s*")((?:[^"\\\n]|\\.)*)("[^\n]*)(\n?)$/u.exec(content);
  if (!line) return false;
  const [, opening, value, closing, end] = line;
  // Commands and the spaces between them, in turn; each joiner stays on the command before it.
  const pieces: string[] = [];
  let start = 0;
  for (const join of value.matchAll(/(?:\s(?:&&|\|\|?)|;)(\s+)/gu)) {
    const space = (join.index ?? 0) + join[0].length - join[1].length;
    pieces.push(value.slice(start, space), join[1]);
    start = space + join[1].length;
  }
  pieces.push(value.slice(start));
  if (pieces.length < 3) return false;
  block.appendText(opening);
  pieces.forEach((piece, index) => {
    if (index % 2) { block.appendText(piece); return; }
    const last = index === pieces.length - 1;
    appendJsonWords(block.createSpan({ cls: "ss-json-name" }), last ? `${piece}${closing}` : piece);
  });
  if (end) block.appendText(end);
  return true;
}

/**
 * A short hyphenated word ("2026-11-08", "T-5957", "--short") never breaks at its hyphen, and the
 * last two words of a run of three or more wrap together, so a wrapped run never ends on one word.
 */
function appendJsonWords(parent: HTMLElement, text: string): void {
  const pieces = text.split(/(\s+)/u).filter(Boolean);
  const words = pieces.flatMap((piece, index) => /\s/u.test(piece) ? [] : [index]);
  const from = words.length >= 3 ? words[words.length - 2] : -1;
  const to = words[words.length - 1] ?? -1;
  const pair = from >= 0 ? pieces.slice(from, to + 1).join("") : "";
  const paired = pair.length > 0 && pair.length <= 24;
  pieces.forEach((piece, index) => {
    if (paired && index >= from && index <= to) {
      if (index === from) parent.createSpan({ cls: "ss-json-whole", text: pair });
      return;
    }
    if (piece.length <= 24 && !/\s/u.test(piece) && piece.includes("-")) parent.createSpan({ cls: "ss-json-whole", text: piece });
    else parent.appendText(piece);
  });
}

/** A path listed after a colon or a comma ("…vault: Images/take 1.png, Images/take 2.png"), to its file name. */
const LISTED_PATH = /(: |, )((?:[^\s"/,:\\][^"/,:\\\n]{0,40}\/)+[^\s"/\\][^"/\\\n]*?\.[\p{L}\d]{1,5})(?=[,.;]?(?:$|[\s"'),\]]))/gu;

function appendBreakableValue(block: HTMLElement, content: string): void {
  // Each listed path is one piece with its comma or full stop: it moves to the next line whole when it
  // fits there, so a line never pairs one file's name with the next one's folder. Only a path wider
  // than the line breaks inside, after a "/". A value that is one path keeps its key on its line.
  let start = 0;
  for (const match of content.matchAll(LISTED_PATH)) {
    const at = (match.index ?? 0) + match[1].length;
    const end = at + match[2].length + (/^(?:[,.;]|"[,.;]?)/u.exec(content.slice(at + match[2].length))?.[0].length ?? 0);
    appendBreakableRun(block, content.slice(start, at));
    appendBreakableRun(block.createSpan({ cls: "ss-json-path" }), content.slice(at, end));
    start = end;
  }
  appendBreakableRun(block, content.slice(start));
}

function appendBreakableRun(block: HTMLElement, content: string): void {
  // The name after a "/" ("lighthouse take 1.png,") moves to the next line whole when it fits there,
  // rather than leaving its last word behind. Prose (the key, a sentence after a comma) flows as it is.
  const appendChunk = (chunk: string, afterSlash: boolean): void => {
    if (!chunk) return;
    // The line's own end stays outside the name.
    const trail = /\s*$/u.exec(chunk)![0];
    let name = chunk.slice(0, chunk.length - trail.length);
    // The whole piece when it fits on a line, or else the file name that starts it ("Poster image.png"
    // in "Poster image.png. The chat already…").
    const whole = !afterSlash ? undefined : name.length <= 48 ? name
      : /^[^\s/][^/\n]{0,46}?\.[\p{L}\d]{1,5}(?=$|[\s"',.;:)\]])/u.exec(name)?.[0];
    if (whole && /\S\s+\S/u.test(whole)) {
      appendJsonWords(block.createSpan({ cls: "ss-json-name" }), whole);
      name = name.slice(whole.length);
    }
    appendJsonWords(block, name);
    if (trail) block.appendText(trail);
  };
  let start = 0;
  let afterSlash = false;
  for (const match of content.matchAll(/\\[^\n]|\/|,(?= )/gu)) {
    const at = match.index ?? 0;
    const end = at + match[0].length;
    // A list's comma stays on its name; the space after it is where the next line may start.
    if (match[0] === ",") { appendChunk(content.slice(start, end), afterSlash); start = end; afterSlash = false; continue; }
    appendChunk(content.slice(start, at), afterSlash);
    if (match[0] === "/") block.appendText("/");
    else block.createSpan({ cls: "ss-json-whole", text: match[0] });
    // After a slash or a line break escape, a wrapped line may start; never inside either, and never
    // after a tab, which stays with the words it leads ("3\tTomatoes").
    if (match[0] === "/" || /^\\[nr]$/u.test(match[0])) block.createEl("wbr");
    afterSlash = match[0] === "/";
    start = end;
  }
  appendChunk(content.slice(start), afterSlash);
}

/** The text inside a tool result as each agent saves it: a string, content blocks or content items. */
export function toolOutputText(output: unknown, depth = 0): string {
  if (depth > 3 || output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map(item => {
      const entry = record(item);
      if (typeof entry.text === "string" && (!entry.type || entry.type === "text" || entry.type === "inputText" || entry.type === "outputText")) return entry.text;
      return typeof item === "string" ? item : "";
    }).filter(Boolean).join("\n");
  }
  const data = record(output);
  for (const key of ["aggregatedOutput", "output", "content", "contentItems", "text", "result", "message"]) {
    const text = toolOutputText(data[key], depth + 1);
    if (text) return text;
  }
  return "";
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  url: "Address",
  uri: "Address",
  q: "Search for",
  query: "Search for",
  prompt: "Prompt",
  file_path: "File",
  path: "Path",
  subagent_type: "Agent",
  cwd: "Folder",
};

/** "file_path" → "File", "maxResults" → "Max results". */
export function humanizeKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const words = key.replace(/([a-z\d])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function shortValue(value: unknown): { value: string; mono: boolean } | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/gu, " ").trim();
    if (!normalized) return null;
    return { value: normalized.length > 280 ? `${normalized.slice(0, 279).trimEnd()}…` : normalized, mono: false };
  }
  if (typeof value === "number" || typeof value === "boolean") return { value: typeof value === "boolean" ? value ? "Yes" : "No" : String(value), mono: false };
  if (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number")) {
    const joined = value.join(", ");
    return joined ? { value: joined.length > 280 ? `${joined.slice(0, 279)}…` : joined, mono: false } : null;
  }
  const json = JSON.stringify(value);
  if (!json || json === "{}" || json === "[]") return null;
  return { value: json.length > 160 ? `${json.slice(0, 159)}…` : json, mono: true };
}

/** A tool we have no card for still reads as words: its input as labelled fields, never an apology. */
export function inputFields(input: unknown, options: Readonly<{ skip?: readonly string[]; limit?: number }> = {}): ToolCardField[] {
  const skip = new Set(["type", "id", "status", ...(options.skip ?? [])]);
  const fields: ToolCardField[] = [];
  for (const [key, raw] of Object.entries(record(input))) {
    if (skip.has(key)) continue;
    const shown = shortValue(raw);
    if (!shown) continue;
    const url = typeof raw === "string" && /^https?:\/\//iu.test(raw.trim()) ? raw.trim() : undefined;
    fields.push({ label: humanizeKey(key), value: shown.value, ...(url ? { url } : {}), ...(shown.mono ? { mono: true } : {}) });
    if (fields.length >= (options.limit ?? 6)) break;
  }
  return fields;
}
