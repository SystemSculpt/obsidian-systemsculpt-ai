import type { StudioWorkflow } from './StudioWorkflow';
import type { CodexActivity } from './CodexActivity';
import type { CodexRequest } from './LocalCodexClient';
import type { DeepReadonly } from '../../studio/StudioProjectSnapshots';

export const AGENT_RUN_STATUSES = ['queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'interrupted'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export const AGENT_RUN_MESSAGE_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type AgentRunMessage = { id: string; from: string; to: string; text: string; at: string; status: (typeof AGENT_RUN_MESSAGE_STATUSES)[number]; error?: string };
export type StudioAgentRun = {
  schema: 'studio.agent-run.v1'; id: string; projectId: string; projectPath: string; nodeId: string; title: string;
  workflow?: StudioWorkflow; workflowId?: string; assignmentId?: string; preparationPending?: boolean;
  parentRunId?: string; owner: string;
  /** The executing machine: its hostname, shown to people, and its stable device ID, absent on records saved before machines had one. */
  machine: string; machineId?: string;
  status: AgentRunStatus; createdAt: string; updatedAt: string; finishedAt?: string;
  threadId: string; turnId: string; request: CodexRequest; result: string; error: string; currentActivity: string;
  activity: CodexActivity[]; messages: AgentRunMessage[]; persistenceError?: string;
};
/** Live observation views: only StudioAgentRuns may mutate the retained records. */
export type StudioAgentRunView = DeepReadonly<StudioAgentRun>;
export type AgentRunMessageView = DeepReadonly<AgentRunMessage>;

export const isActiveAgentRun = (status: AgentRunStatus): boolean => ['queued', 'running', 'waiting'].includes(status);

// Presentation protocol limits, shared by the live projection and its disk reader.
export const AGENT_RUN_MAX_RESULT_CHARS = 64_000;
export const AGENT_RUN_MAX_ACTIVITY_DETAIL_CHARS = 2000;
export const AGENT_RUN_MAX_ACTIVITY = 40;
export const AGENT_RUN_MAX_MESSAGES = 100;
export const AGENT_RUN_MAX_MESSAGE_CHARS = 48_000;
export const AGENT_RUN_MAX_FILE_BYTES = 2_000_000;
