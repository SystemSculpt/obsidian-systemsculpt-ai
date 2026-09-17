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
