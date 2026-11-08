import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { decodeSystemSculptToolOutput, systemSculptToolName, type SystemSculptMedia } from "../../tools/systemsculpt/SystemSculptTools";
import { codexImageMedia, rememberCodexImage } from "../../services/codex/CodexImages";

type TurnMedia = Readonly<{
  media: readonly SystemSculptMedia[];
  /** A one-line next step such as Subscribe, from a tool the account can't use yet. */
  notices: readonly Readonly<{ text: string; label: string; url: string }>[];
}>;

/** Whether the reply already embeds this file (`![](path)`, `![](<path>)` or `![[path]]`). */
function embeddedInAnswer(answer: string, path: string): boolean {
  if (!answer.includes("![")) return false;
  const name = path.split("/").pop() ?? path;
  for (const match of answer.matchAll(/!\[\[([^\]|#]+)|!\[[^\]]*\]\(\s*<?([^>)]+?)>?\s*\)/gu)) {
    const target = decodeURI((match[1] ?? match[2] ?? "").trim()).replace(/^\.?\//u, "");
    if (target === path || target.endsWith(`/${path}`) || target === name) return true;
  }
  return false;
}

/**
 * Generated images and videos (and Subscribe lines) from this turn's
 * SystemSculpt tool results. A file the reply already embeds shows once, in
 * the reply.
 */
/** @internal Exported for tests. */
export function presentTurnMedia(parts: readonly AgentToolPart[], answer = ""): TurnMedia {
  const media = new Map<string, SystemSculptMedia>();
  const notices = new Map<string, { text: string; label: string; url: string }>();
  for (const part of parts) {
    // Codex's own image tools: a generated image always shows; a viewed one shows when the reply points at it.
    const image = codexImageMedia(part);
    if (image) {
      // Codex names each image file uniquely, so its file name alone finds a link to it.
      const linked = [image.media.path, image.sourcePath?.split(/[\\/]/u).pop()].some(path => path && (answer.includes(path) || answer.includes(encodeURI(path))));
      if ((image.item === "imageGeneration" || linked) && !embeddedInAnswer(answer, image.media.path)) media.set(image.media.path, image.media);
      continue;
    }
    if (!systemSculptToolName(part.name) || (part.state !== "succeeded" && part.state !== "failed")) continue;
    const result = decodeSystemSculptToolOutput(part.output?.data);
    if (!result) continue;
    for (const item of result.media ?? []) if (!embeddedInAnswer(answer, item.path)) media.set(item.path, item);
    if (result.link) {
      // The line is the message's first part; what follows the link is guidance for the agent.
      const text = result.message.split(`${result.link.label}:`)[0].trim();
      notices.set(`${result.link.url}\n${text}`, { text, label: result.link.label, url: result.link.url });
    }
  }
  return { media: [...media.values()], notices: [...notices.values()] };
}

type TurnMediaActions = Readonly<{
  openFile: (path: string) => void;
  openLink: (url: string) => void;
}>;

/**
 * Keeps one media block per turn, rebuilt only when its content changes, so a
 * playing video or a focused link survives later renders.
 */
export function renderTurnMedia(app: App, parent: HTMLElement, parts: readonly AgentToolPart[], actions: TurnMediaActions, answer = ""): HTMLElement | null {
  const existing = parent.querySelector<HTMLElement>(":scope > .systemsculpt-agent-turn-media");
  // A saved chat's reply can still link Codex's own copy; its link opens the vault copy.
  for (const part of parts) {
    const image = codexImageMedia(part);
    if (image?.sourcePath) rememberCodexImage(image.sourcePath, image.media.path);
  }
  const presented = presentTurnMedia(parts, answer);
  if (!presented.media.length && !presented.notices.length) {
    existing?.remove();
    return null;
  }
  const fingerprint = JSON.stringify(presented);
  if (existing?.dataset.media === fingerprint) return existing;
  existing?.remove();
  const block = parent.createDiv({ cls: "systemsculpt-agent-turn-media", attr: { "data-testid": "chat.turn.media" } });
  block.dataset.media = fingerprint;
  if (presented.media.length) {
    const grid = block.createDiv({ cls: "systemsculpt-agent-media-grid" });
    if (presented.media.length > 1) grid.addClass("is-multiple");
    for (const item of presented.media) {
      const file = app.vault.getAbstractFileByPath(item.path);
      const name = item.label ?? item.path.split("/").pop() ?? item.path;
      const figure = grid.createEl("figure", { cls: "systemsculpt-agent-media", attr: { "data-kind": item.kind } });
      if (!(file instanceof TFile)) {
        figure.addClass("is-missing");
        figure.createDiv({ cls: "systemsculpt-agent-media-missing", text: `${name} was moved or deleted.` });
        continue;
      }
      const source = app.vault.getResourcePath(file);
      if (item.kind === "video") {
        figure.createEl("video", { cls: "systemsculpt-agent-media-frame", attr: { src: source, controls: "", preload: "metadata", playsinline: "", "aria-label": name } });
      } else {
        const open = figure.createEl("button", { cls: "systemsculpt-agent-media-open", attr: { type: "button", "aria-label": `Open ${name}`, "data-testid": "chat.turn.media.open" } });
        open.createEl("img", { cls: "systemsculpt-agent-media-frame", attr: { src: source, alt: name, loading: "lazy", decoding: "async" } });
        open.onclick = () => actions.openFile(item.path);
      }
      const caption = figure.createEl("figcaption", { cls: "systemsculpt-agent-media-caption" });
      const link = caption.createEl("a", { text: name, attr: { href: item.path, title: item.path, "data-testid": "chat.turn.media.path" } });
      link.onclick = event => { event.preventDefault(); actions.openFile(item.path); };
    }
  }
  for (const notice of presented.notices) {
    const line = block.createDiv({ cls: "systemsculpt-agent-media-notice", attr: { "data-testid": "chat.turn.media.notice" } });
    if (notice.text) line.appendText(`${notice.text} `);
    const link = line.createEl("a", { text: notice.label, attr: { href: notice.url, "data-testid": "chat.turn.media.subscribe" } });
    link.onclick = event => { event.preventDefault(); actions.openLink(notice.url); };
  }
  return block;
}
