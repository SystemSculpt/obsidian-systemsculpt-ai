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
  "studio.button": "Reusable explicit button. Set config.label, action (run or focus), and target node ID. Reuses target permissions; graph traversal never presses it.",
  "studio.command_center": "Action panel for explicit run and focus commands targeting existing node IDs. Buttons reuse the target execution and permission path. It is visual-only and never runs from graph traversal.",
  "studio.run_collection": "Live collection of independent native run instances. Connect role JSON outputs to matching source-ID ports; these are observation links and never execute roles. Double-click a run for public activity, messages and controls.",
  "studio.collection": "Display a bounded record collection as a Kanban board, grouped by configured fields. Carries the same JSON downstream; the source owns record changes.",
  "studio.workflow": "Inspect and explicitly start a revisioned workflow in the existing execution service. Native tasks survive closing Studio. The Run canvas action only inspects this node; Start workflow admits execution.",
  "studio.codex": "Run a prompt through the installed Codex app-server with the machine login, selected model/thinking/speed (default gpt-6-astra/high/Normal), native approvals and durable Codex history. Working directory is vault-relative by default; dot means the current vault. Set threadId to resume; leave it blank for a new task.",
  "studio.script": "Run an editable JavaScript module with typed ports in an approved Node process. Preferred for new custom actions.",
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
  if (definition.kind === "studio.script") {
    lines.push('- config.source is the complete JavaScript ES module. Export default async ({inputs, context}) => ({result: value}).');
    lines.push('- An optional leading /* studio newline YAML newline */ comment declares inputs/outputs as port-name mappings (json, text, number, boolean, or file-reference types). A port may use {type: json, required: false}.');
    lines.push('- Metadata also accepts executable (default node), workingDirectory (default vault root), environment, timeoutMs, maxOutputBytes, and maxArtifactMb. Outputs default to result: json. Fixed stdout, stderr, exit_code, timed_out ports are reserved.');
    lines.push('- context contains runId, nodeId and directory. File-reference outputs may return paths. Source is limited to 256 KiB; inputs and results to 1 MiB. No cache; the exact executable grant and normal cancellation/timeout controls apply.');
    lines.push('- Node executes the module outside Obsidian. Use absolute imports for local dependencies; relative imports resolve from temporary module storage. Never embed credentials in source.');
  }
  if (definition.kind === "studio.process") {
    lines.push("- in/out ports come from config.inputs/config.outputs arrays of {id,type,required}. Fixed outputs are reserved.");
    lines.push("- Desktop only. An exact executable grant is required; processes run without a shell and always execute (no cache).");
    lines.push('- STUDIO_INPUTS is a studio.process.inputs.v1 JSON manifest; write {schema:"studio.process.outputs.v1",outputs:{...}} to STUDIO_OUTPUTS. Both manifests are limited to 1 MiB.');
    lines.push("- Optional manifestToStdin sends the same input. STUDIO_RUN_DIR holds temporary files. Progress lines: ::studio-progress 50 Working.");
  }
  if (definition.configSchema.fields.length > 0) {
    lines.push("");
    lines.push("Config:");
    lines.push(
      ...definition.configSchema.fields.map((field) =>
        renderConfigFieldLine(field, definition.configDefaults)
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

A \`.systemsculpt\` file describes a visual workflow canvas, or is a small \`studio.entry.v1\` link to an adjacent \`.studio\` directory. Studio picks up valid external edits live.

## Concurrent editing

Each canvas is one readable JSON file. Its \`document\` field contains the
compressed collaborative state and \`heads\` identifies its revision. Keep that
field intact. Text insertions merge within the same value, independent fields
merge, and deleting an entity prevents stale edits from bringing it back.

Concurrent agents MUST use \`studio_read_document\` and \`studio_edit_document\`.
Read returns the readable canvas, entity map and revision heads. Edit accepts
those heads and a batch of scoped edits. All clients share the same live Studio
service, which serializes publication into the one file. For agents outside
Studio, the official Obsidian CLI eval can call
\`app.plugins.plugins["systemsculpt-ai"].getStudioService().readAgentDocument(path)\`
and \`editAgentDocument(path, heads, edits)\` in the active vault.

~~~json
[
  {"kind":"set","entityId":"node:summary","path":["config","systemPrompt"],"value":"Summarize in three paragraphs."},
  {"kind":"create","entityId":"node:note","value":{"id":"note","kind":"studio.text","x":400,"y":100,"config":{"value":"Notes"}}}
]
~~~

Entity keys are \`node:<id>\`, \`shape:<id>\`, \`group:<id>\`,
\`edge:<from.port -> to.port>\`, \`arrow:<JSON array of from and to>\`, and
\`project\`. Use unique node IDs. Set addresses fields through a string-array
path; \`remove:true\` removes a field. Create adds an entity, delete removes it,
and restore explicitly restores a deleted entity. Group nodes and shapes use
ID-to-true maps in the edit API; readable canvas arrays remain unchanged.
Config arrays are atomic: set the entire array. Do not use array offsets.

Raw JSON edits are supported for a single writer. Simultaneous whole-file
replacement cannot be made lossless: a write overwritten before Studio reads
it is unavailable to merge. Use the shared edit service for concurrent work.
Never modify the encoded state or invent heads. There are no transaction
folders, conflict copies or alternate cards. Media and execution records are
separate from authored canvas state.

## Source cards

Every card has a slim type/title header and Source / Result tabs. Source is JavaScript for script nodes, bare JSON for json nodes, Markdown for text nodes, and YAML config for other typed nodes. Edit source opens a syntax-colored editor; Apply validates and saves without running. Ctrl/Cmd+Enter applies. External source conflicts preserve the draft and require reload. Agents edit the same canonical node config in the document below; no UI composer is required.

Prefer script nodes for custom actions and json nodes for their input data. Put the entire module in config.source. Keep node IDs and connected port IDs stable. Add or change typed ports in the module's leading studio metadata comment. Result stays on the same node. Connector-owned collection snapshots remain source-managed; only change collection presentation config, not its live value.

## Directory workspaces

Reusable roles live in \`roles/*.yaml\` with shared instructions in \`prompts/*.md\`. Roles describe objectives, not permissions or singleton agents. Every role can have many native instances. Delegation records parent/child task and thread identities; results return to the originating thread. Workflow cards with \`roleId\` display instances of that role across runs.

An entry is \`{"schema":"studio.entry.v1","id":"existing-project-id","projection":"Name.studio/views/graph.systemsculpt"}\`. Keep its identity and link stable. The linked canvas uses the document format below. In a managed workspace, edit \`studio.json\`, \`workflows/*.yaml\`, \`prompts/*.md\` and source records through the owning companion service. It validates the file set, publishes an immutable definition revision, and updates the view. Running workflows retain their original definition. Canvas layout and user view preferences remain presentation data.

## Document shape

~~~json
{
  "schema": "studio.project.v2",
  "id": "proj_1a2b3c",
  "name": "Interview pipeline",
  "docs": "${STUDIO_AGENT_DOCS_PATH}",
  "canvas": {
    "layout": { "mode": "manual" },
    "nodes": [
      { "id": "recording", "kind": "media_ingest", "title": "Interview audio", "x": 80, "y": 80,
        "config": { "path": "Recordings/interview.m4a" } },
      { "id": "transcript", "kind": "transcription", "title": "Transcribe", "x": 800, "y": 80 },
      { "id": "summary", "kind": "text_generation", "title": "Summarize", "x": 1520, "y": 80,
        "config": { "systemPrompt": "Summarize the transcript." } }
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

- \`schema\`, \`id\`, \`docs\`, and \`document.heads\` are Studio-owned: keep them exactly as they are. Everything under \`canvas\` plus \`name\` is yours to edit.
- Every id must be non-empty and unique within its list. Keep existing ids stable; use short descriptive ids for additions.
- A node is \`{id, kind, title?, parent?, x, y, width?, height?, config?, disabled?, continueOnError?}\`. Omit \`width\`/\`height\` to use the kind's default size; omit \`config\` when empty.
- \`config\` holds the node's authored content and settings; the node kind reference below lists allowed keys, defaults, and value constraints. Paths are vault-relative unless the field says otherwise.
- An edge is the string \`"fromNode.outPort -> toNode.inPort"\`. Port types must match unless either side is \`any\`. When a node has exactly one output (or one input) port the port name may be omitted: \`"transcript -> summary.prompt"\`.
- Edges connect executable data flow only. Visual-only kinds have no executable ports; do not invent port names.
- A group is \`{id, name, color?, nodes, shapes?, outputFor?, outputOffset?}\` framing existing node and shape ids. Membership defines its bounds; a member belongs to at most one group; a group needs at least one member; \`color\` is \`#rgb\` or \`#rrggbb\`.
- A shape is \`{id, shape, x, y, width, height, label, style?}\` on the same canvas. Shapes are drawings, not nodes: they never run and cannot connect to a node. \`shape\` is one of \`rectangle\` (step), \`ellipse\`, \`diamond\` (decision), \`pill\` (start or end), \`cylinder\` (store), \`note\` (aside), \`hexagon\` (preparation). Sides are whole pixels between 48 and 4000.
- An arrow is the string \`"fromItem -> toItem"\` between two different existing nodes or shapes; each direction of a pair may appear once. Arrows are drawn border to border and carry no data.
- To label an arrow, write it as the object \`{"from": "fromItem", "to": "toItem", "label": "text"}\` instead of the string. Shape and arrow labels are plain text; use \`\\n\` inside the JSON string for a line break.
- Use \`canvas.layout: {"mode":"manual"}\` and explicit node \`x\`/\`y\` coordinates. Preserve existing positions when editing content. Studio never rearranges ordinary cards on resize, file edits, or drop. Dragging cards, shapes, or groups shows visual edge/center alignment guides and pixel distances, with gentle snapping within 5 screen pixels of matching edges or centers. Older managed documents recover missing positions once on import and save as manual canvases.
- Generated image/video cards belong to an Outputs container with \`outputFor\` pointing to their producer. Studio places a new container to its producer's right and arranges only its generated children in generation order, three columns with measured spacing. Preserve this marker and ownership metadata. Containers follow their producer; moving a container as a unit persists its producer-relative \`outputOffset: {x,y}\` (default x=96, y=0). Later runs append inside it. Ordinary groups and connected user-authored result cards remain manually placed.
- Optional \`parent\` is an existing node id defining organizational hierarchy (for example an initiative and its tickets). Parent relationships must be acyclic and never create execution dependencies. Only \`edges\` carry data or cause execution.
- Older projects may still be \`studio.project.v1\`; Studio upgrades them to v2 on save. Write v2 for new work.

## Running and observing a canvas

In the installed Obsidian runtime, use the public Studio service: \`app.plugins.plugins["systemsculpt-ai"].getStudioService()\`. Call \`runProject(vaultRelativePath)\` for the graph or \`runProjectFromNode(vaultRelativePath, nodeId)\` for a node and its upstream prerequisites. These are the same execution methods used by the Run controls; every open view of that project receives progress, output, and errors automatically. Do not call private view handlers or fabricate run events.

The run methods return a promise for the completed summary. For a long run, start it once and observe \`getActiveRun(path)\` (run ID, scoped node IDs, compact current events) and \`getRecentRuns(path)\` (saved results). \`subscribeRunEvents(listener)\` returns an unsubscribe function for live updates across projects; each update includes its project path. Opening a running project restores its current progress; reopening a finished project restores its saved run outputs, including images that bypass the execution cache. \`getLatestRunEvents(path)\` reads that saved event history without executing anything. A completed event means output files have been published. Re-running an image node requests another generation; inspect existing results before starting again.

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
