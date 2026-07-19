import { LogLevel } from "./utils/errorHandling";
import type { ToolCall } from "./types/toolCalls";
import type { ChatExportPreferences } from "./types/chatExport";
import { createDefaultChatExportOptions } from "./types/chatExport";
import type { WorkflowEngineSettings } from "./types/workflows";
import { createDefaultWorkflowEngineSettings } from "./types/workflows";
import { CURRENT_SCHEMA_VERSION } from "./core/settings/migrations/schemaVersion";

export { LogLevel };
export type { ToolCall };

export type {
  WorkflowEngineSettings,
  WorkflowSkipEntry,
  WorkflowTrigger,
  WorkflowCondition,
  WorkflowStep,
} from "./types/workflows";

export { createDefaultWorkflowEngineSettings } from "./types/workflows";

export interface PendingRecorderCapture {
  filePath: string;
  startedAt: number;
  durationMs: number;
  sizeBytes: number;
  stopReason: "manual" | "background-hidden" | "background-pagehide" | "interrupted" | "size-limit";
  destination: "note" | "chat";
  /**
   * Why transcription was admitted. Manual intent remains recoverable even
   * when automatic transcription is disabled after an app restart.
   * Missing values are legacy automatic entries.
   */
  transcriptionIntent?: "automatic" | "manual";
  operationId?: string;
  /** Automatic recovery is disabled when synced state names incompatible jobs. */
  recoveryBlocked?: "conflicting-operation-ids";
}

export interface PendingAudioProcessorUploadPart {
  partNumber: number;
  etag: string;
}

export type PendingAudioProcessorUploadSource =
  | Readonly<{
    kind: "vault";
    filePath: string;
    modifiedAt: number;
  }>
  | Readonly<{
    kind: "staged";
    stagingId: string;
    manifestSha256: string;
  }>;

export interface PendingAudioProcessorUpload {
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source: PendingAudioProcessorUploadSource;
  partSizeBytes: number;
  totalParts: number;
  uploadedParts: PendingAudioProcessorUploadPart[];
  updatedAt: number;
}

export const LICENSE_URL = "https://systemsculpt.com/pricing";

export interface SystemSculptSettings {
  /**
   * Stable identifier unique to this vault installation.
   * Used to scope local IndexedDB storage per vault (prevents cross-vault collisions).
   */
  vaultInstanceId?: string;

  /**
   * When enabled, render a vim-style relative line number gutter in the markdown
   * editor: the current line shows its absolute number, every other line shows
   * its distance from the cursor.
   */
  relativeLineNumbersEnabled?: boolean;

  /**
   * Persisted settings schema version, driving the versioned migration chain
   * (see SettingsMigrator). Absent/0 means pre-versioning data, migrated on load.
   */
  schemaVersion?: number;

  /**
   * Internal migration flags (not user-facing).
   */
  embeddingsVectorFormatVersion?: number;

  licenseKey: string;
  licenseValid: boolean;
  suppressLicenseUpgradePrompt: boolean;
  userName?: string;
  displayName?: string;
  userEmail?: string;
  subscriptionStatus?: string;
  chatsDirectory: string;
  /**
   * Directory where notes created via the "Save chat as note" feature are stored
   */
  savedChatsDirectory: string;
  lastValidated: number;
  /** Last release for which the plugin showed an update-available notice. */
  lastAnnouncedPluginRelease: string;
  /** Last plugin version observed after a successful load. */
  lastLoadedPluginVersion: string;
  recordingsDirectory: string;
  /** Recorder audio saved before recorder-owned transcription fully committed. */
  pendingRecorderCaptures: PendingRecorderCapture[];
  /** Vault-backed multipart uploads that can resume after a restart. */
  pendingAudioProcessorUploads?: PendingAudioProcessorUpload[];
  autoTranscribeRecordings: boolean;
  autoPasteTranscription: boolean;
  keepRecordingsAfterTranscription: boolean;
  postProcessingPrompt: string;
  postProcessingEnabled: boolean;
  /**
   * When enabled, transcription output will be clean text only without timestamps, titles, or metadata
   */
  cleanTranscriptionOutput: boolean;
  /**
   * When enabled, automatically submits the message (hits enter) after transcription/post-processing completes in chat views
   */
  autoSubmitAfterTranscription: boolean;
  /**
   * Default output format when transcribing audio files.
   * - "markdown": Save as a markdown note
   * - "srt": Save as an SRT subtitle file
   */
  transcriptionOutputFormat?: "markdown" | "srt";
  attachmentsDirectory: string;
  extractionsDirectory: string;
  workflowEngine: WorkflowEngineSettings;

  /**
   * Skip empty note warning confirmation modal
   */
  skipEmptyNoteWarning: boolean;

  favoriteChats: string[];
  favoriteStudioSessions: string[];

  /**
   * Remembers export preferences for chat exports (toggle selections, folder, etc.)
   */
  chatExportPreferences?: ChatExportPreferences;


  showDiagnostics: boolean;
  enableExperimentalFeatures: boolean;
  logLevel: LogLevel;
  debugMode: boolean;
  
  /**
   * Optional tag applied to new chat history notes.
   */
  defaultChatTag: string;

  chatFontSize: "small" | "medium" | "large";

  /**
   * When enabled, SystemSculpt UI will honor the OS "reduced motion" preference
   * by minimizing animations/transitions inside SystemSculpt views only.
   */
  respectReducedMotion: boolean;

  /**
   * Studio project defaults.
   */
  studioDefaultProjectsFolder: string;
  studioRunRetentionMaxRuns: number;
  studioRunRetentionMaxArtifactsMb: number;
  studioJsonEditorDefaultMode?: "composer" | "raw";

  /**
   * Managed semantic-index settings.
  */
  embeddingsEnabled: boolean;
  embeddingsExclusions: {
    folders: string[];
    patterns: string[];
    ignoreChatHistory: boolean;
    respectObsidianExclusions: boolean;
  };
  /**
   * When true (default), persist a portable copy of the embedding index into the
   * synced vault (`.systemsculpt/embeddings/`) so Obsidian Sync/backup restores
   * it on a new device instead of re-embedding the whole vault.
   */
  embeddingsPortableIndex?: boolean;
  /**
   * Set true while a managed bulk rebuild is incomplete. On the next load the
   * durable per-file completeness markers let the run resume without repeating
   * completed files. Cleared after a clean vault completion.
   */
  embeddingsRebuildPending?: boolean;
  
  /**
   * Automatic backup settings
   */
  automaticBackupsEnabled: boolean; // Whether automatic backups are enabled
  automaticBackupInterval: number; // Backup interval in hours (default 24)
  automaticBackupRetentionDays: number; // How many days to keep automatic backups
  lastAutomaticBackup: number; // Timestamp of last automatic backup

}

export const DEFAULT_SETTINGS: SystemSculptSettings = {
  vaultInstanceId: "",
  relativeLineNumbersEnabled: false,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  embeddingsVectorFormatVersion: 0,
  licenseKey: "",
  licenseValid: false,
  suppressLicenseUpgradePrompt: false,
  chatsDirectory: "SystemSculpt/Chats",
  savedChatsDirectory: "SystemSculpt/Saved Chats",
  lastValidated: 0,
  lastAnnouncedPluginRelease: "",
  lastLoadedPluginVersion: "",
  recordingsDirectory: "SystemSculpt/Recordings",
  pendingRecorderCaptures: [],
  pendingAudioProcessorUploads: [],
  autoTranscribeRecordings: true,
  autoPasteTranscription: true,
  keepRecordingsAfterTranscription: true,
  postProcessingPrompt:
    `Clean up the transcript without changing what language anyone used.

Please:
- Fix obvious transcription errors, grammar, punctuation, and capitalization
- Remove filler words (um, uh, like, you know)
- Format into clear paragraphs
- Maintain the original meaning, terminology, and speaker's voice
- Preserve every original language and writing system, including code-switches
- Keep personal, company, product, and place names as transcribed
- Never translate, transliterate, anglicize, or normalize the transcript into another language`,
  postProcessingEnabled: false,
  cleanTranscriptionOutput: false,
  autoSubmitAfterTranscription: false,
  transcriptionOutputFormat: "markdown",
  attachmentsDirectory: "SystemSculpt/Attachments",
  extractionsDirectory: "SystemSculpt/Extractions",
  workflowEngine: createDefaultWorkflowEngineSettings(),

  skipEmptyNoteWarning: false,

  favoriteChats: [],
  favoriteStudioSessions: [],

  chatExportPreferences: {
    options: createDefaultChatExportOptions(),
    lastFolder: "",
    openAfterExport: true,
    lastFileName: "",
  },

  showDiagnostics: false,
  enableExperimentalFeatures: false,
  logLevel: LogLevel.WARNING,
  debugMode: false,
  defaultChatTag: "",
  chatFontSize: "medium",
  respectReducedMotion: true,

  studioDefaultProjectsFolder: "SystemSculpt/Studio",
  studioRunRetentionMaxRuns: 100,
  studioRunRetentionMaxArtifactsMb: 1024,
  studioJsonEditorDefaultMode: "composer",

  /**
   * Embeddings defaults
  */
  embeddingsEnabled: false,
  embeddingsExclusions: {
    folders: [],
    patterns: [],
    ignoreChatHistory: true,
    respectObsidianExclusions: true
  },
  embeddingsPortableIndex: true,
  embeddingsRebuildPending: false,
  
  /**
   * Automatic backup defaults
   */
  automaticBackupsEnabled: true, // Enable automatic backups by default
  automaticBackupInterval: 24, // Create backups every 24 hours
  automaticBackupRetentionDays: 30, // Keep backups for 30 days
  lastAutomaticBackup: 0, // No automatic backup yet
  
};

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MultiPartContent = TextContent | ImageContent;

export interface ChatAttachmentContentRef {
  schema: "systemsculpt-chat-attachment-v1";
  payload: "image-bytes" | "utf8-content-part";
  sha256: string;
  byteLength: number;
}

/** Durable identity for a composer attachment represented by one content part. */
export interface ChatAttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  byteLength: number;
  kind: "document" | "image" | "text";
  contentPartIndex: number;
  contentRef?: ChatAttachmentContentRef;
}

export interface UrlCitation {
  url: string;
  title: string;
  content?: string;
  start_index?: number;
  end_index?: number;
}

export interface Annotation {
  type: string;
  url_citation?: UrlCitation;
}

/**
 * Represents one part of a multi-part message (e.g., text, tool call)
 * This supports the new sequential, interleaved format for assistant responses.
 */
export type MessagePart =
  | {
      id: string;
      type: "reasoning";
      timestamp: number;
      data: string;
    }
  | {
      id: string;
      type: "content";
      timestamp: number;
      data: string | MultiPartContent[];
    }
  | {
      id:string;
      type: "tool_call";
      timestamp: number;
      data: ToolCall;
    };

export interface ChatMessage {
  role: ChatRole;
  content: string | MultiPartContent[] | null;
  message_id: string;
  /**
   * Presentation/retry metadata only. Model transports intentionally read the
   * content parts and never send this local descriptor.
   */
  attachmentMetadata?: ChatAttachmentMetadata[];
  documentContext?: {
    documentIds: string[];
  };
  annotations?: Annotation[];
  // Additional fields for tool messages
  tool_call_id?: string;
  name?: string;
  // Tool calls from assistant messages
  tool_calls?: ToolCall[];
  // Reasoning trace from assistant messages
  reasoning?: string;
  // Structured reasoning blocks returned by the managed gateway.
  reasoning_details?: unknown[];
  // Sequential message parts for interleaved reasoning and tool calls (2025 AI SDK pattern)
  messageParts?: MessagePart[];
  // Indicates if this message is currently being streamed (not yet complete)
  streaming?: boolean;
}

export interface SystemSculptResponse {
  id: string;
  choices: {
    message: ChatMessage;
  }[];
}

export interface SystemSculptStreamChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      text?: string;
      reasoning?: string;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  completion?: string;
  delta?: {
    text?: string;
    reasoning?: string;
  };
	  error?: {
	    code: string;
	    message: string;
	    statusCode?: number;
	    model?: string;
	  };
	}

export interface TextModificationState {
  originalText: string;
  modifiedText: string;
  isStreaming: boolean;
  streamComplete: boolean;
  error?: string;
}
