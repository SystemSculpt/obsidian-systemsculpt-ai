export type WorkflowTriggerType = "folder" | "tag" | "command";

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  value: string;
  description?: string;
}

export type WorkflowConditionType = "folderRegex" | "tag" | "frontmatter";

export interface WorkflowCondition {
  type: WorkflowConditionType;
  value: string;
  description?: string;
}

export type WorkflowStepType =
  | "route-note"
  | "apply-template"
  | "ai-preset"
  | "write-note"
  | "extract-tasks"
  | "push-tasks"
  | "add-backlinks";

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  label: string;
  config?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  conditions?: WorkflowCondition[];
  steps: WorkflowStep[];
  description?: string;
}

export type WorkflowTaskDestination = "central-note" | "daily-note";

export interface WorkflowAutomationState {
  id: string;
  enabled: boolean;
  sourceFolder?: string;
  destinationFolder?: string;
  tasksDestination?: WorkflowTaskDestination;
  tasksNotePath?: string;
  metadata?: Record<string, string>;
  systemPrompt?: string;
}

export interface WorkflowSkipEntry {
  path: string;
  type: "transcription" | "automation";
  automationId?: string;
  skippedAt: string;
  reason?: string;
}

export interface WorkflowEngineSettings {
  enabled: boolean;
  inboxRoutingEnabled: boolean;
  inboxFolder: string;
  processedNotesFolder: string;
  taskDestination: WorkflowTaskDestination;
  taskNotePath: string;
  autoTranscribeInboxNotes: boolean;
  templates: Record<string, WorkflowAutomationState>;
  skippedFiles?: Record<string, WorkflowSkipEntry>;
}

export const WORKFLOW_AUTOMATION_IDS = {
  MEETING_TRANSCRIPT: "meeting-transcript",
  WEB_CLIPPING: "web-clipping",
  IDEA_DUMP: "idea-dump",
} as const;

export type WorkflowAutomationId = typeof WORKFLOW_AUTOMATION_IDS[keyof typeof WORKFLOW_AUTOMATION_IDS];

export function createDefaultWorkflowAutomationsState(): Record<string, WorkflowAutomationState> {
  return {
    [WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT]: {
      id: WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT,
      enabled: false,
      sourceFolder: "10 - capture-intake/Transcripts",
      destinationFolder: "40 - areas/Meetings",
      tasksDestination: "central-note",
      tasksNotePath: "60 - automations/Central Tasks.md",
      systemPrompt: "You are a meeting operations assistant. Turn messy transcripts into crisp notes highlighting agenda, key decisions, blockers, owners, and next steps. Write in bullet lists and keep timestamps out of the final summary.",
    },
    [WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING]: {
      id: WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING,
      enabled: false,
      sourceFolder: "10 - capture-intake/Clippings",
      destinationFolder: "20 - resources/Web",
      tasksDestination: "central-note",
      tasksNotePath: "60 - automations/Central Tasks.md",
      systemPrompt: "You are a research clipping analyst. Normalize web clippings, capture source context, summarize the core insight, and list 2-3 follow-up actions if relevant.",
    },
    [WORKFLOW_AUTOMATION_IDS.IDEA_DUMP]: {
      id: WORKFLOW_AUTOMATION_IDS.IDEA_DUMP,
      enabled: false,
      sourceFolder: "10 - capture-intake/Inbox",
      destinationFolder: "30 - projects/Incubator",
      tasksDestination: "central-note",
      tasksNotePath: "60 - automations/Central Tasks.md",
      systemPrompt: "You are a creative project triage assistant. Take short idea dumps, clarify the problem, opportunity, and next experiments. Keep tone energetic but concise.",
    },
  };
}

export function createDefaultWorkflowEngineSettings(): WorkflowEngineSettings {
  return {
    enabled: true,
    inboxRoutingEnabled: true,
    inboxFolder: "10 - capture-intake/Inbox",
    processedNotesFolder: "",
    taskDestination: "central-note",
    taskNotePath: "60 - automations/Central Tasks.md",
    autoTranscribeInboxNotes: true,
    templates: createDefaultWorkflowAutomationsState(),
    skippedFiles: {},
  };
}
