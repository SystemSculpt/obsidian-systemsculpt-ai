import { AGENT_INCIDENT_MISSING_FIELD_CODES } from "./AgentIncidentSchema";

type EvidenceObject = Readonly<Record<string, unknown>>;
export type AgentIncidentMissingFieldCode = typeof AGENT_INCIDENT_MISSING_FIELD_CODES[number];

// Both capture and persistence validation derive completeness from this same
// closed evidence policy. Inputs are already projected or schema-validated.
export function deriveAgentIncidentMissingFields(input: {
  incident: EvidenceObject;
  correlation: EvidenceObject;
  environment: EvidenceObject;
  summary: EvidenceObject;
  runState: unknown;
  rendering: unknown;
  timeline: readonly unknown[];
  resourceLength: number;
  transportSegments: readonly unknown[];
}, observedMissingFields: Iterable<AgentIncidentMissingFieldCode> = []): AgentIncidentMissingFieldCode[] {
  const missing = new Set<string>(observedMissingFields);
  const partial = input.summary.partial_output as EvidenceObject;
  if (input.summary.started_at === undefined) missing.add("run_started");
  if (input.incident.incident_id === undefined) missing.add("server_incident_id");
  if (input.incident.failure_code === undefined) missing.add("failure_code");
  if (input.correlation.server_run_id === undefined) missing.add("server_run_id");
  if (input.incident.failure_authority === "unknown") missing.add("failure_authority");
  if (input.incident.failure_stage === "not_recorded") missing.add("failure_stage");
  if (input.incident.failure_mechanism === "not_recorded") missing.add("failure_mechanism");
  if (input.summary.terminal_validation === "not_recorded") missing.add("terminal_validation");
  if (input.summary.host_process_state === "unknown") missing.add("host_process_state");
  if (input.summary.chat_view_state === "unknown") missing.add("chat_view_state");
  if (input.summary.duration_ms === undefined) missing.add("duration_ms");
  if (partial.assistant_text_part_count === undefined) missing.add("assistant_text_part_count");
  if (partial.assistant_text_streaming_part_count === undefined) missing.add("assistant_text_streaming_part_count");
  if (partial.assistant_text_complete_part_count === undefined) missing.add("assistant_text_complete_part_count");
  if (partial.assistant_text_character_count === undefined) missing.add("assistant_text_character_count");
  if (partial.reasoning_part_count === undefined) missing.add("reasoning_part_count");
  if (partial.reasoning_streaming_part_count === undefined) missing.add("reasoning_streaming_part_count");
  if (partial.reasoning_complete_part_count === undefined) missing.add("reasoning_complete_part_count");
  if (partial.reasoning_character_count === undefined) missing.add("reasoning_character_count");
  if (partial.assistant_output_present_before_failure === undefined) missing.add("assistant_output_present_before_failure");
  if (partial.assistant_output_retained_in_failed_projection === undefined) missing.add("assistant_output_retained_in_failed_projection");
  if (input.runState === undefined) missing.add("run_state");
  if (input.rendering === undefined) {
    missing.add("rendering");
    missing.add("rendering_before_terminal_publish");
    missing.add("rendering_after_terminal_commit");
    missing.add("failure_surface_dom_commit");
    missing.add("failure_surface_paint_opportunity");
  } else {
    const rendering = input.rendering as EvidenceObject;
    if (rendering.before_terminal_publish === undefined) {
      missing.add("rendering_before_terminal_publish");
    }
    if (rendering.after_terminal_commit === undefined) {
      missing.add("rendering_after_terminal_commit");
    }
    if (rendering.failure_surface_dom_committed !== true) {
      missing.add("failure_surface_dom_commit");
    }
    if (rendering.failure_surface_paint_opportunity_observed !== true) {
      missing.add("failure_surface_paint_opportunity");
    }
  }
  if (input.resourceLength === 0) missing.add("resource_samples");
  if (input.transportSegments.length === 0) missing.add("transport_segments");
  const terminalTransport = terminalTransportReference(input.timeline);
  if (!terminalTransport || !input.transportSegments.some((value) => (
      isEvidenceObject(value)
      && value.segment_ordinal === terminalTransport.segmentOrdinal
      && (terminalTransport.commandKind === undefined || value.command_kind === terminalTransport.commandKind)
      && (
        terminalTransport.toolExecutionOrdinal === undefined
        || value.tool_execution_ordinal === terminalTransport.toolExecutionOrdinal
      )
    ))) missing.add("terminal_transport_segment");
  if (input.environment.plugin_version === undefined) missing.add("environment_plugin_version");
  if (input.environment.plugin_build_id === undefined) missing.add("environment_plugin_build_id");
  if (input.environment.loaded_bundle_sha256 === undefined) missing.add("environment_loaded_bundle_sha256");
  if (input.environment.obsidian_version === undefined) missing.add("environment_obsidian_version");
  if (input.environment.host_type === undefined || input.environment.host_type === "unknown") missing.add("environment_host_type");
  if (input.environment.os_family === undefined || input.environment.os_family === "unknown") missing.add("environment_os_family");
  if (input.timeline.some((value) => (
    isEvidenceObject(value)
    && typeof value.code === "string"
    && isToolLifecycleCodeValue(value.code)
    && value.tool_execution_ordinal === undefined
  ))) {
    missing.add("tool_execution_ordinal");
  }
  return AGENT_INCIDENT_MISSING_FIELD_CODES.filter((field) => missing.has(field));
}

export function terminalTransportReference(
  timeline: readonly unknown[],
): Readonly<{
  segmentOrdinal: number;
  commandKind?: string;
  toolExecutionOrdinal?: number;
}> | null {
  let segmentOrdinal: number | undefined;
  let commandKind: string | undefined;
  let toolExecutionOrdinal: number | undefined;
  for (const value of timeline) {
    if (!isEvidenceObject(value)) continue;
    if (value.code !== "response_result_received_failed" && value.code !== "run_finished_failed") continue;
    if (typeof value.command_segment_ordinal !== "number") continue;
    if (segmentOrdinal !== undefined && segmentOrdinal !== value.command_segment_ordinal) return null;
    if (commandKind !== undefined && typeof value.command_kind === "string" && commandKind !== value.command_kind) return null;
    if (
      toolExecutionOrdinal !== undefined
      && typeof value.tool_execution_ordinal === "number"
      && toolExecutionOrdinal !== value.tool_execution_ordinal
    ) return null;
    segmentOrdinal = value.command_segment_ordinal;
    commandKind = commandKind ?? (typeof value.command_kind === "string" ? value.command_kind : undefined);
    toolExecutionOrdinal = toolExecutionOrdinal
      ?? (typeof value.tool_execution_ordinal === "number" ? value.tool_execution_ordinal : undefined);
  }
  return segmentOrdinal === undefined
    ? null
    : {
        segmentOrdinal,
        ...(commandKind === undefined ? {} : { commandKind }),
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      };
}

function isToolLifecycleCodeValue(code: string): boolean {
  return code.startsWith("local_tool_")
    || code.startsWith("tool_result_")
    || code.startsWith("mutation_");
}

function isEvidenceObject(value: unknown): value is EvidenceObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
