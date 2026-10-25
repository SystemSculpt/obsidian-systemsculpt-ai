export type AgentRunPhase =
  | "submitted"
  | "thinking"
  | "working"
  | "waiting"
  | "retrying"
  | "settling"
  | "complete";

type AgentRunStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "cancelled"
  | "failed";

type AgentToolState =
  | "input-streaming"
  | "input-ready"
  | "approval-required"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "outcome-unknown";

export type AgentArtifact = Readonly<{
  id: string;
  kind: "vault_file" | "diff" | "generated_file" | "web_source";
  title: string;
  description?: string;
  path?: string;
  mimeType?: string;
}>;

export type ManagedAgentError = Readonly<{
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  /** Plugin-created local diagnostics report id (report_<32 hex>). */
  reportId?: string;
  /** Server-issued support id from the failed terminal (incident_<32 hex>). */
  incidentId?: string;
}>;

export type ToolResultSummary = Readonly<{
  title?: string;
  summary?: string;
  data?: unknown;
  artifacts?: readonly AgentArtifact[];
}>;

type AgentPartBase = Readonly<{
  id: string;
  order: number;
}>;

export type AgentTextPart = AgentPartBase & Readonly<{
  kind: "text";
  messageId: string;
  state: "streaming" | "complete";
  markdown: string;
}>;

type AgentReasoningPart = AgentPartBase & Readonly<{
  kind: "reasoning";
  messageId: string;
  state: "streaming" | "complete";
  summary: string;
}>;

export type NativeToolMetadata = Readonly<{
  agent: "claude" | "codex";
  workingDirectory: string;
  /** Presentation roots supplied by Chat, never native permission authority. */
  vaultRoot?: string;
  vaultRootAlias?: string;
  /** Lets paths outside the vault read as ~/…; presentation only. */
  homeDirectory?: string;
  requestMethod?: string;
  requestId?: string | number;
  description?: string;
  permissionSuggestions?: readonly Record<string, unknown>[];
}>;

export type AgentApprovalDecision = "approved" | "denied" | "withdrawn";

export type AgentToolPart = AgentPartBase & Readonly<{
  kind: "tool";
  messageId: string;
  callId: string;
  name: string;
  location: "server" | "vault";
  input: unknown;
  inputText?: string;
  state: AgentToolState;
  approvalId?: string;
  approvalDecision?: AgentApprovalDecision;
  approvalScope?: "session";
  native?: NativeToolMetadata;
  output?: ToolResultSummary;
  error?: ManagedAgentError;
}>;

type AgentErrorPart = AgentPartBase & Readonly<{
  kind: "error";
  error: ManagedAgentError;
  retryable: boolean;
  retryMessageId?: string;
}>;

export type AgentPart =
  | AgentReasoningPart
  | AgentTextPart
  | AgentToolPart
  | AgentErrorPart;

type AgentMessageProjection = Readonly<{
  id: string;
  role: "assistant";
  partIds: readonly string[];
}>;

export type AgentConversationSnapshot = Readonly<{
  runId: string | null;
  turnId: string | null;
  status: AgentRunStatus;
  elapsedMs?: number;
  phase?: AgentRunPhase;
  statusLabel?: string;
  waitingReason?: "approval" | "local_tool";
  terminalError?: ManagedAgentError;
  messages: readonly AgentMessageProjection[];
  parts: readonly AgentPart[];
}>;
