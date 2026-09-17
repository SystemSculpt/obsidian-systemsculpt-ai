import type { StudioNodeInstance } from "../../../studio/types";

/**
 * What a card shows. Content is the node: every kind gets exactly one primary
 * surface and no tabs.
 *
 * - media: the image or video is the card (media_ingest with loadable media).
 * - text: chromeless Markdown that edits in place (studio.text).
 * - code: the source is the content — script, JSON, values, processes,
 *   commands. Edited through the highlighted source editor.
 * - form: typed config fields ordered by importance, with the result (text,
 *   media, or a compact output line) beneath them.
 * - panel: a renderer-owned surface (boards, buttons, workflows) whose
 *   definition is reachable through one Source toggle in the header.
 */
export type StudioNodeSurfaceKind = "media" | "text" | "code" | "form" | "panel";

export type StudioNodeSurface = Readonly<{
  kind: StudioNodeSurfaceKind;
  /** Whether the header offers a Source toggle for the definition. */
  sourceToggle: boolean;
}>;

const CODE_KINDS = new Set([
  "studio.script",
  "studio.json",
  "studio.value",
  "studio.process",
  "studio.cli_command",
  "studio.terminal",
]);

const PANEL_KINDS = new Set([
  "studio.collection",
  "studio.run_collection",
  "studio.command_center",
  "studio.button",
  "studio.workflow",
]);

const surface = (kind: StudioNodeSurfaceKind, sourceToggle = false): StudioNodeSurface => ({ kind, sourceToggle });

export function resolveStudioNodeSurface(
  node: Pick<StudioNodeInstance, "kind">,
  context: { hasMedia: boolean; placeholder: boolean }
): StudioNodeSurface {
  const kind = String(node.kind || "").trim();
  if (context.placeholder) return surface("form");
  if (kind === "studio.text") return surface("text");
  if (kind === "studio.media_ingest") return surface(context.hasMedia ? "media" : "form");
  if (CODE_KINDS.has(kind)) return surface("code");
  if (PANEL_KINDS.has(kind)) return surface("panel", true);
  return surface("form");
}

export function isStudioCodeSurfaceKind(kind: string): boolean {
  return CODE_KINDS.has(String(kind || "").trim());
}

export function isStudioPanelSurfaceKind(kind: string): boolean {
  return PANEL_KINDS.has(String(kind || "").trim());
}
