import { StudioGraphCompiler } from "./StudioGraphCompiler";
import {
  resolveStudioGraphNodeResizeBounds,
  resolveStudioNodeDefaultSize,
  resolveStudioNodeResizeSemantics,
} from "./StudioNodeGeometry";
import { isStudioVisualOnlyNodeKind } from "./StudioNodeKinds";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { registerBuiltInStudioNodes } from "./StudioBuiltInNodes";
import type {
  StudioJsonValue,
  StudioNodeConfigFieldDefinition,
  StudioNodeDefinition,
  StudioProjectV1,
} from "./types";

const AGENT_GUIDE_SCHEMA = "studio.agent-guide.v1" as const;
const NODE_REFERENCE_SCHEMA = "studio.node-kind-reference.v1" as const;

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
  "studio.text": "Visual-only freeform canvas text for labels, explanations, and architecture annotations.",
  "studio.text_generation": "Generate text from a required prompt input through the managed SystemSculpt API.",
  "studio.text_output": "Display or preserve text produced by another node.",
  "studio.transcription": "Transcribe an audio or video asset through the managed SystemSculpt API.",
  "studio.value": "Provide a typed primitive or structured value to downstream nodes.",
};

type AgentConfigFieldReference = {
  key: string;
  type: string;
  required?: true;
  description?: string;
  default?: StudioJsonValue;
  allowedValues?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  pathScope?: "vault" | "vault_or_external_desktop";
};

function compactConfigField(
  field: StudioNodeConfigFieldDefinition,
  defaults: Record<string, StudioJsonValue>
): AgentConfigFieldReference {
  const defaultValue = defaults[field.key];
  return {
    key: field.key,
    type: field.type,
    ...(field.required === true ? { required: true as const } : {}),
    ...(field.description ? { description: String(field.description).trim() } : {}),
    ...(typeof defaultValue !== "undefined" ? { default: defaultValue } : {}),
    ...(field.options ? { allowedValues: field.options.map((option) => option.value) } : {}),
    ...(typeof field.min === "number" ? { min: field.min } : {}),
    ...(typeof field.max === "number" ? { max: field.max } : {}),
    ...(field.integer === true ? { integer: true } : {}),
    ...(field.type === "file_path" || field.type === "directory_path" || field.type === "media_path"
      ? { pathScope: field.allowOutsideVault === true ? "vault_or_external_desktop" as const : "vault" as const }
      : {}),
  };
}

function createNodeKindReference(definition: StudioNodeDefinition) {
  const visualOnly = isStudioVisualOnlyNodeKind(definition.kind);
  const resizeBounds = resolveStudioGraphNodeResizeBounds({ kind: definition.kind });
  const sizeLimitProfile = definition.kind === "studio.text"
    ? "text"
    : definition.kind === "studio.terminal"
      ? "terminal"
      : resizeBounds.minWidth > 220 || resizeBounds.minHeight > 120
        ? "large"
        : "standard";
  return {
    kind: definition.kind,
    version: definition.version,
    purpose: NODE_PURPOSES[definition.kind] || "Built-in Studio node.",
    ...(definition.hiddenFromInsertMenu === true ? { newNodeAvailability: "existing_only" as const } : {}),
    execution: {
      mode: visualOnly ? "visual_only" as const : "executable" as const,
      ...(definition.requiredHostCapabilities.length > 0
        ? { requiredHostCapabilities: [...definition.requiredHostCapabilities] }
        : {}),
    },
    canvas: {
      defaultSize: resolveStudioNodeDefaultSize(definition.kind),
      resizeMode: resolveStudioNodeResizeSemantics(definition.kind),
      sizeLimitProfile,
    },
    ports: {
      inputs: definition.inputPorts.map((port) => ({ ...port })),
      outputs: definition.outputPorts.map((port) => ({ ...port })),
    },
    config: {
      ...(definition.configSchema.allowUnknownKeys === true ? { allowUnknownKeys: true as const } : {}),
      fields: definition.configSchema.fields.map((field) =>
        compactConfigField(field, definition.configDefaults as Record<string, StudioJsonValue>)
      ),
    },
  };
}

const builtInRegistry = new StudioNodeRegistry();
registerBuiltInStudioNodes(builtInRegistry);

export const STUDIO_PROJECT_AGENT_GUIDE = {
  schema: AGENT_GUIDE_SCHEMA,
  guideIsGenerated: true,
  purpose: "This .systemsculpt JSON document is the complete editable Studio project. Read it, understand the canvas, and edit it like any other JSON file.",
  editingContract: {
    editOnlyThisFile: true,
    preserveStableFields: [
      "schema",
      "projectId",
      "createdAt",
      "engine",
      "permissionsRef",
      "settings",
      "migrations",
    ],
    editableFields: [
      "name",
      "updatedAt",
      "graph.nodes",
      "graph.edges",
      "graph.entryNodeIds",
      "graph.groups",
    ],
    generatedFields: ["agentGuide", "nodeKindReference"],
    saveRule: "Save the complete valid JSON document back to this .systemsculpt file.",
  },
  content: {
    nodeTitle: "node.title is the human-facing canvas label.",
    nodeConfig: "node.config holds the node's authored content and settings; use nodeKindReference to find allowed keys and defaults.",
    paths: "Paths are vault-relative unless the referenced config field explicitly allows vault_or_external_desktop.",
  },
  canvas: {
    coordinateSystem: "Canvas pixels with origin at the top-left; x increases right and y increases down.",
    position: "node.position is the top-left corner of the node card.",
    size: "node.size is optional. Omit it to use the kind default; width is required when size is present and height may be omitted for intrinsic-height content.",
    layout: "Prefer left-to-right execution flow. Resolve node dimensions before placement, avoid overlap, use about 90px between columns and at least 20px between rows.",
    newNodes: "After this file is edited, Studio selects and frames newly added node IDs.",
  },
  graph: {
    ids: "All node, edge, and group IDs must be non-empty and unique. Keep existing IDs stable; use descriptive deterministic IDs for additions.",
    edges: "Edges are executable data flow only: fromNodeId/fromPortId must name an output port and toNodeId/toPortId an input port from nodeKindReference. Port types must match unless either type is any.",
    entryNodeIds: "Entry IDs must reference existing executable nodes and identify intended run starting points.",
    visualOnlyNodes: "Visual-only nodes have no executable ports. Use text nodes and groups for architecture annotations; do not invent port IDs.",
    groups: "A group is {id,name,color?,nodeIds}. Membership, not geometry, defines its bounds. Every nodeId must exist, a node should belong to at most one group, and color must be #rgb or #rrggbb.",
  },
  referenceField: "nodeKindReference",
} as const;

export const STUDIO_PROJECT_NODE_KIND_REFERENCE = {
  schema: NODE_REFERENCE_SCHEMA,
  sizeLimits: {
    standard: resolveStudioGraphNodeResizeBounds({ kind: "studio.input" }),
    large: resolveStudioGraphNodeResizeBounds({ kind: "studio.json" }),
    text: resolveStudioGraphNodeResizeBounds({ kind: "studio.text" }),
    terminal: resolveStudioGraphNodeResizeBounds({ kind: "studio.terminal" }),
  },
  kinds: builtInRegistry.list()
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.version.localeCompare(right.version))
    .map(createNodeKindReference),
};

export function createAgentFacingStudioProjectDocument(project: StudioProjectV1): Record<string, unknown> {
  const { schema, ...projectFields } = project;
  return {
    schema,
    agentGuide: STUDIO_PROJECT_AGENT_GUIDE,
    ...projectFields,
    nodeKindReference: STUDIO_PROJECT_NODE_KIND_REFERENCE,
  };
}

export function validateStudioProjectForAgentEdit(project: StudioProjectV1): void {
  new StudioGraphCompiler().compile(project, builtInRegistry);
  const nodesById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  for (const entryNodeId of project.graph.entryNodeIds) {
    const entryNode = nodesById.get(entryNodeId);
    if (!entryNode) {
      throw new Error(`Entry node "${entryNodeId}" does not exist.`);
    }
    if (isStudioVisualOnlyNodeKind(entryNode.kind)) {
      throw new Error(`Entry node "${entryNodeId}" must be executable, not visual-only.`);
    }
  }
}
