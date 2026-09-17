import { activityLabel, isQuietActivityPhase, type StudioNodeActivity } from "./StudioActivity";

export type StudioActivityBadgeNote = Readonly<{
  text: string;
  tone?: "neutral" | "warning";
  title?: string;
}>;

/**
 * The uniform status row every node card carries: dot, phase word, progress,
 * detail, and an optional node note. It is always in the card's normal flow
 * and simply hides while idle, so run state can be patched in place without
 * re-rendering the card.
 */
export function renderStudioActivityBadge(
  root: HTMLElement,
  options: { activity: StudioNodeActivity; note?: StudioActivityBadgeNote | null }
): HTMLElement {
  const row = root.createDiv({ cls: "ss-studio-node-activity", attr: { role: "status" } });
  row.createSpan({ cls: "ss-studio-node-activity-dot", attr: { "aria-hidden": "true" } });
  row.createSpan({ cls: "ss-studio-node-activity-label" });
  row.createSpan({ cls: "ss-studio-node-activity-progress" });
  row.createSpan({ cls: "ss-studio-node-activity-detail" });
  const note = options.note && options.note.text.trim() ? options.note : null;
  if (note) {
    const noteEl = row.createDiv({
      cls: `ss-studio-node-badge is-${note.tone || "neutral"}`,
      text: note.text.trim(),
    });
    const tooltip = String(note.title || "").trim();
    if (tooltip) {
      noteEl.title = tooltip;
      noteEl.setAttribute("aria-label", tooltip);
    }
    row.classList.add("has-note");
  }
  updateStudioActivityBadge(row, options.activity);
  return row;
}

export function updateStudioActivityBadge(row: HTMLElement, activity: StudioNodeActivity): void {
  row.dataset.activity = activity.phase;
  const label = row.querySelector<HTMLElement>(".ss-studio-node-activity-label");
  const progress = row.querySelector<HTMLElement>(".ss-studio-node-activity-progress");
  const detail = row.querySelector<HTMLElement>(".ss-studio-node-activity-detail");
  const labelText = activity.label || activityLabel(activity.phase);
  if (label) label.textContent = labelText;
  if (progress) progress.textContent = activity.progress === null ? "" : `${Math.round(activity.progress * 100)}%`;
  if (detail) detail.textContent = activity.detail;
  const tooltip = activity.detail ? `${labelText}: ${activity.detail}` : labelText;
  row.title = tooltip;
  row.setAttribute("aria-label", tooltip);
  // Settled work is visible in the content itself; only live and failed phases need words.
  row.hidden = isQuietActivityPhase(activity.phase) && !row.classList.contains("has-note");
}
