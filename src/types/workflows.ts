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

export interface WorkflowSkipEntry {
  path: string;
  type: "transcription";
  skippedAt: string;
  reason?: string;
}

export interface WorkflowEngineSettings {
  enabled: boolean;
  inboxRoutingEnabled: boolean;
  inboxFolder: string;
  processedNotesFolder: string;
  autoTranscribeInboxNotes: boolean;
  skippedFiles?: Record<string, WorkflowSkipEntry>;
}

export function createDefaultWorkflowEngineSettings(): WorkflowEngineSettings {
  return {
    enabled: true,
    inboxRoutingEnabled: true,
    inboxFolder: "10 - capture-intake/Inbox",
    processedNotesFolder: "",
    autoTranscribeInboxNotes: true,
    skippedFiles: {},
  };
}
