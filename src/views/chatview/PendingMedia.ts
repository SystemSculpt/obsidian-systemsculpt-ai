import { setIcon } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { codexImageMedia } from "../../services/codex/CodexImages";
import { generationKey, generationProgress } from "../../tools/systemsculpt/GenerationProgress";
import { decodeSystemSculptToolOutput, systemSculptToolName, type SystemSculptToolResult } from "../../tools/systemsculpt/SystemSculptTools";
import { formatAgentWorkingDuration } from "./AgentActivityPresentation";
import { isActiveAgentToolState } from "./AgentConversationPresentation";
import { presentAgentToolFailure } from "./AgentToolPresentation";

type RecordValue = Record<string, unknown>;

/**
 * A generation Chat is waiting for, or one that failed: drawn in the turn's
 * media grid at the size its result will have, so the image or video lands in
 * place.
 */
export type PendingMedia = Readonly<{
  /** Stable per call and output: `${callId}:${index}`. */
  id: string;
  /** Where the call sits in the turn, so tiles keep their order as they finish. */
  order: number;
  kind: "image" | "video" | "workflow";
  /** Width over height. */
  ratio: number;
  state: "working" | "saving" | "failed";
  label: string;
  caption?: string;
  error?: string;
  /** Key of the live progress the call reports here. */
  progressKey: string | null;
  callId: string;
}>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/gu, " ").trim() : undefined;
}

/** A Codex dynamic call stores its whole item; the tool's own arguments sit inside it. */
export function generationArguments(part: AgentToolPart): RecordValue {
  const input = record(part.input);
  return input.type === "dynamicToolCall" ? { ...input, ...record(input.arguments) } : input;
}

/** Width over height for "16:9", "9:16", "1024x1536" and the like; null when unreadable. */
export function parseAspectRatio(value: unknown): number | null {
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/u.exec(value) : null;
  if (!match) {
    const word = typeof value === "string" ? value.trim().toLowerCase() : "";
    return word === "square" ? 1 : word === "landscape" ? 3 / 2 : word === "portrait" ? 2 / 3 : null;
  }
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(4, Math.max(0.25, ratio)) : null;
}

/** The frame a generate call's result will fill: its requested ratio, else square images and wide videos. */
export function requestedMediaRatio(tool: "generate_image" | "generate_video", args: RecordValue): number {
  return parseAspectRatio(args.aspect_ratio) ?? (tool === "generate_video" ? 16 / 9 : 1);
}

/** Plugin replies that are not a failure to show: the person stopped or declined the call. */
const QUIET_RESULTS = [/^Stopped\.$/u, /^Declined in chat\b/u, /^Read only:/u];

function failureText(result: SystemSculptToolResult): string {
  return result.message.split(/\s*The chat already shows\b/u)[0].trim();
}

function codexFailure(part: AgentToolPart): string | undefined {
  const failure = record(part.output?.data);
  if (failure.type === "usageLimitExceeded") {
    const resetsAt = typeof failure.resetsAt === "number" ? new Date(failure.resetsAt * 1_000) : null;
    const when = resetsAt && Number.isFinite(resetsAt.getTime())
      ? ` until ${resetsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
    return `Codex image limit reached${when}.`;
  }
  return text(part.output?.summary) ?? text(record(part.output?.data).message) ?? (part.error ? presentAgentToolFailure(part) : undefined);
}

/**
 * The generations to draw as placeholders (live turns only) and the ones that
 * failed. A failed call that a later call of the same kind made up for shows
 * nothing; the gated ones (Subscribe, Buy credits) already have their own line.
 */
export function presentPendingMedia(parts: readonly AgentToolPart[], live: boolean): PendingMedia[] {
  const pending: PendingMedia[] = [];
  parts.forEach((part, order) => {
    const active = live && isActiveAgentToolState(part.state);
    const finished = part.state === "succeeded" || part.state === "failed";
    const tool = systemSculptToolName(part.name);
    if (tool === "generate_image" || tool === "generate_video" || tool === "studio_run_workflow") {
      const args = generationArguments(part);
      const prompt = text(args.prompt);
      const progressKey = generationKey(tool, args);
      const base = { order, progressKey, callId: part.callId };
      if (tool === "studio_run_workflow") {
        const path = text(args.path);
        const name = path ? (path.split("/").pop() ?? path).replace(/\.systemsculpt$/iu, "") : "workflow";
        if (active) pending.push({ ...base, id: `${part.callId}:0`, kind: "workflow", ratio: 0, state: "working", label: `Running ${name}` });
        return;
      }
      const kind = tool === "generate_video" ? "video" : "image";
      const ratio = requestedMediaRatio(tool, args);
      const count = tool === "generate_image" && typeof args.count === "number" ? Math.min(4, Math.max(1, Math.floor(args.count))) : 1;
      if (active) {
        for (let index = 0; index < count; index += 1) {
          pending.push({
            ...base, id: `${part.callId}:${index}`, kind, ratio, state: "working",
            label: count > 1 ? `Image ${index + 1} of ${count}` : `Generating ${kind}`,
            ...(prompt ? { caption: prompt } : {}),
          });
        }
        return;
      }
      if (!finished || part.state === "succeeded" && !part.output) return;
      const result = decodeSystemSculptToolOutput(part.output?.data);
      if (result?.ok || result?.link || result && QUIET_RESULTS.some(pattern => pattern.test(result.message))) return;
      if (!result && part.state !== "failed") return;
      // Without a reason of its own the turn's error already explains it.
      const error = result ? failureText(result) : part.error ? presentAgentToolFailure(part) : undefined;
      if (!error) return;
      pending.push({
        ...base, id: `${part.callId}:failed`, kind, ratio, state: "failed",
        label: `The ${kind} wasn't made`, error, ...(prompt ? { caption: prompt } : {}),
      });
      return;
    }
    // Codex's own image tool: it says nothing until done, then Chat saves the file.
    const input = record(part.input);
    if (part.native?.agent !== "codex" || input.type !== "imageGeneration") return;
    const base = { order, progressKey: null, callId: part.callId, kind: "image" as const, ratio: 1, caption: "Codex image" };
    if (active) {
      pending.push({ ...base, id: `${part.callId}:0`, state: "working", label: "Generating image" });
      return;
    }
    if (codexImageMedia(part)) return;
    // Succeeded with no output yet: Chat is still saving the file into the vault.
    if (live && part.state === "succeeded" && !part.output) {
      pending.push({ ...base, id: `${part.callId}:0`, state: "saving", label: "Saving image" });
      return;
    }
    if (!finished) return;
    const error = codexFailure(part);
    if (error) pending.push({ ...base, id: `${part.callId}:failed`, state: "failed", label: "The image wasn't made", error });
  });
  // A failure the agent made up for later in the turn is history, not news.
  return pending.filter(tile => tile.state !== "failed"
    || !parts.slice(tile.order + 1).some(later => later.state === "succeeded" && later.name === parts[tile.order].name));
}

/** First time this session saw each call running, for calls with no reported start. */
const firstSeen = new Map<string, number>();

function startedAt(tile: PendingMedia, now: number): number {
  const reported = generationProgress(tile.progressKey)?.startedAt;
  if (reported !== undefined) return reported;
  const seen = firstSeen.get(tile.callId);
  if (seen !== undefined) return seen;
  if (firstSeen.size > 200) firstSeen.clear();
  firstSeen.set(tile.callId, now);
  return now;
}

function roughly(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** The live line under the label and the bar's fill, from what the job reports. */
export function pendingStatus(tile: PendingMedia, now: number): Readonly<{ meta: string; fraction: number | null }> {
  const elapsed = Math.max(0, now - startedAt(tile, now));
  const duration = formatAgentWorkingDuration(elapsed) ?? "0s";
  const progress = generationProgress(tile.progressKey);
  if (tile.kind === "workflow") return { meta: progress?.step ? `${progress.step} · ${duration}` : duration, fraction: null };
  if (progress?.status === "queued") return { meta: `Queued · ${duration}`, fraction: null };
  const typical = progress?.typicalDurationMs;
  if (!typical || typical <= 0 || tile.state !== "working") return { meta: duration, fraction: null };
  const share = elapsed / typical;
  // Steady to 90 % across the usual time, then slower; it never claims done.
  const fraction = share < 1 ? 0.9 * share : 0.9 + 0.08 * (1 - Math.exp(-(share - 1) * 2));
  const left = typical - elapsed;
  const meta = left >= 10_000 ? `${duration} · about ${roughly(left)} left`
    : share < 1.5 ? `${duration} · almost done` : duration;
  return { meta, fraction };
}

const ICONS: Readonly<Record<PendingMedia["kind"], string>> = { image: "image", video: "film", workflow: "workflow" };

/** One placeholder or failure tile; its live line and bar update from the block's clock. */
export function renderPendingMedia(grid: HTMLElement, tile: PendingMedia): HTMLElement {
  const figure = grid.createEl("figure", {
    cls: `systemsculpt-agent-media is-pending is-${tile.state}`,
    attr: { "data-kind": tile.kind, "data-pending-id": tile.id, "data-testid": "chat.turn.media.pending" },
  });
  if (tile.kind !== "workflow") {
    figure.addClass("has-ratio");
    figure.setCssProps({ "--ss-media-ratio": String(tile.ratio) });
  }
  if (tile.state !== "failed") figure.setAttribute("aria-busy", "true");
  const frame = figure.createDiv({ cls: "ss-media-pending-frame" });
  if (tile.state !== "failed") frame.createSpan({ cls: "ss-media-pending-sheen", attr: { "aria-hidden": "true" } });
  const icon = frame.createSpan({ cls: "ss-media-pending-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, tile.state === "failed" ? "image-off" : ICONS[tile.kind]);
  const status = frame.createDiv({ cls: "ss-media-pending-status" });
  if (tile.state === "failed") {
    // The reason is the headline; what to do next is the one line under it.
    figure.setAttribute("role", "status");
    status.createSpan({ cls: "ss-media-pending-label", text: tile.error ?? tile.label, attr: { title: tile.error ?? tile.label } });
    status.createSpan({ cls: "ss-media-pending-meta", text: "Ask again to retry." });
  } else {
    status.createSpan({ cls: "ss-media-pending-label", text: tile.label });
    status.createSpan({ cls: "ss-media-pending-meta", attr: { "data-testid": "chat.turn.media.pending.meta" } });
    frame.createSpan({ cls: "ss-media-pending-bar", attr: { "aria-hidden": "true" } }).createSpan({ cls: "ss-media-pending-fill" });
    updatePendingTile(figure, tile, Date.now());
  }
  if (tile.kind !== "workflow") {
    figure.createEl("figcaption", { cls: "systemsculpt-agent-media-caption is-single-line", text: tile.caption ?? "", attr: { title: tile.caption ?? "" } });
  }
  pendingTiles.set(figure, tile);
  return figure;
}

const pendingTiles = new WeakMap<HTMLElement, PendingMedia>();

function updatePendingTile(figure: HTMLElement, tile: PendingMedia, now: number): void {
  const { meta, fraction } = pendingStatus(tile, now);
  const line = figure.querySelector<HTMLElement>(".ss-media-pending-meta");
  if (line && line.textContent !== meta) line.textContent = meta;
  figure.classList.toggle("is-estimated", fraction !== null);
  figure.setCssProps({ "--ss-media-progress": fraction === null ? "" : fraction.toFixed(3) });
}

const clocks = new WeakMap<HTMLElement, number>();

/** Ticks every placeholder in a media block once a second, until none is left or the block leaves the page. */
export function syncPendingClock(block: HTMLElement): void {
  const view = block.ownerDocument.defaultView;
  if (!view || clocks.has(block)) return;
  if (!block.querySelector("[data-pending-id][aria-busy]")) return;
  const timer = view.setInterval(() => {
    const figures = Array.from(block.querySelectorAll<HTMLElement>("[data-pending-id][aria-busy]"));
    if (!block.isConnected || !figures.length) {
      view.clearInterval(timer);
      clocks.delete(block);
      return;
    }
    const now = Date.now();
    for (const figure of figures) {
      const tile = pendingTiles.get(figure);
      if (tile) updatePendingTile(figure, tile, now);
    }
  }, 1_000);
  clocks.set(block, timer);
}
