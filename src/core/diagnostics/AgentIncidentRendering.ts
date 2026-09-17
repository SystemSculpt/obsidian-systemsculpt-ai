import {
  AGENT_INCIDENT_MAX_RENDER_COUNT,
  AGENT_INCIDENT_MAX_RENDER_DURATION_MS,
} from "./AgentIncidentSchema";
import type { AgentIncidentRenderingInput, AgentIncidentRenderingSnapshot } from "./AgentIncidentRecorder";

type ScalarRule = "boolean" | number | readonly string[];
type Field = readonly [input: string, persisted: string, rule: ScalarRule];
const COUNT = AGENT_INCIDENT_MAX_RENDER_COUNT;
const DURATION = AGENT_INCIDENT_MAX_RENDER_DURATION_MS;

// One closed policy for live snapshots, content-free projection, and disk validation.
const ROOT: readonly Field[] = [
  ["renderState", "render_state", ["idle", "frame_pending", "queued", "rendering", "rendering_with_pending"]],
  ["renderPassCount", "render_pass_count", COUNT],
  ["pendingRenderCount", "pending_render_count", COUNT],
  ["lastRenderDurationMs", "last_render_duration_ms", DURATION],
  ["maxRenderDurationMs", "max_render_duration_ms", DURATION],
  ["firstDomCommitObserved", "first_dom_commit_observed", "boolean"],
  ["firstPaintOpportunityObserved", "first_paint_opportunity_observed", "boolean"],
  ["registeredRowCount", "registered_row_count", COUNT],
];
const RENDERER: readonly Field[] = [
  ["renderPassCount", "render_pass_count", COUNT],
  ["pendingRenderPassCount", "pending_render_pass_count", COUNT],
  ["lastRenderDurationMs", "last_render_duration_ms", DURATION],
  ["maxRenderDurationMs", "max_render_duration_ms", DURATION],
  ["historicalRowCount", "historical_row_count", COUNT],
  ["historicalPartCount", "historical_part_count", COUNT],
  ["activePartCount", "active_part_count", COUNT],
  ["disclosureCount", "disclosure_count", COUNT],
  ["openDisclosureCount", "open_disclosure_count", COUNT],
  ["activityDisclosureCount", "activity_disclosure_count", COUNT],
  ["reasoningDisclosureCount", "reasoning_disclosure_count", COUNT],
  ["toolDisclosureCount", "tool_disclosure_count", COUNT],
  ["overflowDisclosureCount", "overflow_disclosure_count", COUNT],
  ["pendingHydrationCount", "pending_hydration_count", COUNT],
  ["renderingEnabled", "rendering_enabled", "boolean"],
];
const SCROLLER: readonly Field[] = [
  ["mode", "mode", ["end", "manual"]],
  ["distanceFromEndBucket", "distance_from_end_bucket", ["at_end", "near_end", "within_viewport", "far_from_end", "unknown"]],
  ["registeredRowCount", "registered_row_count", COUNT],
  ["pendingLayoutMutationCount", "pending_layout_mutation_count", COUNT],
  ["layoutMutationPending", "layout_mutation_pending", "boolean"],
  ["geometryUpdatePending", "geometry_update_pending", "boolean"],
  ["programmaticScrollPending", "programmatic_scroll_pending", "boolean"],
  ["submittedPromptAnchorActive", "submitted_prompt_anchor_active", "boolean"],
  ["destroyed", "destroyed", "boolean"],
];

function accepts(value: unknown, rule: ScalarRule): boolean {
  if (rule === "boolean") return typeof value === "boolean";
  if (typeof rule === "number") {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= rule;
  }
  return typeof value === "string" && rule.includes(value);
}

function projectFields(input: object, fields: readonly Field[], persisted: boolean): Record<string, unknown> {
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [inputKey, outputKey, rule] of fields) {
    const value = source[inputKey];
    if (persisted && !accepts(value, rule)) throw new Error("Invalid rendering evidence.");
    result[persisted ? outputKey : inputKey] = value;
  }
  return result;
}

function snapshot(input: AgentIncidentRenderingInput, persisted: boolean): Record<string, unknown> | null {
  try {
    // Read live getters once. Never enumerate content-bearing live objects.
    const renderer = input.renderer;
    const scroller = input.scroller;
    if (!renderer || !scroller) return null;
    return Object.freeze({
      ...projectFields(input, ROOT, persisted),
      renderer: Object.freeze(projectFields(renderer, RENDERER, persisted)),
      scroller: Object.freeze(projectFields(scroller, SCROLLER, persisted)),
    });
  } catch {
    return null;
  }
}

/** Coordinator snapshot keeps invalid scalars for the recorder to reject as before. */
export function copyRenderingInput(input: AgentIncidentRenderingInput): AgentIncidentRenderingInput | undefined {
  return (snapshot(input, false) ?? undefined) as AgentIncidentRenderingInput | undefined;
}

export function projectRenderingSnapshot(input: AgentIncidentRenderingInput): AgentIncidentRenderingSnapshot | null {
  return snapshot(input, true) as AgentIncidentRenderingSnapshot | null;
}

/** Disk values have already crossed the canonical JSON boundary: no getters or proxies. */
export function isRenderingSnapshot(value: unknown): boolean {
  const validObject = (candidate: unknown, fields: readonly Field[], extraKeys: readonly string[] = []): candidate is Record<string, unknown> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    const allowed = new Set([...fields.map(([, key]) => key), ...extraKeys]);
    return Object.keys(record).length === allowed.size
      && Object.keys(record).every(key => allowed.has(key))
      && fields.every(([, key, rule]) => Object.prototype.hasOwnProperty.call(record, key) && accepts(record[key], rule));
  };
  return validObject(value, ROOT, ["renderer", "scroller"])
    && validObject(value.renderer, RENDERER)
    && validObject(value.scroller, SCROLLER);
}
