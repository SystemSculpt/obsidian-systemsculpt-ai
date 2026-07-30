export type AgentRunPhase =
  | "submitted"
  | "thinking"
  | "working"
  | "waiting"
  | "retrying"
  | "settling"
  | "complete";

export type AgentRunStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentToolState =
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

export type AgentReasoningPart = AgentPartBase & Readonly<{
  kind: "reasoning";
  messageId: string;
  state: "streaming" | "complete";
  summary: string;
}>;

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
  output?: ToolResultSummary;
  error?: ManagedAgentError;
}>;

export type AgentErrorPart = AgentPartBase & Readonly<{
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

export type AgentMessageProjection = Readonly<{
  id: string;
  role: "assistant";
  partIds: readonly string[];
}>;

export type AgentConversationSnapshot = Readonly<{
  runId: string | null;
  turnId: string | null;
  status: AgentRunStatus;
  phase?: AgentRunPhase;
  statusLabel?: string;
  waitingReason?: "approval" | "local_tool";
  terminalError?: ManagedAgentError;
  messages: readonly AgentMessageProjection[];
  parts: readonly AgentPart[];
}>;

export function createInitialAgentConversation(): AgentConversationSnapshot {
  return Object.freeze({
    runId: null,
    turnId: null,
    status: "idle",
    messages: Object.freeze([]),
    parts: Object.freeze([]),
  });
}

export function selectAgentPart(
  snapshot: AgentConversationSnapshot,
  partId: string,
): AgentPart | undefined {
  return snapshot.parts.find((part) => part.id === partId);
}

export function selectAgentMessageParts(
  snapshot: AgentConversationSnapshot,
  messageId: string,
): readonly AgentPart[] {
  const message = snapshot.messages.find((candidate) => candidate.id === messageId);
  if (!message) return [];
  const partIds = new Set(message.partIds);
  return snapshot.parts.filter((part) => partIds.has(part.id));
}

export function selectToolCall(
  snapshot: AgentConversationSnapshot,
  callId: string,
): AgentToolPart | undefined {
  return snapshot.parts.find((part): part is AgentToolPart =>
    part.kind === "tool" && part.callId === callId);
}

export function selectPendingApprovals(
  snapshot: AgentConversationSnapshot,
): readonly AgentToolPart[] {
  return snapshot.parts.filter((part): part is AgentToolPart =>
    part.kind === "tool" && part.state === "approval-required");
}

export function isAgentConversationTerminal(snapshot: AgentConversationSnapshot): boolean {
  return snapshot.status === "completed"
    || snapshot.status === "cancelled"
    || snapshot.status === "failed";
}
