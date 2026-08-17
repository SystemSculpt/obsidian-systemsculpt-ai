import { StudioGraphCompiler } from "./StudioGraphCompiler";
import {
  resolveStudioGraphNodeResizeBounds,
  resolveStudioNodeDefaultSize,
} from "./StudioNodeGeometry";
import { isStudioVisualOnlyNodeKind } from "./StudioNodeKinds";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { registerBuiltInStudioNodes } from "./StudioBuiltInNodes";
import type {
  StudioJsonValue,
  StudioNodeConfigFieldDefinition,
  StudioNodeDefinition,
  StudioPortDefinition,
  StudioProjectV1,
} from "./types";

/**
 * Vault path of the generated agent reference document. Every serialized v2
 * project carries this path in its "docs" field so an agent that opens a
 * project anywhere in the vault can find the format guide and the node kind
 * reference without either being embedded in the project file.
 */
export const STUDIO_AGENT_DOCS_PATH = "SystemSculpt/Studio/AGENTS.md" as const;

const NODE_PURPOSES: Readonly<Record<string, string>> = {
  "studio.audio_extract": "Extract audio from a media asset for downstream transcription or processing.",
  "studio.cli_command": "Run a configured command in an approved filesystem scope on a desktop host.",
  "studio.dataset": "Represent, inspect, and emit structured tabular or record-oriented data.",
  "studio.image_generation": "Generate or edit images through the managed SystemSculpt API.",
  "studio.input": "Provide a static value or text input to downstream executable nodes.",
  "studio.json": "Provide, parse, or normalize JSON content for downstream nodes.",
  "studio.media_ingest": "Reference image, video, audio, or binary media for downstream nodes.",
  "studio.note": "Read one or more vault Markdown notes and emit their content and paths.",
  "studio.retired_http_request": "Retained only for compatibility with older projects; do not add new instances.",
  "studio.terminal": "Visual terminal surface; it is canvas content, not an executable graph step.",
  "studio.text": "Provide minimal freeform canvas text that can also feed downstream text inputs.",
  "studio.text_generation": "Generate text from a required prompt input through the managed SystemSculpt API.",
  "studio.text_output": "Display or preserve text produced by another node.",
  "studio.transcription": "Transcribe an audio or video asset through the managed SystemSculpt API.",
  "studio.value": "Provide a typed primitive or structured value to downstream nodes.",
};

const builtInRegistry = new StudioNodeRegistry();
registerBuiltInStudioNodes(builtInRegistry);

export const builtInStudioNodeRegistry = builtInRegistry;

/**
 * v2 documents spell kinds without the "studio." namespace and never persist
 * node versions; both are restored here. A kind that is not built in keeps its
 * spelling and the default version so future or third-party kinds round-trip.
 */
export function expandStudioNodeKind(kind: string): string {
  const trimmed = String(kind || "").trim();
  return trimmed && !trimmed.includes(".") ? `studio.${trimmed}` : trimmed;
}

export function compactStudioNodeKind(kind: string): string {
  return kind.startsWith("studio.") ? kind.slice("studio.".length) : kind;
}

export function resolveBuiltInStudioNodeVersion(kind: string): string | null {
  const definition = builtInRegistry.list().find((entry) => entry.kind === kind);
  return definition ? definition.version : null;
}

export function findBuiltInStudioNodeDefinition(kind: string): StudioNodeDefinition | null {
  return builtInRegistry.list().find((entry) => entry.kind === kind) || null;
}

function renderPortLine(port: StudioPortDefinition, direction: "in" | "out"): string {
  const flags = [port.type, ...(port.required ? ["required"] : [])].join(", ");
  const description = port.description ? ` — ${String(port.description).trim()}` : "";
  return `- ${direction}: \`${port.id}\` (${flags})${description}`;
}

function renderConfigFieldLine(
  field: StudioNodeConfigFieldDefinition,
  defaults: Record<string, StudioJsonValue>
): string {
  const notes: string[] = [field.type];
  if (field.required === true) notes.push("required");
  if (typeof defaults[field.key] !== "undefined") notes.push(`default ${JSON.stringify(defaults[field.key])}`);
  if (field.options) notes.push(`one of ${field.options.map((option) => JSON.stringify(option.value)).join(" | ")}`);
  if (typeof field.min === "number") notes.push(`min ${field.min}`);
  if (typeof field.max === "number") notes.push(`max ${field.max}`);
  if (field.integer === true) notes.push("integer");
  if (field.type === "file_path" || field.type === "directory_path" || field.type === "media_path") {
    notes.push(field.allowOutsideVault === true ? "vault or absolute desktop path" : "vault-relative path");
  }
  const description = field.description ? ` — ${String(field.description).trim()}` : "";
  return `- \`${field.key}\` (${notes.join(", ")})${description}`;
}

function renderNodeKindSection(definition: StudioNodeDefinition): string {
  const visualOnly = isStudioVisualOnlyNodeKind(definition.kind);
  const defaultSize = resolveStudioNodeDefaultSize(definition.kind);
  const bounds = resolveStudioGraphNodeResizeBounds({ kind: definition.kind });
  const lines: string[] = [];
  lines.push(`### ${compactStudioNodeKind(definition.kind)}`);
  lines.push("");
  lines.push(NODE_PURPOSES[definition.kind] || "Built-in Studio node.");
  const facts: string[] = [];
  facts.push(visualOnly ? "visual only (never runs)" : "executable");
  if (definition.requiredHostCapabilities.length > 0) {
    facts.push(`desktop only (${definition.requiredHostCapabilities.join(", ")})`);
  }
  if (definition.hiddenFromInsertMenu === true) {
    facts.push("legacy: keep existing instances, never add new ones");
  }
  facts.push(`default size ${defaultSize.width}x${defaultSize.height}, width ${bounds.minWidth}-${bounds.maxWidth}`);
  lines.push(`(${facts.join("; ")})`);
  const portLines = [
    ...definition.inputPorts.map((port) => renderPortLine(port, "in")),
    ...definition.outputPorts.map((port) => renderPortLine(port, "out")),
  ];
  if (portLines.length > 0) {
    lines.push("");
    lines.push(...portLines);
  }
  if (definition.kind === "studio.dataset") {
    lines.push("- out ports vary with config: each configured dataset column is exposed as an output port.");
  }
  if (definition.configSchema.fields.length > 0) {
    lines.push("");
    lines.push("Config:");
    lines.push(
      ...definition.configSchema.fields.map((field) =>
        renderConfigFieldLine(field, definition.configDefaults as Record<string, StudioJsonValue>)
      )
    );
  }
  return lines.join("\n");
}

/**
 * The complete generated agent documentation for .systemsculpt files: format
 * guide plus the node kind reference. Studio publishes it to
 * STUDIO_AGENT_DOCS_PATH; project files only point at it. Content is fully
 * derived from the registry, so a byte comparison detects staleness.
 */
export function renderStudioAgentReferenceMarkdown(): string {
  const kinds = builtInRegistry
    .list()
    .slice()
    .sort((left, right) => left.kind.localeCompare(right.kind));
  return `# SystemSculpt Studio projects

Generated by SystemSculpt. Do not edit; Studio rewrites this file when the plugin updates.

A \`.systemsculpt\` file is one JSON document that fully describes a visual workflow canvas. Read it, edit it, and save it like any other JSON file; Studio picks up external edits live.

## Document shape

~~~json
{
  "schema": "studio.project.v2",
  "id": "proj_1a2b3c",
  "name": "Interview pipeline",
  "docs": "${STUDIO_AGENT_DOCS_PATH}",
  "canvas": {
    "nodes": [
      { "id": "recording", "kind": "media_ingest", "title": "Interview audio", "x": 40, "y": 40,
        "config": { "path": "Recordings/interview.m4a" } },
      { "id": "transcript", "kind": "transcription", "title": "Transcribe", "x": 400, "y": 40 },
      { "id": "summary", "kind": "text_generation", "title": "Summarize", "x": 760, "y": 40,
        "config": { "prompt": "Summarize the transcript." } }
    ],
    "edges": [
      "recording.path -> transcript.media",
      "transcript.text -> summary.prompt"
    ],
    "groups": [],
    "shapes": [],
    "arrows": []
  }
}
~~~

## Rules

- \`schema\`, \`id\`, and \`docs\` are Studio-owned: keep them exactly as they are. Everything under \`canvas\` plus \`name\` is yours to edit.
- Every id must be non-empty and unique within its list. Keep existing ids stable; use short descriptive ids for additions.
- A node is \`{id, kind, title?, x, y, width?, height?, config?, disabled?, continueOnError?}\`. Omit \`width\`/\`height\` to use the kind's default size; omit \`config\` when empty.
- \`config\` holds the node's authored content and settings; the node kind reference below lists allowed keys, defaults, and value constraints. Paths are vault-relative unless the field says otherwise.
- An edge is the string \`"fromNode.outPort -> toNode.inPort"\`. Port types must match unless either side is \`any\`. When a node has exactly one output (or one input) port the port name may be omitted: \`"transcript -> summary.prompt"\`.
- Edges connect executable data flow only. Visual-only kinds have no executable ports; do not invent port names.
- A group is \`{id, name, color?, nodes, shapes?}\` framing existing node and shape ids. Membership defines its bounds; a member belongs to at most one group; a group needs at least one member; \`color\` is \`#rgb\` or \`#rrggbb\`.
- A shape is \`{id, shape, x, y, width, height, label, style?}\` on the same canvas. Shapes are drawings, not nodes: they never run and cannot connect to a node. \`shape\` is one of \`rectangle\` (step), \`ellipse\`, \`diamond\` (decision), \`pill\` (start or end), \`cylinder\` (store), \`note\` (aside), \`hexagon\` (preparation). Sides are whole pixels between 48 and 4000.
- An arrow is the string \`"fromShape -> toShape"\` between two different existing shapes; each direction of a pair may appear once. Arrows are drawn border to border and carry no data.
- To label an arrow, write it as the object \`{"from": "fromShape", "to": "toShape", "label": "text"}\` instead of the string. Shape and arrow labels are plain text; use \`\\n\` inside the JSON string for a line break.
- Canvas coordinates are pixels; the origin is top-left, x grows right, y grows down, and \`x\`/\`y\` is a card's top-left corner. Prefer left-to-right execution flow with about 90px between columns and at least 20px between rows, and avoid overlap.
- Older projects may still be \`studio.project.v1\`; Studio upgrades them to v2 on save. Write v2 for new work.

## Node kinds

${kinds.map(renderNodeKindSection).join("\n\n")}
`;
}

export function validateStudioProjectForAgentEdit(project: StudioProjectV1): void {
  // Document-mode compile: this gate decides whether Studio will adopt and
  // open a project file at all, so it must accept every state Studio itself
  // can persist (placeholder nodes, unfinished configs, unwired required
  // inputs). Run readiness is enforced separately by the runtime's strict
  // compile when the user actually runs the graph.
  //
  // graph.entryNodeIds is deliberately not validated here. It is derived
  // data: the canvas recomputes it on every mutation and scopeProjectForRun
  // re-derives real entry points from executable-graph structure, ignoring
  // the persisted list. The visual-only classification also changes across
  // plugin versions (studio.text became executable in 6.2.x), so rejecting
  // an entry by kind bricks files persisted by a sibling build. parse
  // drops entry IDs that reference missing nodes.
  new StudioGraphCompiler().compile(project, builtInRegistry, { validation: "document" });
}
