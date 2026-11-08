import { setIcon, TFile, type App } from "obsidian";
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
}>;

export type ToolCardMedia = Readonly<{ kind: "image" | "video"; path: string; label?: string }>;

export type ToolCardNotice = Readonly<{
  tone: "danger" | "warning" | "info";
  text: string;
  action?: Readonly<{ label: string; url: string }>;
}>;

export type ToolCardLink = Readonly<{ title: string; url: string }>;

const NOTICE_ICONS: Readonly<Record<ToolCardNotice["tone"], string>> = {
  danger: "circle-alert",
  warning: "circle-alert",
  info: "info",
};

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

export function vaultLink(app: App, parent: HTMLElement, path: string, text = path): HTMLAnchorElement {
  const exists = app.vault.getAbstractFileByPath(path) !== null;
  const link = parent.createEl("a", {
    text,
    cls: `internal-link${exists ? "" : " is-unresolved"}`,
    attr: { href: path, "data-href": path, title: path },
  });
  link.onclick = event => openVaultPath(app, path, event);
  return link;
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
    if (field.path) vaultLink(app, value, field.path, field.value);
    else if (field.url) externalLink(value, field.url, field.value);
    else if (field.mono) value.createEl("code", { text: field.value });
    else value.setText(field.value);
  }
}

/** Vault files and folders, one per row, each opening in the vault. */
export function renderPathList(
  app: App,
  card: HTMLElement,
  rows: readonly Readonly<{ path: string; text?: string; note?: string; link?: boolean }>[],
  limit = 50,
): void {
  if (!rows.length) return;
  const list = card.createEl("ul", { cls: "ss-tool-paths" });
  const append = (entries: typeof rows) => {
    for (const row of entries) {
      const item = list.createEl("li");
      if (row.link === false) item.createSpan({ cls: "ss-tool-path", text: row.text ?? row.path });
      else vaultLink(app, item, row.path, row.text ?? row.path).addClass("ss-tool-path");
      if (row.note) item.createSpan({ cls: "ss-tool-path-note", text: ` · ${row.note}` });
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

/** Thumbnails of generated or viewed media; each opens its vault file. */
export function renderMedia(app: App, card: HTMLElement, media: readonly ToolCardMedia[]): void {
  if (!media.length) return;
  const strip = card.createDiv({ cls: "ss-tool-media", attr: { "data-testid": "chat.tool.media" } });
  if (media.length > 1) {
    strip.addClass("is-multiple");
    strip.setCssProps({ "--ss-tool-media-columns": String(Math.min(media.length, 4)) });
  }
  for (const item of media) {
    const name = item.label ?? item.path.split("/").pop() ?? item.path;
    const file = app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) {
      strip.createDiv({ cls: "ss-tool-media-tile is-missing", text: "Moved or deleted", attr: { title: item.path } });
      continue;
    }
    const tile = strip.createEl("button", {
      cls: `ss-tool-media-tile is-${item.kind}`,
      attr: { type: "button", title: name, "aria-label": `Open ${name}`, "data-testid": "chat.tool.media.open" },
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
export function renderRawDetails(card: HTMLElement, payload: () => unknown): void {
  const raw = card.createEl("details", { cls: "systemsculpt-agent-tool-raw" });
  const summary = raw.createEl("summary", { attr: { "data-testid": "chat.tool.raw" } });
  const chevron = summary.createSpan({ cls: "systemsculpt-agent-tool-raw-chevron", attr: { "aria-hidden": "true" } });
  setIcon(chevron, "chevron-right");
  summary.appendText("Details");
  const code = raw.createEl("pre", { attr: { tabindex: "0" } }).createEl("code");
  raw.addEventListener("toggle", () => {
    if (raw.open && !code.hasChildNodes()) code.setText(JSON.stringify(payload(), null, 2));
  });
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
