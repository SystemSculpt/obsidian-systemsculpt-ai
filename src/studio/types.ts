import type { HostCapability } from "../platform/hostCapabilities";

export const STUDIO_PROJECT_EXTENSION = ".systemsculpt" as const;
export const STUDIO_DISPLAY_NAME = "Studio" as const;
export const STUDIO_PROJECT_SCHEMA_V1 = "studio.project.v1" as const;
export const STUDIO_PROJECT_SCHEMA_V2 = "studio.project.v2" as const;
export const STUDIO_POLICY_SCHEMA_V1 = "studio.policy.v1" as const;

export const STUDIO_PORT_DATA_TYPES = [
  'any',
  'text',
  'number',
  'boolean',
  'json',
  'image_ref',
  'audio_ref',
  'video_ref',
  'binary_ref'
] as const

export type StudioPortDataType = (typeof STUDIO_PORT_DATA_TYPES)[number]

const STUDIO_PORT_DATA_TYPE_SET: ReadonlySet<string> = new Set(STUDIO_PORT_DATA_TYPES)

export const STUDIO_DYNAMIC_PORT_MAX_COUNT = 32
export const STUDIO_DYNAMIC_PORT_ID_SOURCE = '[A-Za-z][A-Za-z0-9_-]{0,63}'
export const STUDIO_DYNAMIC_PORT_ID_PATTERN = new RegExp(`^${STUDIO_DYNAMIC_PORT_ID_SOURCE}$`)

const STUDIO_FILE_REFERENCE_PORT_DATA_TYPES: ReadonlySet<string> = new Set([
  'image_ref',
  'audio_ref',
  'video_ref',
  'binary_ref'
])

export function isStudioPortDataType(value: unknown): value is StudioPortDataType {
  return typeof value === 'string' && STUDIO_PORT_DATA_TYPE_SET.has(value)
}

export function isStudioDynamicPortId(value: unknown): value is string {
  return typeof value === 'string' && STUDIO_DYNAMIC_PORT_ID_PATTERN.test(value)
}

export function isStudioFileReferencePortDataType(
  value: unknown
): value is Extract<StudioPortDataType, `${string}_ref`> {
  return typeof value === 'string' && STUDIO_FILE_REFERENCE_PORT_DATA_TYPES.has(value)
}

export type StudioCapability = "cli" | "filesystem";
export type StudioNodeCapabilityClass = "local_cpu" | "local_io" | "api";
export type StudioRunStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type StudioPrimitiveValue = string | number | boolean | null;
export type StudioJsonValue =
  | StudioPrimitiveValue
  | StudioJsonValue[]
  | { [key: string]: StudioJsonValue };

export type StudioNodeOutputMap = Record<string, StudioJsonValue>;
export type StudioNodeInputMap = Record<string, StudioJsonValue>;

export type StudioNodePosition = {
  x: number;
  y: number;
};

export type StudioNodeSize = {
  width: number;
  /**
   * Explicit rendered height. Optional: kinds with intrinsic height (text —
   * content reflow) or aspect-driven height (image/video media cards) persist
   * width only and let the DOM derive the height.
   */
  height?: number;
};

export type StudioPortDefinition = {
  id: string;
  type: StudioPortDataType;
  required?: boolean;
  description?: string;
};

export const STUDIO_PROCESS_FIXED_OUTPUT_PORTS = [
  { id: 'stdout', type: 'text', description: 'Captured standard output.' },
  { id: 'stderr', type: 'text', description: 'Captured standard error.' },
  { id: 'exit_code', type: 'number', description: 'The process exit code.' },
  {
    id: 'timed_out',
    type: 'boolean',
    description: 'Whether the configured timeout ended the process.'
  }
] as const satisfies readonly StudioPortDefinition[]

export function isStudioProcessFixedOutputPortId(value: string): boolean {
  return STUDIO_PROCESS_FIXED_OUTPUT_PORTS.some((port) => port.id === value)
}

export type StudioNodeConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "json_object"
  | "port_list"
  | "string_list"
  | "select"
  | "file_path"
  | "directory_path"
  | "media_path"
  | "note_selector";

export type StudioNodeConfigMediaKind = "image" | "video" | "audio";

export type StudioNodeConfigSelectOption = {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  keywords?: string[];
};

export type StudioNodeConfigSelectPresentation =
  | "dropdown"
  | "button_group"
  | "searchable_dropdown"
  /** A catalog modal with search, sorting, favorites, and per-model detail. */
  | "model_picker_modal";
export type StudioNodeConfigDynamicOptionsSource =
  | "image_models"
  | "image_sizes"
  | "image_aspect_ratios"
  | "image_qualities"
  | "video_generation_models"
  | "video_generation_durations"
  | "video_generation_resolutions"
  | "video_generation_aspect_ratios";
export type StudioNodeConfigFieldVisibilityRule = {
  key: string;
  equals: StudioPrimitiveValue | StudioPrimitiveValue[];
};

export type StudioNodeConfigFieldDefinition = {
  key: string;
  label: string;
  description?: string;
  type: StudioNodeConfigFieldType;
  inputType?: "text" | "password";
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options?: StudioNodeConfigSelectOption[];
  selectPresentation?: StudioNodeConfigSelectPresentation;
  optionsSource?: StudioNodeConfigDynamicOptionsSource;
  visibleWhen?: StudioNodeConfigFieldVisibilityRule;
  accept?: string;
  mediaKinds?: StudioNodeConfigMediaKind[];
  allowOutsideVault?: boolean;
  portDirection?: "input" | "output";
};

export type StudioNodeConfigSchema = {
  fields: StudioNodeConfigFieldDefinition[];
  allowUnknownKeys?: boolean;
};

export type StudioNodeConfigValidationError = {
  fieldKey: string;
  message: string;
};

export type StudioNodeConfigValidationResult = {
  isValid: boolean;
  errors: StudioNodeConfigValidationError[];
};

export type StudioNodeInstance = {
  id: string;
  kind: string;
  version: string;
  title: string;
  position: StudioNodePosition;
  /** Organizational parent; never an execution dependency. */
  parentId?: string;
  /**
   * Rendered card size on the canvas. Layout geometry is canvas data (like
   * position), not node config; absent means "use the kind's default size"
   * from src/studio/StudioNodeGeometry.ts.
   */
  size?: StudioNodeSize;
  config: Record<string, StudioJsonValue>;
  continueOnError?: boolean;
  disabled?: boolean;
};

export type StudioEdge = {
  id: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
};

/**
 * A group frames whatever the user selected, so it can hold nodes, diagram
 * shapes, or both. It stays in `graph` because it is pure presentation for the
 * canvas either way, and the compiler ignores it.
 */
export type StudioNodeGroup = {
  id: string;
  name: string;
  color?: string;
  nodeIds: string[];
  shapeIds?: string[];
};

export type StudioGraph = {
  nodes: StudioNodeInstance[];
  edges: StudioEdge[];
  entryNodeIds: string[];
  groups?: StudioNodeGroup[];
  layout?: StudioGraphLayout;
};

/** Presentation constraints; absent means the existing free-placement canvas. */
export type StudioGraphLayout = {
  mode: "manual" | "managed";
  pinnedNodeIds?: string[];
  direction?: "right" | "down";
  columnGap?: number;
  rowGap?: number;
  sectionGap?: number;
};

/**
 * Diagram layer — the tldraw half of Studio, stored beside the graph and
 * never part of it. A shape is not a node: no kind, no version, no ports, no
 * config, no registry definition, and no path into the compiler or runtime.
 * Behavior lives in src/studio/StudioShapes.ts.
 */
export type StudioShapeKind =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "pill"
  | "cylinder"
  | "note"
  | "hexagon";

export type StudioShapeInstance = {
  id: string;
  shape: StudioShapeKind;
  position: StudioNodePosition;
  /** Both dimensions are explicit: a shape is drawn, never content-sized. */
  size: { width: number; height: number };
  label: string;
  /** Reserved for shape properties (fill, stroke, font). Preserved verbatim. */
  style?: Record<string, StudioJsonValue>;
};

/** Visual connector between nodes or shapes; never an executable graph edge. */
export type StudioShapeArrow = {
  id: string;
  /** Canvas item IDs (node or shape); field names retained for saved-project compatibility. */
  fromShapeId: string;
  toShapeId: string;
  /** Optional text drawn at the arrow's midpoint. */
  label?: string;
};

export type StudioDiagram = {
  shapes: StudioShapeInstance[];
  arrows: StudioShapeArrow[];
};

export type StudioCapabilityGrant = {
  id: string;
  capability: StudioCapability;
  scope: {
    allowedPaths?: string[];
    allowedCommandPatterns?: string[];
  };
  grantedAt: string;
  grantedByUser: boolean;
};

export type StudioPermissionPolicyV1 = {
  schema: typeof STUDIO_POLICY_SCHEMA_V1;
  version: 1;
  updatedAt: string;
  grants: StudioCapabilityGrant[];
};

export type StudioProjectV1 = {
  schema: typeof STUDIO_PROJECT_SCHEMA_V1;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  engine: {
    apiMode: "systemsculpt_only";
    minPluginVersion: string;
  };
  graph: StudioGraph;
  /**
   * Canvas diagram layer. Optional because projects persisted before shapes
   * existed have none; src/studio/StudioShapes.ts is the only reader/writer.
   */
  diagram?: StudioDiagram;
  permissionsRef: {
    policyVersion: number;
    policyPath: string;
  };
  settings: {
    runConcurrency: "adaptive";
    defaultFsScope: "vault";
    retention: {
      maxRuns: number;
      maxArtifactsMb: number;
    };
  };
  migrations: {
    projectSchemaVersion: string;
    applied: Array<{ id: string; at: string }>;
  };
};

export type StudioProject = StudioProjectV1;

export type StudioProjectLintResult =
  | {
      ok: true;
      project: StudioProjectV1;
    }
  | {
      ok: false;
      error: string;
    };

export type StudioAssetRef = {
  hash: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
};

export type StudioRunSnapshotV1 = {
  schema: "studio.run.v1";
  runId: string;
  projectPath: string;
  projectId: string;
  createdAt: string;
  project: StudioProjectV1;
  policy: StudioPermissionPolicyV1;
};

export type StudioRunEvent =
  | { type: "run.started"; runId: string; at: string }
  | { type: "run.failed"; runId: string; error: string; errorStack?: string; at: string }
  | { type: "run.completed"; runId: string; status: "success" | "failed" | "cancelled"; at: string }
  | { type: "node.progress"; runId: string; nodeId: string; percent: number; message?: string; at: string }
  | { type: "node.started"; runId: string; nodeId: string; at: string }
  | { type: "node.cache_hit"; runId: string; nodeId: string; cacheUpdatedAt: string; at: string }
  | {
      type: "node.output";
      runId: string;
      nodeId: string;
      outputRef: string;
      outputSource?: "execution" | "cache";
      outputs?: StudioNodeOutputMap;
      managedOperations?: StudioManagedOperationRef[];
      at: string;
    }
  | { type: "node.failed"; runId: string; nodeId: string; error: string; errorStack?: string; at: string };

export type StudioNodeResult = {
  outputs: StudioNodeOutputMap;
  artifacts?: StudioAssetRef[];
  managedOperations?: StudioManagedOperationRef[];
};

export type StudioNodeCachePolicy = "by_inputs" | "never";

export type StudioNodeCacheEntry = {
  nodeId: string;
  nodeKind: string;
  nodeVersion: string;
  inputFingerprint: string;
  outputs: StudioNodeOutputMap;
  artifacts?: StudioAssetRef[];
  updatedAt: string;
  runId: string;
};

export type StudioNodeCacheSnapshotV1 = {
  schema: "studio.node-cache.v1";
  projectId: string;
  updatedAt: string;
  entries: Record<string, StudioNodeCacheEntry>;
};

export type StudioManagedOperationRef = {
  capability: "text_generation" | "image_generation" | "video_generation" | "transcription";
  operationId: string;
};

export type StudioTextGenerationRequest = {
  projectId?: string;
  log?: (text: string) => void;
  runId: string;
  nodeId: string;
  projectPath: string;
  signal: AbortSignal;
  buildPayload: () => Promise<{ prompt: string; systemPrompt?: string }> | { prompt: string; systemPrompt?: string };
};

export type StudioTextGenerationResult = {
  text: string;
  operation?: StudioManagedOperationRef;
};

export type StudioImageGenerationInput = {
  asset: StudioAssetRef;
  load: () => Promise<ArrayBuffer>;
};

export type StudioImageGenerationRequest = {
  runId: string;
  nodeId: string;
  projectPath: string;
  signal: AbortSignal;
  buildPayload: () => Promise<{
    prompt: string;
    model?: string;
    imageSize?: string;
    quality?: string;
    count?: number;
    aspectRatio?: string;
    inputImages?: StudioImageGenerationInput[];
  }>;
  storeOutput: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
};

export type StudioImageGenerationResult = {
  images: StudioAssetRef[];
  operation: StudioManagedOperationRef;
};

export type StudioVideoFrameInput = {
  role: "first_frame" | "last_frame";
  asset: StudioAssetRef;
  load: () => Promise<ArrayBuffer>;
};

/** Progress the server publishes while a video job runs. */
export type StudioVideoGenerationProgress = {
  status: string;
  typicalDurationMs?: number;
};

export type StudioVideoGenerationRequest = {
  runId: string;
  nodeId: string;
  projectPath: string;
  signal: AbortSignal;
  buildPayload: () => Promise<{
    /** Server catalog model ID. Required: video generation has no server default. */
    model: string;
    prompt: string;
    durationSeconds?: number;
    resolution?: string;
    aspectRatio?: string;
    generateAudio?: boolean;
    frameImages?: StudioVideoFrameInput[];
  }>;
  storeOutput: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
  onProgress?: (progress: StudioVideoGenerationProgress) => void;
};

export type StudioVideoGenerationResult = {
  videos: StudioAssetRef[];
  operation: StudioManagedOperationRef;
};

export type StudioTranscriptionRequest = {
  runId: string;
  nodeId: string;
  projectPath: string;
  signal: AbortSignal;
  source: {
    identity: string;
    fingerprint: () => string | Promise<string>;
    load: () => Promise<{ filename: string; contentType: string; bytes: ArrayBuffer }>;
    release?: () => void;
  };
};

export type StudioTranscriptionResult = {
  text: string;
  operation: StudioManagedOperationRef;
};

export type StudioCliExecutionRequest = {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  input?: string;
  requireExactCommandGrant?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type StudioCliExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export interface StudioApiAdapter {
  generateText(request: StudioTextGenerationRequest): Promise<StudioTextGenerationResult>;
  generateImage(request: StudioImageGenerationRequest): Promise<StudioImageGenerationResult>;
  generateVideo(request: StudioVideoGenerationRequest): Promise<StudioVideoGenerationResult>;
  transcribeAudio(request: StudioTranscriptionRequest): Promise<StudioTranscriptionResult>;
  beginLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void>;
  completeLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void>;
}

export interface StudioNodeExecutionServices {
  codex?: (input: import("../services/codex/LocalCodexClient").CodexRequest, signal: AbortSignal, log: (text: string) => void) => Promise<import("../services/codex/LocalCodexClient").CodexResult>;
  api: StudioApiAdapter;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  resolveAbsolutePath: (path: string) => string;
  readVaultText: (vaultPath: string) => Promise<string>;
  statVaultFileSize: (vaultPath: string) => Promise<number>;
  readVaultBinary: (vaultPath: string) => Promise<ArrayBuffer>;
  statLocalFileSize: (absolutePath: string) => Promise<number>;
  readLocalFileBinary: (absolutePath: string, maxBytes?: number) => Promise<ArrayBuffer>;
  writeTempFile: (
    bytes: ArrayBuffer,
    options?: {
      prefix?: string;
      extension?: string;
    }
  ) => Promise<string>;
  deleteLocalFile: (absolutePath: string) => Promise<void>;
  runCli: (request: StudioCliExecutionRequest) => Promise<StudioCliExecutionResult>;
  assertFilesystemPath: (path: string) => void;
}

export type StudioNodeExecutionContext = {
  projectId?: string;
  runId: string;
  projectPath: string;
  node: StudioNodeInstance;
  inputs: StudioNodeInputMap;
  signal: AbortSignal;
  services: StudioNodeExecutionServices;
  log: (message: string, stream?: "stdout" | "stderr" | "system") => void;
  reportProgress?: (percent: number, message?: string) => void;
};

export type StudioNodeDefinition<TConfig = Record<string, StudioJsonValue>> = {
  kind: string;
  version: string;
  hiddenFromInsertMenu?: boolean;
  requiredHostCapabilities: readonly HostCapability[];
  capabilityClass: StudioNodeCapabilityClass;
  cachePolicy?: StudioNodeCachePolicy;
  inputPorts: StudioPortDefinition[];
  outputPorts: StudioPortDefinition[];
  configDefaults: TConfig;
  configSchema: StudioNodeConfigSchema;
  execute: (context: StudioNodeExecutionContext) => Promise<StudioNodeResult>;
};

export type StudioRunEventHandler = (event: StudioRunEvent) => void | Promise<void>;

export type StudioRunOptions = {
  entryNodeIds?: string[];
  forceNodeIds?: string[];
  onEvent?: StudioRunEventHandler;
};

export type StudioRunSummary = {
  runId: string;
  status: StudioRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  executedNodeIds?: string[];
  cachedNodeIds?: string[];
};
