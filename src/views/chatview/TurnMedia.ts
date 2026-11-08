import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { decodeSystemSculptToolOutput, systemSculptToolName, type SystemSculptMedia } from "../../tools/systemsculpt/SystemSculptTools";
import { codexImageMedia, rememberCodexImage } from "../../services/codex/CodexImages";
import { fitPendingText, generationArguments, presentPendingMedia, renderPendingMedia, requestedMediaRatio, syncPendingClock, type PendingMedia } from "./PendingMedia";

/** A file to show, with where its call sits in the turn and the frame its call asked for. */
/** `fixed`: the ratio was asked for, so the file keeps that frame even if it comes back another shape. */
type TurnMediaItem = SystemSculptMedia & Readonly<{ order?: number; ratio?: number; fixed?: boolean }>;

type TurnMedia = Readonly<{
  media: readonly TurnMediaItem[];
  /** Generations still running (live turns) or failed, drawn where their result goes. */
  pending: readonly PendingMedia[];
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
export function presentTurnMedia(parts: readonly AgentToolPart[], answer = "", live = false): TurnMedia {
  const media = new Map<string, TurnMediaItem>();
  const notices = new Map<string, { text: string; label: string; url: string }>();
  for (const [order, part] of parts.entries()) {
    // Codex's own image tools: a generated image always shows; a viewed one shows when the reply points at it.
    const image = codexImageMedia(part);
    if (image) {
      // Codex names each image file uniquely, so its file name alone finds a link to it.
      const linked = [image.media.path, image.sourcePath?.split(/[\\/]/u).pop()].some(path => path && (answer.includes(path) || answer.includes(encodeURI(path))));
      if ((image.item === "imageGeneration" || linked) && !embeddedInAnswer(answer, image.media.path)) {
        media.set(image.media.path, { ...image.media, order, ...(image.item === "imageGeneration" ? { ratio: 1 } : {}) });
      }
      continue;
    }
    if (!systemSculptToolName(part.name) || (part.state !== "succeeded" && part.state !== "failed")) continue;
    const result = decodeSystemSculptToolOutput(part.output?.data);
    if (!result) continue;
    const tool = systemSculptToolName(part.name);
    // A generated file opens in the frame its placeholder had, so it lands without a jump.
    const ratio = tool === "generate_image" || tool === "generate_video" ? requestedMediaRatio(tool, generationArguments(part)) : undefined;
    for (const item of result.media ?? []) if (!embeddedInAnswer(answer, item.path)) media.set(item.path, { ...item, order, ...(ratio ? { ratio, fixed: true } : {}) });
    if (result.link) {
      // The line is the message's first part; what follows the link is guidance for the agent.
      const text = result.message.split(`${result.link.label}:`)[0].trim();
      notices.set(`${result.link.url}\n${text}`, { text, label: result.link.label, url: result.link.url });
    }
  }
  return { media: [...media.values()], pending: presentPendingMedia(parts, live), notices: [...notices.values()] };
}

type TurnMediaActions = Readonly<{
  openFile: (path: string) => void;
  openLink: (url: string) => void;
}>;

/**
 * Keeps one media block per turn, rebuilt only when its content changes, so a
 * playing video or a focused link survives later renders.
 */
export function renderTurnMedia(app: App, parent: HTMLElement, parts: readonly AgentToolPart[], actions: TurnMediaActions, answer = "", live = false): HTMLElement | null {
  const existing = parent.querySelector<HTMLElement>(":scope > .systemsculpt-agent-turn-media");
  // A saved chat's reply can still link Codex's own copy; its link opens the vault copy.
  for (const part of parts) {
    const image = codexImageMedia(part);
    if (image?.sourcePath) rememberCodexImage(image.sourcePath, image.media.path);
  }
  const presented = presentTurnMedia(parts, answer, live);
  if (!presented.media.length && !presented.pending.length && !presented.notices.length) {
    existing?.remove();
    return null;
  }
  const fingerprint = JSON.stringify(presented);
  if (existing?.dataset.media === fingerprint) return existing;
  // Landed media moves into the new block as is: no reload, blink or restarted video.
  const landed = new Map<string, HTMLElement>();
  existing?.querySelectorAll<HTMLElement>("figure.is-loaded[data-media-path]").forEach(figure => landed.set(figure.dataset.mediaPath ?? "", figure));
  existing?.remove();
  const block = parent.createDiv({ cls: "systemsculpt-agent-turn-media", attr: { "data-testid": "chat.turn.media" } });
  block.dataset.media = fingerprint;
  const tiles = [
    ...presented.media.map(item => ({ order: item.order ?? -1, item, pending: null })),
    ...presented.pending.map(tile => ({ order: tile.order, item: null, pending: tile })),
  ].sort((left, right) => left.order - right.order);
  if (tiles.length) {
    const grid = block.createDiv({ cls: "systemsculpt-agent-media-grid" });
    if (tiles.length > 1) grid.addClass("is-multiple");
    for (const { item, pending } of tiles) {
      if (pending) {
        renderPendingMedia(grid, pending);
        continue;
      }
      if (!item) continue;
      const kept = landed.get(item.path);
      if (kept && kept.dataset.kind === item.kind) {
        grid.appendChild(kept);
        continue;
      }
      const file = app.vault.getAbstractFileByPath(item.path);
      const name = item.label ?? item.path.split("/").pop() ?? item.path;
      const figure = grid.createEl("figure", { cls: "systemsculpt-agent-media", attr: { "data-kind": item.kind, "data-media-path": item.path } });
      if (!(file instanceof TFile)) {
        figure.addClass("is-missing");
        figure.createDiv({ cls: "systemsculpt-agent-media-missing", text: `${name} was moved or deleted.` });
        continue;
      }
      const source = app.vault.getResourcePath(file);
      const ratio = item.fixed ? item.ratio : naturalRatios.get(item.path) ?? item.ratio;
      if (ratio) {
        figure.addClass("has-ratio");
        if (item.fixed) figure.dataset.ratio = "fixed";
        figure.setCssProps({ "--ss-media-ratio": String(ratio) });
      }
      if (item.kind === "video") {
        const video = figure.createEl("video", { cls: "systemsculpt-agent-media-frame", attr: { src: source, controls: "", preload: "metadata", playsinline: "", "aria-label": name } });
        settleFrame(figure, video, () => [video.videoWidth, video.videoHeight], "loadedmetadata");
      } else {
        const open = figure.createEl("button", { cls: "systemsculpt-agent-media-open", attr: { type: "button", "aria-label": `Open ${name}`, "data-testid": "chat.turn.media.open" } });
        // Until the file decodes, the frame keeps the placeholder's sheen.
        if (item.ratio) open.createSpan({ cls: "ss-media-pending-sheen", attr: { "aria-hidden": "true" } });
        const image = open.createEl("img", { cls: "systemsculpt-agent-media-frame", attr: { src: source, alt: name, loading: "lazy", decoding: "async" } });
        settleFrame(figure, image, () => [image.naturalWidth, image.naturalHeight], "load");
        open.onclick = () => actions.openFile(item.path);
      }
      // One line, like the placeholder's, so the tile keeps its height when the file lands.
      const caption = figure.createEl("figcaption", { cls: `systemsculpt-agent-media-caption${ratio ? " is-single-line" : ""}` });
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
  syncPendingClock(block);
  fitPendingText(block);
  return block;
}

/**
 * A generated file sits in its requested frame until its own size is known,
 * then the frame takes the file's exact shape and the file fades in.
 */
/** Each file's own shape once seen, so a reopened chat draws it at its size from the start. */
const naturalRatios = new Map<string, number>();

function settleFrame(figure: HTMLElement, frame: HTMLImageElement | HTMLVideoElement, size: () => [number, number], event: "load" | "loadedmetadata"): void {
  const settle = () => {
    const [width, height] = size();
    if (figure.hasClass("has-ratio") && figure.dataset.ratio !== "fixed" && width > 0 && height > 0) {
      figure.setCssProps({ "--ss-media-ratio": String(width / height) });
      if (naturalRatios.size > 500) naturalRatios.clear();
      naturalRatios.set(figure.dataset.mediaPath ?? "", width / height);
    }
    figure.addClass("is-loaded");
  };
  frame.addEventListener(event, settle, { once: true });
  // A file that cannot be shown still ends the sheen; the browser draws its broken state.
  frame.addEventListener("error", () => figure.addClass("is-loaded", "is-broken"), { once: true });
  const ready = frame.tagName === "IMG" ? (frame as HTMLImageElement).complete && (frame as HTMLImageElement).naturalWidth > 0 : (frame as HTMLVideoElement).readyState >= 1;
  if (ready) settle();
}
