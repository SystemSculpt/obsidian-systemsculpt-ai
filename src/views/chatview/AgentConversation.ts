export const MANAGED_AGENT_EVENT_VERSION = 1 as const;

export type AgentRunPhase =
  | "submitted"
  | "thinking"
  | "working"
  | "waiting"
  | "retrying"
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

export type AgentUsage = Readonly<{
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costTotal?: number;
}>;

export type ManagedAgentError = Readonly<{
  code: string;
  message: string;
  requestId?: string;
}>;

export type ToolResultSummary = Readonly<{
  title?: string;
  summary?: string;
  data?: unknown;
  artifacts?: readonly AgentArtifact[];
}>;

export type ManagedToolCall = Readonly<{
  callId: string;
  partId: string;
  messageId: string;
  name: string;
  location: "server" | "vault";
  input: unknown;
}>;

export type ManagedAgentEvent =
  | Readonly<{ type: "run.started" }>
  | Readonly<{ type: "run.status"; phase: AgentRunPhase; label: string }>
  | Readonly<{ type: "message.started"; messageId: string; role: "assistant" }>
  | Readonly<{ type: "message.restarted"; messageId: string }>
  | Readonly<{ type: "reasoning.delta"; messageId: string; partId: string; delta: string }>
  | Readonly<{ type: "reasoning.completed"; messageId: string; partId: string }>
  | Readonly<{ type: "text.delta"; messageId: string; partId: string; delta: string }>
  | Readonly<{ type: "text.completed"; messageId: string; partId: string }>
  | Readonly<{
      type: "tool.input.started";
      callId: string;
      partId: string;
      messageId: string;
      name: string;
      location: "server" | "vault";
    }>
  | Readonly<{
      type: "tool.input.delta";
      callId: string;
      partId: string;
      messageId: string;
      name: string;
      location: "server" | "vault";
      delta: string;
    }>
  | Readonly<{ type: "tool.requested"; call: ManagedToolCall }>
  | Readonly<{ type: "approval.requested"; callId: string; approvalId: string }>
  | Readonly<{ type: "approval.resolved"; approvalId: string; approved: boolean }>
  | Readonly<{ type: "tool.started"; callId: string }>
  | Readonly<{ type: "tool.succeeded"; callId: string; result: ToolResultSummary }>
  | Readonly<{ type: "tool.failed"; callId: string; error: ManagedAgentError; result?: ToolResultSummary }>
  | Readonly<{ type: "usage.updated"; usage: AgentUsage }>
  | Readonly<{ type: "run.waiting"; reason: "approval" | "local_tool" }>
  | Readonly<{ type: "run.completed" }>
  | Readonly<{ type: "run.cancelled" }>
  | Readonly<{ type: "run.failed"; error: ManagedAgentError }>;

export type ManagedAgentEventEnvelope = Readonly<{
  version: typeof MANAGED_AGENT_EVENT_VERSION;
  seq: number;
  runId: string;
  turnId: string;
  emittedAt: number;
  event: ManagedAgentEvent;
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

export type AgentStatusPart = AgentPartBase & Readonly<{
  kind: "status";
  phase: AgentRunPhase;
  label: string;
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
  | AgentStatusPart
  | AgentToolPart
  | AgentErrorPart;

type UnorderedAgentPart = AgentPart extends infer Part
  ? Part extends AgentPart
    ? Omit<Part, "order">
    : never
  : never;

export type AgentMessageProjection = Readonly<{
  id: string;
  role: "assistant";
  partIds: readonly string[];
}>;

export type AgentConversationSnapshot = Readonly<{
  version: typeof MANAGED_AGENT_EVENT_VERSION;
  runId: string | null;
  turnId: string | null;
  lastSeq: number;
  status: AgentRunStatus;
  phase?: AgentRunPhase;
  statusLabel?: string;
  waitingReason?: "approval" | "local_tool";
  usage?: AgentUsage;
  terminalError?: ManagedAgentError;
  messages: readonly AgentMessageProjection[];
  parts: readonly AgentPart[];
  acceptedEventFingerprints: Readonly<Record<string, string>>;
  nextPartOrder: number;
}>;

export type AgentConversationProtocolErrorCode =
  | "unsupported_version"
  | "invalid_envelope"
  | "identity_mismatch"
  | "out_of_order"
  | "sequence_conflict"
  | "illegal_transition"
  | "unknown_event"
  | "missing_entity";

export class AgentConversationProtocolError extends Error {
  constructor(
    public readonly code: AgentConversationProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentConversationProtocolError";
  }
}

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "cancelled", "failed"]);
const RUN_PHASES = new Set<AgentRunPhase>([
  "submitted",
  "thinking",
  "working",
  "waiting",
  "retrying",
  "complete",
]);
const TOOL_LOCATIONS = new Set<ManagedToolCall["location"]>(["server", "vault"]);

function protocolError(code: AgentConversationProtocolErrorCode, message: string): never {
  throw new AgentConversationProtocolError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    protocolError("invalid_envelope", `${field} must be a non-empty string.`);
  }
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    protocolError("illegal_transition", `${field} must be a finite non-negative number.`);
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function freezeSnapshot(snapshot: AgentConversationSnapshot): AgentConversationSnapshot {
  return Object.freeze({
    ...snapshot,
    messages: Object.freeze(snapshot.messages.map((message) => Object.freeze({
      ...message,
      partIds: Object.freeze([...message.partIds]),
    }))),
    parts: Object.freeze(snapshot.parts.map((part) => Object.freeze(part))),
    acceptedEventFingerprints: Object.freeze({ ...snapshot.acceptedEventFingerprints }),
  });
}

export function createInitialAgentConversation(): AgentConversationSnapshot {
  return freezeSnapshot({
    version: MANAGED_AGENT_EVENT_VERSION,
    runId: null,
    turnId: null,
    lastSeq: 0,
    status: "idle",
    messages: [],
    parts: [],
    acceptedEventFingerprints: {},
    nextPartOrder: 0,
  });
}

function validateEnvelope(envelope: ManagedAgentEventEnvelope): void {
  if (!isRecord(envelope)) {
    protocolError("invalid_envelope", "Managed agent event envelope must be an object.");
  }
  if (envelope.version !== MANAGED_AGENT_EVENT_VERSION) {
    protocolError("unsupported_version", `Unsupported managed agent event version: ${String(envelope.version)}.`);
  }
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) {
    protocolError("invalid_envelope", "Managed agent event sequence must be a positive safe integer.");
  }
  assertNonEmptyString(envelope.runId, "runId");
  assertNonEmptyString(envelope.turnId, "turnId");
  assertFiniteNonNegative(envelope.emittedAt, "emittedAt");
  if (!isRecord(envelope.event) || !isNonEmptyString(envelope.event.type)) {
    protocolError("invalid_envelope", "Managed agent event must contain a type.");
  }
}

function isTerminal(snapshot: AgentConversationSnapshot): boolean {
  return TERMINAL_STATUSES.has(snapshot.status);
}

function assertActive(snapshot: AgentConversationSnapshot, eventType: string): void {
  if (snapshot.status === "idle" || isTerminal(snapshot)) {
    protocolError("illegal_transition", `${eventType} is not valid while the run is ${snapshot.status}.`);
  }
}

function findMessage(snapshot: AgentConversationSnapshot, messageId: string): AgentMessageProjection | undefined {
  return snapshot.messages.find((message) => message.id === messageId);
}

function requireMessage(snapshot: AgentConversationSnapshot, messageId: string): AgentMessageProjection {
  const message = findMessage(snapshot, messageId);
  if (!message) {
    protocolError("missing_entity", `Assistant message ${messageId} has not started.`);
  }
  return message;
}

function findPart(snapshot: AgentConversationSnapshot, partId: string): AgentPart | undefined {
  return snapshot.parts.find((part) => part.id === partId);
}

function findTool(snapshot: AgentConversationSnapshot, callId: string): AgentToolPart | undefined {
  const part = snapshot.parts.find((candidate) => candidate.kind === "tool" && candidate.callId === callId);
  return part?.kind === "tool" ? part : undefined;
}

function requireTool(snapshot: AgentConversationSnapshot, callId: string): AgentToolPart {
  const part = findTool(snapshot, callId);
  if (!part) {
    protocolError("missing_entity", `Tool call ${callId} does not exist.`);
  }
  return part;
}

function replacePart(snapshot: AgentConversationSnapshot, next: AgentPart): AgentConversationSnapshot {
  const index = snapshot.parts.findIndex((part) => part.id === next.id);
  if (index < 0) {
    protocolError("missing_entity", `Agent part ${next.id} does not exist.`);
  }
  const parts = [...snapshot.parts];
  parts[index] = next;
  return { ...snapshot, parts };
}

function appendPart(
  snapshot: AgentConversationSnapshot,
  part: UnorderedAgentPart,
  messageId?: string,
): AgentConversationSnapshot {
  if (findPart(snapshot, part.id)) {
    protocolError("illegal_transition", `Agent part ${part.id} already exists.`);
  }
  const nextPart = { ...part, order: snapshot.nextPartOrder } as AgentPart;
  let messages = snapshot.messages;
  if (messageId) {
    const message = requireMessage(snapshot, messageId);
    messages = snapshot.messages.map((candidate) => candidate.id === messageId
      ? { ...message, partIds: [...message.partIds, nextPart.id] }
      : candidate);
  }
  return {
    ...snapshot,
    messages,
    parts: [...snapshot.parts, nextPart],
    nextPartOrder: snapshot.nextPartOrder + 1,
  };
}

function upsertStatusPart(
  snapshot: AgentConversationSnapshot,
  phase: AgentRunPhase,
  label: string,
): AgentConversationSnapshot {
  const id = `status:${snapshot.turnId ?? "pending"}`;
  const existing = findPart(snapshot, id);
  if (!existing) {
    return appendPart(snapshot, { id, kind: "status", phase, label });
  }
  if (existing.kind !== "status") {
    protocolError("illegal_transition", `Agent part ${id} is not a status part.`);
  }
  return replacePart(snapshot, { ...existing, phase, label });
}

function validateError(error: ManagedAgentError): void {
  if (!isRecord(error)) {
    protocolError("illegal_transition", "Managed agent error must be an object.");
  }
  assertNonEmptyString(error.code, "error.code");
  assertNonEmptyString(error.message, "error.message");
  if (typeof error.requestId !== "undefined") {
    assertNonEmptyString(error.requestId, "error.requestId");
  }
}

function validateUsage(previous: AgentUsage | undefined, next: AgentUsage): void {
  if (!isRecord(next) || Object.keys(next).length === 0) {
    protocolError("illegal_transition", "Usage update must contain at least one value.");
  }
  for (const key of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens", "costTotal"] as const) {
    const value = next[key];
    if (typeof value === "undefined") continue;
    assertFiniteNonNegative(value, `usage.${key}`);
    const previousValue = previous?.[key];
    if (typeof previousValue === "number" && value < previousValue) {
      protocolError("illegal_transition", `usage.${key} cannot decrease.`);
    }
  }
}

function assertToolIdentity(existing: AgentToolPart, call: Omit<ManagedToolCall, "input">): void {
  if (
    existing.callId !== call.callId ||
    existing.id !== call.partId ||
    existing.messageId !== call.messageId ||
    existing.name !== call.name ||
    existing.location !== call.location
  ) {
    protocolError("illegal_transition", `Tool call ${call.callId} changed identity while streaming.`);
  }
}

function hasUnsettledParts(snapshot: AgentConversationSnapshot): boolean {
  return snapshot.parts.some((part) => {
    if (part.kind === "text" || part.kind === "reasoning") return part.state === "streaming";
    if (part.kind !== "tool") return false;
    return [
      "input-streaming",
      "input-ready",
      "approval-required",
      "approved",
      "running",
      "outcome-unknown",
    ].includes(part.state);
  });
}

function reduceEvent(
  snapshot: AgentConversationSnapshot,
  event: ManagedAgentEvent,
): AgentConversationSnapshot {
  switch (event.type) {
    case "run.started":
      if (snapshot.status !== "idle") {
        protocolError("illegal_transition", "run.started is valid only for an idle conversation.");
      }
      return { ...snapshot, status: "running", phase: "submitted" };

    case "run.status": {
      assertActive(snapshot, event.type);
      assertNonEmptyString(event.label, "run.status.label");
      if (!RUN_PHASES.has(event.phase)) {
        protocolError("illegal_transition", `Unsupported run phase: ${String(event.phase)}.`);
      }
      const withStatus = upsertStatusPart(snapshot, event.phase, event.label);
      return {
        ...withStatus,
        status: event.phase === "waiting" ? "waiting" : "running",
        phase: event.phase,
        statusLabel: event.label,
        waitingReason: event.phase === "waiting" ? snapshot.waitingReason : undefined,
      };
    }

    case "message.started":
      assertActive(snapshot, event.type);
      assertNonEmptyString(event.messageId, "message.started.messageId");
      if (event.role !== "assistant") {
        protocolError("illegal_transition", `Unsupported managed message role: ${String(event.role)}.`);
      }
      if (findMessage(snapshot, event.messageId)) {
        protocolError("illegal_transition", `Assistant message ${event.messageId} already exists.`);
      }
      return {
        ...snapshot,
        messages: [...snapshot.messages, { id: event.messageId, role: "assistant", partIds: [] }],
      };

    case "message.restarted": {
      assertActive(snapshot, event.type);
      assertNonEmptyString(event.messageId, "message.restarted.messageId");
      const message = requireMessage(snapshot, event.messageId);
      const removed = new Set(message.partIds);
      const messageParts = snapshot.parts.filter((part) => removed.has(part.id));
      if (messageParts.some((part) => part.kind === "tool" && part.state !== "input-streaming")) {
        protocolError("illegal_transition", "A managed message cannot restart after a tool is ready to execute.");
      }
      return {
        ...snapshot,
        messages: snapshot.messages.map((candidate) => candidate.id === event.messageId
          ? { ...candidate, partIds: [] }
          : candidate),
        parts: snapshot.parts.filter((part) => !removed.has(part.id)),
      };
    }

    case "reasoning.delta": {
      assertActive(snapshot, event.type);
      assertNonEmptyString(event.messageId, "reasoning.delta.messageId");
      assertNonEmptyString(event.partId, "reasoning.delta.partId");
      if (typeof event.delta !== "string" || event.delta.length === 0) {
        protocolError("illegal_transition", "reasoning.delta.delta must be a non-empty string.");
      }
      requireMessage(snapshot, event.messageId);
      const existing = findPart(snapshot, event.partId);
      if (!existing) {
        return appendPart(snapshot, {
          id: event.partId,
          kind: "reasoning",
          messageId: event.messageId,
          state: "streaming",
          summary: event.delta,
        }, event.messageId);
      }
      if (existing.kind !== "reasoning" || existing.messageId !== event.messageId || existing.state !== "streaming") {
        protocolError("illegal_transition", `Reasoning delta cannot update part ${event.partId}.`);
      }
      return replacePart(snapshot, { ...existing, summary: existing.summary + event.delta });
    }

    case "reasoning.completed": {
      assertActive(snapshot, event.type);
      requireMessage(snapshot, event.messageId);
      const existing = findPart(snapshot, event.partId);
      if (!existing || existing.kind !== "reasoning" || existing.messageId !== event.messageId || existing.state !== "streaming") {
        protocolError("illegal_transition", `Reasoning part ${event.partId} is not streaming.`);
      }
      return replacePart(snapshot, { ...existing, state: "complete" });
    }

    case "text.delta": {
      assertActive(snapshot, event.type);
      assertNonEmptyString(event.messageId, "text.delta.messageId");
      assertNonEmptyString(event.partId, "text.delta.partId");
      if (typeof event.delta !== "string" || event.delta.length === 0) {
        protocolError("illegal_transition", "text.delta.delta must be a non-empty string.");
      }
      requireMessage(snapshot, event.messageId);
      const existing = findPart(snapshot, event.partId);
      if (!existing) {
        return appendPart(snapshot, {
          id: event.partId,
          kind: "text",
          messageId: event.messageId,
          state: "streaming",
          markdown: event.delta,
        }, event.messageId);
      }
      if (existing.kind !== "text" || existing.messageId !== event.messageId || existing.state !== "streaming") {
        protocolError("illegal_transition", `Text delta cannot update part ${event.partId}.`);
      }
      return replacePart(snapshot, { ...existing, markdown: existing.markdown + event.delta });
    }

    case "text.completed": {
      assertActive(snapshot, event.type);
      requireMessage(snapshot, event.messageId);
      const existing = findPart(snapshot, event.partId);
      if (!existing || existing.kind !== "text" || existing.messageId !== event.messageId || existing.state !== "streaming") {
        protocolError("illegal_transition", `Text part ${event.partId} is not streaming.`);
      }
      return replacePart(snapshot, { ...existing, state: "complete" });
    }

    case "tool.input.started": {
      assertActive(snapshot, event.type);
      for (const [field, value] of [
        ["tool.input.started.callId", event.callId],
        ["tool.input.started.partId", event.partId],
        ["tool.input.started.messageId", event.messageId],
        ["tool.input.started.name", event.name],
      ] as const) assertNonEmptyString(value, field);
      if (!TOOL_LOCATIONS.has(event.location)) {
        protocolError("illegal_transition", `Unsupported tool location: ${String(event.location)}.`);
      }
      requireMessage(snapshot, event.messageId);
      if (findTool(snapshot, event.callId)) {
        protocolError("illegal_transition", `Tool call ${event.callId} already started.`);
      }
      return appendPart(snapshot, {
        id: event.partId,
        kind: "tool",
        messageId: event.messageId,
        callId: event.callId,
        name: event.name,
        location: event.location,
        input: undefined,
        state: "input-streaming",
      }, event.messageId);
    }

    case "tool.input.delta": {
      assertActive(snapshot, event.type);
      for (const [field, value] of [
        ["tool.input.delta.callId", event.callId],
        ["tool.input.delta.partId", event.partId],
        ["tool.input.delta.messageId", event.messageId],
        ["tool.input.delta.name", event.name],
      ] as const) assertNonEmptyString(value, field);
      if (typeof event.delta !== "string" || event.delta.length === 0) {
        protocolError("illegal_transition", "tool.input.delta.delta must be a non-empty string.");
      }
      if (!TOOL_LOCATIONS.has(event.location)) {
        protocolError("illegal_transition", `Unsupported tool location: ${String(event.location)}.`);
      }
      requireMessage(snapshot, event.messageId);
      const existing = findTool(snapshot, event.callId);
      if (!existing) {
        return appendPart(snapshot, {
          id: event.partId,
          kind: "tool",
          messageId: event.messageId,
          callId: event.callId,
          name: event.name,
          location: event.location,
          input: undefined,
          inputText: event.delta,
          state: "input-streaming",
        }, event.messageId);
      }
      assertToolIdentity(existing, event);
      if (existing.state !== "input-streaming") {
        protocolError("illegal_transition", `Tool call ${event.callId} input is already complete.`);
      }
      return replacePart(snapshot, {
        ...existing,
        inputText: `${existing.inputText ?? ""}${event.delta}`,
      });
    }

    case "tool.requested": {
      assertActive(snapshot, event.type);
      const call = event.call;
      if (!isRecord(call)) protocolError("illegal_transition", "tool.requested.call must be an object.");
      for (const [field, value] of [
        ["tool.requested.call.callId", call.callId],
        ["tool.requested.call.partId", call.partId],
        ["tool.requested.call.messageId", call.messageId],
        ["tool.requested.call.name", call.name],
      ] as const) assertNonEmptyString(value, field);
      if (!TOOL_LOCATIONS.has(call.location)) {
        protocolError("illegal_transition", `Unsupported tool location: ${String(call.location)}.`);
      }
      requireMessage(snapshot, call.messageId);
      const existing = findTool(snapshot, call.callId);
      if (!existing) {
        return appendPart(snapshot, {
          id: call.partId,
          kind: "tool",
          messageId: call.messageId,
          callId: call.callId,
          name: call.name,
          location: call.location,
          input: call.input,
          state: "input-ready",
        }, call.messageId);
      }
      assertToolIdentity(existing, call);
      if (existing.state !== "input-streaming") {
        protocolError("illegal_transition", `Tool call ${call.callId} was requested more than once.`);
      }
      return replacePart(snapshot, { ...existing, input: call.input, state: "input-ready" });
    }

    case "approval.requested": {
      assertActive(snapshot, event.type);
      assertNonEmptyString(event.approvalId, "approval.requested.approvalId");
      const tool = requireTool(snapshot, event.callId);
      if (tool.state !== "input-ready") {
        protocolError("illegal_transition", `Tool call ${event.callId} is not ready for approval.`);
      }
      if (snapshot.parts.some((part) => part.kind === "tool" && part.approvalId === event.approvalId)) {
        protocolError("illegal_transition", `Approval ${event.approvalId} already exists.`);
      }
      return replacePart(snapshot, { ...tool, state: "approval-required", approvalId: event.approvalId });
    }

    case "approval.resolved": {
      assertActive(snapshot, event.type);
      if (typeof event.approved !== "boolean") {
        protocolError("illegal_transition", "approval.resolved.approved must be a boolean.");
      }
      const tool = snapshot.parts.find((part) => part.kind === "tool" && part.approvalId === event.approvalId);
      if (!tool || tool.kind !== "tool") {
        protocolError("missing_entity", `Approval ${event.approvalId} does not exist.`);
      }
      if (tool.state !== "approval-required") {
        protocolError("illegal_transition", `Approval ${event.approvalId} is already resolved.`);
      }
      const updated = replacePart(snapshot, {
        ...tool,
        state: event.approved ? "approved" : "denied",
      });
      return { ...updated, status: "running", waitingReason: undefined };
    }

    case "tool.started": {
      assertActive(snapshot, event.type);
      const tool = requireTool(snapshot, event.callId);
      if (tool.state !== "input-ready" && tool.state !== "approved") {
        protocolError("illegal_transition", `Tool call ${event.callId} cannot start from ${tool.state}.`);
      }
      const updated = replacePart(snapshot, {
        ...tool,
        state: "running",
      });
      return { ...updated, status: "running", waitingReason: undefined };
    }

    case "tool.succeeded": {
      assertActive(snapshot, event.type);
      const tool = requireTool(snapshot, event.callId);
      if (tool.state !== "running") {
        protocolError("illegal_transition", `Tool call ${event.callId} is not running.`);
      }
      return replacePart(snapshot, { ...tool, state: "succeeded", output: event.result });
    }

    case "tool.failed": {
      assertActive(snapshot, event.type);
      validateError(event.error);
      const tool = requireTool(snapshot, event.callId);
      if (tool.state !== "running") {
        protocolError("illegal_transition", `Tool call ${event.callId} is not running.`);
      }
      return replacePart(snapshot, {
        ...tool,
        state: "failed",
        error: event.error,
        ...(event.result ? { output: event.result } : {}),
      });
    }

    case "usage.updated":
      assertActive(snapshot, event.type);
      validateUsage(snapshot.usage, event.usage);
      return { ...snapshot, usage: { ...snapshot.usage, ...event.usage } };

    case "run.waiting":
      assertActive(snapshot, event.type);
      if (event.reason !== "approval" && event.reason !== "local_tool") {
        protocolError("illegal_transition", `Unsupported run waiting reason: ${String(event.reason)}.`);
      }
      return {
        ...snapshot,
        status: "waiting",
        phase: "waiting",
        waitingReason: event.reason,
      };

    case "run.completed": {
      assertActive(snapshot, event.type);
      if (hasUnsettledParts(snapshot)) {
        protocolError("illegal_transition", "A run cannot complete while message or tool parts are unsettled.");
      }
      return {
        ...snapshot,
        status: "completed",
        phase: "complete",
        statusLabel: undefined,
        waitingReason: undefined,
        // Progress belongs to the active lifecycle, not the durable answer.
        // Dropping it at the terminal boundary avoids a one-frame "Done"
        // card while the committed assistant turn replaces the live run.
        parts: snapshot.parts.filter((part) => part.kind !== "status"),
      };
    }

    case "run.cancelled": {
      assertActive(snapshot, event.type);
      const settledParts = snapshot.parts.map((part): AgentPart => {
        if ((part.kind === "text" || part.kind === "reasoning") && part.state === "streaming") {
          return { ...part, state: "complete" };
        }
        if (part.kind === "tool" && !["succeeded", "failed", "denied", "cancelled", "outcome-unknown"].includes(part.state)) {
          return { ...part, state: "cancelled", approvalId: undefined };
        }
        return part;
      });
      const stopped = upsertStatusPart({ ...snapshot, parts: settledParts }, "complete", "Stopped");
      return { ...stopped, status: "cancelled", phase: "complete", waitingReason: undefined };
    }

    case "run.failed": {
      assertActive(snapshot, event.type);
      validateError(event.error);
      const withError = appendPart(snapshot, {
        id: `error:${snapshot.turnId ?? "run"}`,
        kind: "error",
        error: event.error,
        retryable: true,
        ...(snapshot.turnId ? { retryMessageId: snapshot.turnId } : {}),
      });
      return {
        ...withError,
        status: "failed",
        statusLabel: undefined,
        waitingReason: undefined,
        terminalError: event.error,
        parts: withError.parts.filter((part) => part.kind !== "status"),
      };
    }

    default: {
      const unknown = event as { type?: unknown };
      protocolError("unknown_event", `Unsupported managed agent event: ${String(unknown.type)}.`);
    }
  }
}

export function applyManagedAgentEvent(
  snapshot: AgentConversationSnapshot,
  envelope: ManagedAgentEventEnvelope,
): AgentConversationSnapshot {
  validateEnvelope(envelope);
  const fingerprint = stableSerialize(envelope);
  const sequenceKey = String(envelope.seq);

  if (envelope.seq <= snapshot.lastSeq) {
    const accepted = snapshot.acceptedEventFingerprints[sequenceKey];
    if (accepted === fingerprint) return snapshot;
    protocolError("sequence_conflict", `Managed agent sequence ${envelope.seq} conflicts with an accepted event.`);
  }
  if (envelope.seq !== snapshot.lastSeq + 1) {
    protocolError("out_of_order", `Expected managed agent sequence ${snapshot.lastSeq + 1}, received ${envelope.seq}.`);
  }
  if (snapshot.lastSeq === 0) {
    if (envelope.event.type !== "run.started") {
      protocolError("illegal_transition", "The first managed agent event must be run.started.");
    }
  } else if (snapshot.runId !== envelope.runId || snapshot.turnId !== envelope.turnId) {
    protocolError("identity_mismatch", "Managed agent run or turn identity changed during replay.");
  }
  if (isTerminal(snapshot)) {
    protocolError("illegal_transition", `No new events are accepted after a ${snapshot.status} run.`);
  }

  const identified = snapshot.lastSeq === 0
    ? { ...snapshot, runId: envelope.runId, turnId: envelope.turnId }
    : snapshot;
  const reduced = reduceEvent(identified, envelope.event);
  return freezeSnapshot({
    ...reduced,
    lastSeq: envelope.seq,
    acceptedEventFingerprints: {
      ...snapshot.acceptedEventFingerprints,
      [sequenceKey]: fingerprint,
    },
  });
}

export function replayManagedAgentEvents(
  envelopes: readonly ManagedAgentEventEnvelope[],
  initial: AgentConversationSnapshot = createInitialAgentConversation(),
): AgentConversationSnapshot {
  return envelopes.reduce(applyManagedAgentEvent, initial);
}

export function selectAgentPart(
  snapshot: AgentConversationSnapshot,
  partId: string,
): AgentPart | undefined {
  return findPart(snapshot, partId);
}

export function selectAgentMessageParts(
  snapshot: AgentConversationSnapshot,
  messageId: string,
): readonly AgentPart[] {
  const message = findMessage(snapshot, messageId);
  if (!message) return [];
  const partIds = new Set(message.partIds);
  return snapshot.parts.filter((part) => partIds.has(part.id));
}

export function selectToolCall(
  snapshot: AgentConversationSnapshot,
  callId: string,
): AgentToolPart | undefined {
  return findTool(snapshot, callId);
}

export function selectPendingApprovals(
  snapshot: AgentConversationSnapshot,
): readonly AgentToolPart[] {
  return snapshot.parts.filter((part): part is AgentToolPart =>
    part.kind === "tool" && part.state === "approval-required");
}

export function isAgentConversationTerminal(snapshot: AgentConversationSnapshot): boolean {
  return isTerminal(snapshot);
}
