import type { ChatMessage } from "../types";
import type { ToolApprovalPolicy } from "../utils/toolPolicy";
import type { MeasuredThinAgentContext, ThinAgentContextResponse } from "../services/managed/ThinAgentV1Contract";
import type { AgentConversationSnapshot, ManagedAgentError } from "./ChatConversation";
import type { AgentUserMessage } from "./managed/Protocol";
import type { AgentLifecycleInput } from "./managed/Lifecycle";

export type AgentRunResult =
  | Readonly<{
      kind: "completed";
      snapshot: AgentConversationSnapshot;
      message?: ChatMessage;
    }>
  | Readonly<{
      kind: "cancelled";
      snapshot: AgentConversationSnapshot;
    }>
  | Readonly<{
      kind: "failed";
      snapshot: AgentConversationSnapshot;
      error: ManagedAgentError;
    }>;

export type AgentRunInput = Readonly<{
  conversationId: string;
  turnId: string;
  message: AgentUserMessage;
  buildBody?: (
    signal: AbortSignal,
  ) => Promise<Readonly<{ context_ref?: string }> | undefined>;
  approvalPolicy?: ToolApprovalPolicy;
  beforeSend?: () => Promise<void>;
  clientStartedAtMonotonicMs?: number;
}>;

type ResponseRenderMilestone = "response_first_dom_committed" | "response_first_paint_opportunity";
type ToolRenderMilestone = "local_tool_terminal_dom_committed" | "local_tool_terminal_paint_opportunity"
  | "continuation_content_dom_committed" | "continuation_content_paint_opportunity";

/** The presentation seam shared by managed and native execution owners. */
export interface ChatSession {
  getSnapshot(): AgentConversationSnapshot;
  subscribe(listener: (snapshot: AgentConversationSnapshot) => void): () => void;
  hydrate(conversationId: string): Promise<void>;
  start(input: AgentRunInput): Promise<AgentRunResult>;
  stageContext(id: string, context: MeasuredThinAgentContext, signal?: AbortSignal): Promise<ThinAgentContextResponse>;
  cancel(): Promise<void>;
  detach(): Promise<void>;
  disconnect(): void;
  respondToApproval(approvalId: string, approved: boolean, source?: "manual" | "policy"): boolean;
  recordLifecycle?(input: AgentLifecycleInput): void;
  recordClientRequestLifecycle?(input: AgentLifecycleInput): void;
  // Rendering diagnostics are observational and only supplied by backends that own them.
  recordClientRenderMilestone?(code: ResponseRenderMilestone, requestId: string, observedAt: number): void;
  needsClientRenderMilestone?(code: ResponseRenderMilestone, requestId: string): boolean;
  recordClientToolRenderMilestone?(code: ToolRenderMilestone, requestId: string, toolCallId: string, observedAt: number): void;
  needsClientToolRenderMilestone?(code: ToolRenderMilestone, requestId: string, toolCallId: string): boolean;
}
