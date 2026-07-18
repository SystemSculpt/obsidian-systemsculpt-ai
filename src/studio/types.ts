import type { HostCapability } from "../platform/hostCapabilities";

export const STUDIO_PROJECT_EXTENSION = ".systemsculpt" as const;
export const STUDIO_PROJECT_SCHEMA_V1 = "studio.project.v1" as const;
export const STUDIO_POLICY_SCHEMA_V1 = "studio.policy.v1" as const;

export type StudioPortDataType =
  | "text"
  | "number"
  | "boolean"
  | "json"
  | "image_ref"
  | "audio_ref"
  | "video_ref"
  | "binary_ref"
  | "any";

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

export type StudioNodeConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "json_object"
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
  | "searchable_dropdown";
export type StudioNodeConfigDynamicOptionsSource = never;
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

export type StudioNodeGroup = {
  id: string;
  name: string;
  color?: string;
  nodeIds: string[];
};

export type StudioGraph = {
  nodes: StudioNodeInstance[];
  edges: StudioEdge[];
  entryNodeIds: string[];
  groups?: StudioNodeGroup[];
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
  capability: "text_generation" | "image_generation" | "transcription";
  operationId: string;
};

export type StudioTextGenerationRequest = {
  runId: string;
  nodeId: string;
  projectPath: string;
  signal: AbortSignal;
  buildPayload: () => Promise<{ prompt: string; systemPrompt?: string }> | { prompt: string; systemPrompt?: string };
};

export type StudioTextGenerationResult = {
  text: string;
  operation: StudioManagedOperationRef;
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
    count?: number;
    aspectRatio?: string;
    imageSize?: "1K";
    seed?: number;
    inputImages?: StudioImageGenerationInput[];
  }>;
  storeOutput: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
};

export type StudioImageGenerationResult = {
  images: StudioAssetRef[];
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
};

export type StudioCliExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export interface StudioApiAdapter {
  generateText(request: StudioTextGenerationRequest): Promise<StudioTextGenerationResult>;
  generateImage(request: StudioImageGenerationRequest): Promise<StudioImageGenerationResult>;
  transcribeAudio(request: StudioTranscriptionRequest): Promise<StudioTranscriptionResult>;
  beginLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void>;
  completeLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void>;
}

export interface StudioNodeExecutionServices {
  api: StudioApiAdapter;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  resolveAbsolutePath: (path: string) => string;
  readVaultText: (vaultPath: string) => Promise<string>;
  statVaultFileSize: (vaultPath: string) => Promise<number>;
  readVaultBinary: (vaultPath: string) => Promise<ArrayBuffer>;
  statLocalFileSize: (absolutePath: string) => Promise<number>;
  readLocalFileBinary: (absolutePath: string) => Promise<ArrayBuffer>;
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
  runId: string;
  projectPath: string;
  node: StudioNodeInstance;
  inputs: StudioNodeInputMap;
  signal: AbortSignal;
  services: StudioNodeExecutionServices;
  log: (message: string) => void;
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
