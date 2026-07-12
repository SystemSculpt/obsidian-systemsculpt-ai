import { LogLevel } from "./utils/errorHandling";
import { ToolCall } from "./types/toolCalls";
import type { ChatExportPreferences } from "./types/chatExport";
import { createDefaultChatExportOptions } from "./types/chatExport";
import type { WorkflowEngineSettings, WorkflowAutomationState, WorkflowAutomationId, WorkflowSkipEntry, WorkflowManagedTextOperation, WorkflowManagedTextPhase } from "./types/workflows";
import { createDefaultWorkflowEngineSettings, createDefaultWorkflowAutomationsState, WORKFLOW_AUTOMATION_IDS } from "./types/workflows";
import { CURRENT_SCHEMA_VERSION } from "./core/settings/migrations/schemaVersion";

export { LogLevel };
export type { ToolCall };

export type {
  MCPToolInfo,
} from "./types/mcp";

export type {
  WorkflowEngineSettings,
  WorkflowAutomationState,
  WorkflowAutomationId,
  WorkflowSkipEntry,
  WorkflowManagedTextOperation,
  WorkflowManagedTextPhase,
  WorkflowTrigger,
  WorkflowCondition,
  WorkflowStep,
} from "./types/workflows";

export { createDefaultWorkflowEngineSettings, createDefaultWorkflowAutomationsState, WORKFLOW_AUTOMATION_IDS } from "./types/workflows";

export const LICENSE_URL = "https://systemsculpt.com/resources?tab=license";

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
  /**
   * Directory where web research corpus artifacts are stored.
   */
  webResearchDirectory: string;
  lastValidated: number;
  recordingsDirectory: string;
  preferredMicrophoneId: string;
  autoTranscribeRecordings: boolean;
  autoPasteTranscription: boolean;
  keepRecordingsAfterTranscription: boolean;
  postProcessingPrompt: string;
  postProcessingEnabled: boolean;
  /**
   * Tracks the source of the post-processing prompt
   * - "preset": Using a preset from the SystemSculpt API
   * - "file": Using a custom file from the vault
   */
  postProcessingPromptType: "preset" | "file";
  /**
   * ID of the selected preset (if postProcessingPromptType is "preset")
   */
  postProcessingPromptPresetId: string;
  /**
   * Path to the selected file (if postProcessingPromptType is "file")
   */
  postProcessingPromptFilePath: string;
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
  /**
   * When enabled, the "Transcribe an audio file" modal shows an output format selector.
   * Users can hide this chooser from the modal and re-enable it in Settings.
   */
  showTranscriptionFormatChooserInModal?: boolean;
  /**
   * Enable automatic audio resampling for incompatible sample rates (desktop only)
   * When enabled, audio files with incompatible sample rates will be automatically
   * converted to the required format before transcription.
   */
  enableAutoAudioResampling: boolean;
  attachmentsDirectory: string;
  extractionsDirectory: string;
  systemPromptsDirectory: string;
  /** Cached list of directories we've already verified to avoid redundant fs checks */
  verifiedDirectories?: string[];
  workflowEngine: WorkflowEngineSettings;

  /**
   * Skip empty note warning confirmation modal
   */
  skipEmptyNoteWarning: boolean;

  /**
   * Whether agent mode is enabled in the chat UI.
   * When false, the AI behaves as a plain chat assistant without tool access.
   * Defaults to true to preserve existing always-on behavior.
   */
  agentModeEnabled: boolean;

  lastUsedPromptPath: string;

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
   * Whether to show update notifications
   * When disabled, the plugin won't check for or show update notifications
   */
  showUpdateNotifications: boolean;

  /**
   * Track the last known version to detect when user has updated
   */
  lastKnownVersion?: string;

  /**
   * Optional tag applied to new chat history notes.
   */
  defaultChatTag: string;

  chatFontSize: "small" | "medium" | "large";

  /**
   * When enabled, system-role messages stay in history but are hidden from the chat UI.
   */
  hideSystemMessagesInChat: boolean;

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
  embeddingsAutoProcess: boolean;
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

  /**
   * Preserve reasoning content verbatim without any markdown processing
   * When enabled, reasoning blocks are rendered exactly as authored without
   * transformation, preserving bold markers, paragraph spacing, etc.
   */
  preserveReasoningVerbatim: boolean;

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
  webResearchDirectory: "SystemSculpt/Web Research",
  lastValidated: 0,
  recordingsDirectory: "SystemSculpt/Recordings",
  preferredMicrophoneId: "",
  autoTranscribeRecordings: true,
  autoPasteTranscription: true,
  keepRecordingsAfterTranscription: true,
  postProcessingPrompt:
    `You are a transcription post-processor. Your task is to fix any transcription errors, correct grammar and punctuation, and ensure the text is properly formatted. Keep the original meaning intact while making the text more readable.

Please process the following raw transcript to:
- Fix grammar, punctuation, and capitalization
- Remove filler words (um, uh, like, you know)
- Format into clear paragraphs
- Maintain the original meaning and speaker's voice

Raw transcript:`,
  postProcessingEnabled: false,
  postProcessingPromptType: "preset",
  postProcessingPromptPresetId: "transcript-cleaner",
  postProcessingPromptFilePath: "",
  cleanTranscriptionOutput: false,
  autoSubmitAfterTranscription: false,
  transcriptionOutputFormat: "markdown",
  showTranscriptionFormatChooserInModal: true,
  enableAutoAudioResampling: true,
  attachmentsDirectory: "SystemSculpt/Attachments",
  extractionsDirectory: "SystemSculpt/Extractions",
  systemPromptsDirectory: "SystemSculpt/System Prompts",
  verifiedDirectories: [],
  workflowEngine: createDefaultWorkflowEngineSettings(),

  skipEmptyNoteWarning: false,

  agentModeEnabled: true,
  lastUsedPromptPath: "",

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
  preserveReasoningVerbatim: true,
  showUpdateNotifications: true,

  defaultChatTag: "",
  chatFontSize: "medium",
  hideSystemMessagesInChat: false,
  respectReducedMotion: true,

  studioDefaultProjectsFolder: "SystemSculpt/Studio",
  studioRunRetentionMaxRuns: 100,
  studioRunRetentionMaxArtifactsMb: 1024,
  studioJsonEditorDefaultMode: "composer",

  /**
   * Embeddings defaults
  */
  embeddingsEnabled: false,
  embeddingsAutoProcess: true,
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
  documentContext?: {
    documentIds: string[];
  };
  systemPromptType?: string;
  systemPromptPath?: string;
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

export interface SystemPromptPreset {
  id: string;
  label: string;
  description?: string;
  isUserConfigurable: boolean;
  systemPrompt: string;
}

export interface SystemPromptType {
  id: string; // e.g., "text_modification"
  label: string; // e.g., "Text Modification"
  description?: string; // Optional description of what this prompt type does
  isUserConfigurable: boolean; // Whether user can customize the prompt
}

export interface TextModificationState {
  originalText: string;
  modifiedText: string;
  isStreaming: boolean;
  streamComplete: boolean;
  error?: string;
}
