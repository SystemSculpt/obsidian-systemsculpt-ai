import { App, TFile } from "obsidian";
import { SystemSculptService } from "./services/SystemSculptService";
import { ScrollManagerService } from "./views/chatview/ScrollManagerService";
import { MessageRenderer } from "./views/chatview/MessageRenderer";
import SystemSculptPlugin from "./main";
import type {
  SystemSculptModel,
  CustomProvider,
  ModelFilterSettings,
  ActiveProvider,
} from "./types/llm";
import { DEFAULT_FILTER_SETTINGS } from "./types/llm";
import { FavoritesFilterSettings, DEFAULT_FAVORITES_FILTER_SETTINGS } from "./types/favorites";
import type { FavoriteModel } from "./types/favorites";
import { MCPServer } from "./types/mcp";
import { LogLevel } from "./utils/errorHandling";
import { ToolCall } from "./types/toolCalls";
import type { ChatExportPreferences } from "./types/chatExport";
import { createDefaultChatExportOptions } from "./types/chatExport";
import type { WorkflowEngineSettings, WorkflowAutomationState, WorkflowAutomationId, WorkflowSkipEntry } from "./types/workflows";
import { createDefaultWorkflowEngineSettings, createDefaultWorkflowAutomationsState, WORKFLOW_AUTOMATION_IDS } from "./types/workflows";
import type { ReadwiseImportOptions, ReadwiseOrganization, ReadwiseSyncMode, ReadwiseTweetOrganization } from "./types/readwise";
import { DEFAULT_READWISE_IMPORT_OPTIONS } from "./types/readwise";

export { LogLevel };
export type { ToolCall };

// --- Embedding Feature Types Removed ---

// Re-export for convenience
export type {
  SystemSculptModel,
  CustomProvider,
  ModelFilterSettings,
  ActiveProvider,
} from "./types/llm";
export type { FavoriteModel } from "./types/favorites";

export type {
  MCPServer,
  MCPToolInfo,
  MCPConnectionStatus,
  MCPTransport,
} from "./types/mcp";

export type {
  WorkflowEngineSettings,
  WorkflowAutomationState,
  WorkflowAutomationId,
  WorkflowSkipEntry,
  WorkflowTrigger,
  WorkflowCondition,
  WorkflowStep,
  WorkflowTaskDestination,
} from "./types/workflows";

export { createDefaultWorkflowEngineSettings, createDefaultWorkflowAutomationsState, WORKFLOW_AUTOMATION_IDS } from "./types/workflows";

export const LICENSE_URL = "https://systemsculpt.com/resources?tab=license";

export const DEFAULT_TITLE_GENERATION_PROMPT = `You are a specialized title generation assistant focused on creating precise, meaningful titles.

Your task is to analyze the provided conversation and generate a single, concise title that:
- Captures the main topic or central theme of the conversation
- Uses clear, descriptive language
- Is between 3-8 words long
- Avoids unnecessary articles (a, an, the) unless essential
- Maintains professional tone and proper capitalization
- Includes key technical terms when relevant
- NEVER includes characters that are invalid in filenames: \\ / : * ? " < > |
- Uses proper spacing between all words

Output ONLY the title itself - no additional text, no "Title:" prefix, no quotes, no explanation.`;

export interface SystemSculptSettings {
  /**
   * Settings mode controls how much of the configuration is shown in the UI
   * - "standard": Show only the essentials for a quick, friendly setup
   * - "advanced": Reveal all settings and power-user options
   */
  settingsMode?: "standard" | "advanced";

  /**
   * Stable identifier unique to this vault installation.
   * Used to scope local IndexedDB storage per vault (prevents cross-vault collisions).
   */
  vaultInstanceId?: string;

  /**
   * Internal migration flags (not user-facing).
   */
  embeddingsVectorFormatVersion?: number;

  licenseKey: string;
  licenseValid: boolean;
  suppressLicenseUpgradePrompt: boolean;
  selectedModelId: string;
  /** When enabled, always use the most recently selected AI model across all features */
  useLatestModelEverywhere?: boolean;
  userName?: string;
  displayName?: string;
  userEmail?: string;
  subscriptionStatus?: string;
  // Welcome/tour removed: no startup modal
  /**
   * The default model ID used for new chats and system operations.
   * This is now ALIASIASING selectedModelId and should be preferred.
   */
  // defaultModelId?: string; // DEPRECATED: Use selectedModelId

  /**
   * The default model ID used when creating new templates.
   * This allows the template system to persist the user's preferred model independently of chat defaults.
   */
  defaultTemplateModelId?: string;
  chatsDirectory: string;
  /**
   * Directory where notes created via the "Save chat as note" feature are stored
   */
  savedChatsDirectory: string;
  /**
   * Directory where benchmark reports are exported
   */
  benchmarksDirectory: string;
  lastValidated: number;
  /**
   * For backward compatibility, we'll keep systemPrompt as the last-saved
   * user-chosen text. This is only used for direct storage if the user
   * picks a preset or typed content. But if systemPromptType is "custom",
   * we'll read from systemPromptPath.
   */
  systemPrompt: string;
  recordingsDirectory: string;
  preferredMicrophoneId: string;
  /**
   * When enabled (desktop only), capture system audio alongside microphone input.
   */
  // Deprecated: system audio capture removed; kept for backward compatibility in stored settings
  recordSystemAudio?: boolean;
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
  /** Provider ID used specifically for post-processing (e.g., "systemsculpt", "openai-custom") */
  postProcessingProviderId: string;
  /** Canonical model ID used specifically for post-processing (e.g., "systemsculpt@@gpt-4") */
  postProcessingModelId: string;
  /**
   * When enabled, transcription output will be clean text only without timestamps, titles, or metadata
   */
  cleanTranscriptionOutput: boolean;
  /**
   * When enabled, automatically submits the message (hits enter) after transcription/post-processing completes in chat views
   */
  autoSubmitAfterTranscription: boolean;
  /**
   * Transcription provider settings
   * - "systemsculpt": Use the SystemSculpt API (requires valid license)
   * - "custom": Use a custom transcription endpoint
   */
  transcriptionProvider: "systemsculpt" | "custom";
  /**
   * Custom transcription endpoint URL (used when transcriptionProvider is "custom")
   * Examples:
   * - Groq: "https://api.groq.com/openai/v1/audio/transcriptions"
   * - OpenAI: "https://api.openai.com/v1/audio/transcriptions"
   * - Local Whisper: "http://localhost:9000/v1/audio/transcriptions"
   */
  customTranscriptionEndpoint: string;
  /**
   * API key for custom transcription endpoint (if required)
   */
  customTranscriptionApiKey: string;
  /**
   * Model to use for custom transcription
   * Examples:
   * - Groq: "whisper-large-v3", "whisper-large-v3-turbo", "distil-whisper-large-v3-en"
   * - OpenAI: "whisper-1"
   * - Custom: Any model name supported by the endpoint
   */
  customTranscriptionModel: string;
  /**
   * Enable automatic audio resampling for incompatible sample rates (desktop only)
   * When enabled, audio files with incompatible sample rates will be automatically
   * converted to the required format before transcription.
   */
  enableAutoAudioResampling: boolean;
  showModelTooltips: boolean;
  showVisionModelsOnly: boolean;
  showTopPicksOnly: boolean;
  selectedProvider: string;
  serverUrl: string;
  attachmentsDirectory: string;
  extractionsDirectory: string;
  // Changed below to "SystemSculpt/System Prompts" with a space
  systemPromptsDirectory: string;
  /** Cached list of directories we've already verified to avoid redundant fs checks */
  verifiedDirectories?: string[];
  workflowEngine: WorkflowEngineSettings;

  /**
   * Skip empty note warning confirmation modal
   */
  skipEmptyNoteWarning: boolean;

  /**
   * NEW FIELDS:
   * systemPromptType: "general-use" | "concise" | "agent" | "custom"
   * systemPromptPath: path to the file that holds the custom system prompt (if any).
   */
  systemPromptType: "general-use" | "concise" | "agent" | "custom";
  systemPromptPath: string;
  /** When enabled, new chats start with whichever system prompt you last selected */
  useLatestSystemPromptForNewChats?: boolean;


  /**
   * Title generation prompt settings
   */
  titleGenerationPrompt: string;
  titleGenerationPromptType: "precise" | "movie-style" | "custom";
  titleGenerationPromptPath: string;
  /** Provider ID used specifically for title generation (e.g., "systemsculpt", "openai-custom") */
  titleGenerationProviderId: string;
  /** Canonical model ID used specifically for title generation (e.g., "systemsculpt@@gpt-4") */
  titleGenerationModelId: string;
  /**
   * Custom provider settings
   */
  customProviders: CustomProvider[];

  modelFilterSettings: ModelFilterSettings;

  favoriteModels: FavoriteModel[];

  favoritesFilterSettings: FavoritesFilterSettings;

  favoriteChats: string[];

  activeProvider: ActiveProvider;

  /**
   * Template settings
   */
  templateHotkey: string;
  enableTemplateHotkey: boolean;

  /**
   * Last used folder for Save As Note modal
   */
  lastSaveAsNoteFolder: string;

  /**
   * Remembers export preferences for chat exports (toggle selections, folder, etc.)
   */
  chatExportPreferences?: ChatExportPreferences;


  showDiagnostics: boolean;
  enableExperimentalFeatures: boolean;
  lastUsedModel?: SystemSculptModel;

  /**
   * When enabled, custom provider model lists (like Groq) are filtered
   * to only show models that are active in the SystemSculpt catalog
   * managed on the server/website. This keeps the client UI aligned with
   * the admin’s selections and avoids confusion from unapproved models.
   */
  // Deprecated: custom providers are no longer filtered by server allowlists
  // respectServerAllowlistForCustomProviders?: boolean;


  /**
   * Whether the SystemSculpt provider is enabled
   * When disabled, the plugin won't use SystemSculpt models even with a valid license
   */
  enableSystemSculptProvider: boolean;
  
  /**
   * Whether to use SystemSculpt as the fallback provider when other providers fail
   * When enabled, calls will fall back to SystemSculpt if the primary provider fails
   */
  useSystemSculptAsFallback: boolean;

  /**
   * Percentage of the model context window to use (0-100)
   */
  contextWindowPercentage: number;

  logLevel: LogLevel;
  debugMode: boolean;
  /**
   * Whether to show the performance indicator in the status bar
   * When enabled, displays performance metrics (lag and memory usage)
   */
  
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
   * Model Context Protocol (MCP) settings
   */
  mcpServers: MCPServer[]; // Custom HTTP servers only - internal servers (filesystem, youtube) are always available
  mcpEnabledTools: string[]; // @deprecated - No longer used. All tools from internal servers are always available.
  mcpAutoAcceptTools: string[]; // Array of "serverId:toolName" for mutating tools that auto-accept without confirmation
  mcpEnabled: boolean; // @deprecated - No longer used. Internal MCP servers are always enabled.

  /**
   * Tool execution policy for Agent + MCP
   */
  toolingRequireApprovalForDestructiveTools: boolean;
  toolingConcurrencyLimit: number;
  toolingToolCallTimeoutMs: number;
  toolingMaxToolResultsInContext: number;

  /**
   * Optional tag applied to new chat history notes.
   */
  defaultChatTag: string;

  chatFontSize: "small" | "medium" | "large";

  /**
   * Inline completions (ghost text) shown in the editor.
   * Hotkey accepts the suggestion (Tab by default), Escape dismisses.
   */

  /**
   * When enabled, SystemSculpt UI will honor the OS "reduced motion" preference
   * by minimizing animations/transitions inside SystemSculpt views only.
   */
  respectReducedMotion: boolean;

  /**
   * OpenAI API key - kept for backward compatibility
   * Users should use custom providers for OpenAI integration
   */
  openAiApiKey: string;

  /**
   * CanvasFlow (experimental): ComfyUI-like prompt + run controls inside Obsidian Canvas.
   * Desktop-only.
   */
  canvasFlowEnabled: boolean;

  /**
   * Replicate (image generation). Used by CanvasFlow.
   */
  replicateApiKey: string;
  /** Default Replicate model slug, like "owner/name". */
  replicateDefaultModelSlug: string;
  /** Resolved Replicate version id for the default model slug. */
  replicateResolvedVersion: string;
  replicatePollIntervalMs: number;
  /** Folder path inside the vault where generated images are saved. */
  replicateOutputDir: string;
  /** When enabled, write a JSON sidecar next to each generated image. */
  replicateSaveMetadataSidecar: boolean;

  /**
   * Embeddings settings for the new embeddings system
   */
  embeddingsEnabled: boolean;
  embeddingsModel: string;
  embeddingsAutoProcess: boolean;
  embeddingsExclusions: {
    folders: string[];
    patterns: string[];
    ignoreChatHistory: boolean;
    respectObsidianExclusions: boolean;
  };
  
  /**
   * Embeddings provider configuration
   */
  embeddingsProvider: 'systemsculpt' | 'custom';
  embeddingsCustomEndpoint?: string;
  embeddingsCustomApiKey?: string;
  embeddingsCustomModel?: string;
  
  /**
   * Configurable processing settings
   */
  embeddingsBatchSize?: number; // Number of embeddings to process in parallel
  embeddingsRateLimitPerMinute?: number; // Maximum requests per minute
  /** Quiet period after edits before re-embedding on modify events (ms) */
  embeddingsQuietPeriodMs?: number;
  // Embeddings search behavior settings removed; use internal defaults
  
  /**
   * Automatic backup settings
   */
  automaticBackupsEnabled: boolean; // Whether automatic backups are enabled
  automaticBackupInterval: number; // Backup interval in hours (default 24)
  automaticBackupRetentionDays: number; // How many days to keep automatic backups
  lastAutomaticBackup: number; // Timestamp of last automatic backup

  /**
   * Model selection modal provider preferences
   * Stores the user's selected providers for the model selection modal
   */
  selectedModelProviders: string[]; // Array of provider IDs that are selected by default in the model selection modal

  /**
   * Preserve reasoning content verbatim without any markdown processing
   * When enabled, reasoning blocks are rendered exactly as authored without
   * transformation, preserving bold markers, paragraph spacing, etc.
   */
  preserveReasoningVerbatim: boolean;

  /**
   * Meeting processor default outputs
   */
  meetingProcessorOptions?: MeetingProcessorOptions;
  meetingProcessorOutputDirectory?: string;
  meetingProcessorOutputNameTemplate?: string;

  /**
   * YouTube Canvas settings
   */
  youtubeNotesFolder?: string;
  youtubeCanvasToggles?: {
    summary: boolean;
    keyPoints: boolean;
    studyNotes: boolean;
  };

  /**
   * Readwise integration settings
   */
  readwiseEnabled: boolean;
  readwiseApiToken: string;
  readwiseDestinationFolder: string;
  readwiseOrganization: ReadwiseOrganization;
  readwiseTweetOrganization: ReadwiseTweetOrganization;
  readwiseSyncMode: ReadwiseSyncMode;
  readwiseSyncIntervalMinutes: number;
  readwiseLastSyncTimestamp: number;
  readwiseLastSyncCursor: string;
  readwiseImportOptions: ReadwiseImportOptions;

  /**
   * Models discovered at runtime to be incompatible with tools.
   * Maps model ID to timestamp when discovered.
   */
  runtimeToolIncompatibleModels?: Record<string, number>;

  /**
   * Models discovered at runtime to be incompatible with images/vision.
   * Maps model ID to timestamp when discovered.
   */
  runtimeImageIncompatibleModels?: Record<string, number>;
}

export interface MeetingProcessorOptions {
  summary: boolean;
  actionItems: boolean;
  decisions: boolean;
  risks: boolean;
  questions: boolean;
  transcriptCleanup: boolean;
}

export const DEFAULT_SETTINGS: SystemSculptSettings = {
  // Default to a simple, friendly experience
  settingsMode: "standard",
  vaultInstanceId: "",
  embeddingsVectorFormatVersion: 0,
  licenseKey: "",
  licenseValid: false,
  suppressLicenseUpgradePrompt: false,
  selectedModelId: "",
  useLatestModelEverywhere: true,
  // defaultModelId: "", // DEPRECATED
  defaultTemplateModelId: "",
  chatsDirectory: "SystemSculpt/Chats",
  savedChatsDirectory: "SystemSculpt/Saved Chats",
  benchmarksDirectory: "SystemSculpt/Benchmarks",
  lastValidated: 0,
  // This is the fallback system prompt if the user hasn't chosen a custom or preset
  systemPrompt:
    "You are a helpful AI assistant. You help users with their questions and tasks in a clear and concise way.",
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
  postProcessingProviderId: "systemsculpt", // Default to native provider
  postProcessingModelId: "", // Default to empty; logic should handle fallback if unset
  cleanTranscriptionOutput: false,
  autoSubmitAfterTranscription: false,
  transcriptionProvider: "systemsculpt",
  customTranscriptionEndpoint: "",
  customTranscriptionApiKey: "",
  customTranscriptionModel: "whisper-large-v3",
  enableAutoAudioResampling: true,
  showModelTooltips: false,
  showVisionModelsOnly: false,
  showTopPicksOnly: false,
  selectedProvider: "all",
  serverUrl: "", // Will be set from API_BASE_URL on first load
  attachmentsDirectory: "SystemSculpt/Attachments",
  extractionsDirectory: "SystemSculpt/Extractions",
  systemPromptsDirectory: "SystemSculpt/System Prompts",
  verifiedDirectories: [],
  workflowEngine: createDefaultWorkflowEngineSettings(),

  skipEmptyNoteWarning: false,

  /**
   * NEW FIELDS DEFAULTS:
   */
  systemPromptType: "general-use",
  systemPromptPath: "",
  useLatestSystemPromptForNewChats: true,


  /**
   * Title generation prompt defaults
   */
  titleGenerationPrompt: DEFAULT_TITLE_GENERATION_PROMPT,
  titleGenerationPromptType: "precise",
  titleGenerationPromptPath: "",
  titleGenerationProviderId: "systemsculpt", // Default to native provider
  titleGenerationModelId: "", // Default to empty; logic should handle fallback if unset
  /**
   * Custom provider defaults
   */
  customProviders: [],

  modelFilterSettings: DEFAULT_FILTER_SETTINGS,

  favoriteModels: [],

  favoritesFilterSettings: DEFAULT_FAVORITES_FILTER_SETTINGS,

  favoriteChats: [],

  activeProvider: {
    id: "systemsculpt",
    name: "SystemSculpt",
    type: "native",
  },

  /**
   * Template settings defaults
   */
  templateHotkey: "/",
  enableTemplateHotkey: true,
  lastSaveAsNoteFolder: "SystemSculpt/AI Responses",
  chatExportPreferences: {
    options: createDefaultChatExportOptions(),
    lastFolder: "",
    openAfterExport: true,
    lastFileName: "",
  },

  showDiagnostics: false,
  enableExperimentalFeatures: false,
  // Deprecated option removed; custom providers are not filtered by server allowlists
  enableSystemSculptProvider: false,
  useSystemSculptAsFallback: false,

  /**
   * Percentage of the model context window to use (0-100)
   */
  contextWindowPercentage: 25,

  logLevel: LogLevel.WARNING,
  debugMode: false,
  preserveReasoningVerbatim: true,
  showUpdateNotifications: true,

  /**
   * MCP (Model Context Protocol) defaults
   * Note: Internal servers (filesystem, youtube) are now hardcoded in MCPService
   * and are always available. These defaults are kept for backwards compatibility.
   */
  mcpServers: [], // Only custom HTTP servers - internal servers are hardcoded
  mcpEnabledTools: [], // @deprecated - no longer used, all internal tools always available
  mcpAutoAcceptTools: [],
  mcpEnabled: true, // @deprecated - internal MCP is always enabled

  toolingRequireApprovalForDestructiveTools: true,
  toolingConcurrencyLimit: 3,
  toolingToolCallTimeoutMs: 30000,
  toolingMaxToolResultsInContext: 15,

  defaultChatTag: "",
  chatFontSize: "medium",
  respectReducedMotion: true,
  openAiApiKey: "",

  canvasFlowEnabled: false,

  replicateApiKey: "",
  replicateDefaultModelSlug: "",
  replicateResolvedVersion: "",
  replicatePollIntervalMs: 1000,
  replicateOutputDir: "SystemSculpt/Attachments/Generations",
  replicateSaveMetadataSidecar: true,

  /**
   * Embeddings defaults
   */
  embeddingsEnabled: false,
  embeddingsModel: "openrouter/openai/text-embedding-3-small",
  embeddingsAutoProcess: true,
  embeddingsExclusions: {
    folders: [],
    patterns: [],
    ignoreChatHistory: true,
    respectObsidianExclusions: true
  },
  embeddingsProvider: 'systemsculpt',
  embeddingsCustomEndpoint: '',
  embeddingsCustomApiKey: '',
  embeddingsCustomModel: '',
  embeddingsBatchSize: 20, // Optimized batch size for parallel processing
  embeddingsRateLimitPerMinute: 50, // Default rate limiting
  embeddingsQuietPeriodMs: 1200,
  // Search behavior defaults removed; handled internally
  
  /**
   * Automatic backup defaults
   */
  automaticBackupsEnabled: true, // Enable automatic backups by default
  automaticBackupInterval: 24, // Create backups every 24 hours
  automaticBackupRetentionDays: 30, // Keep backups for 30 days
  lastAutomaticBackup: 0, // No automatic backup yet
  
  /**
   * Model selection modal provider preferences defaults
   */
  selectedModelProviders: [], // Empty array means use default initialization logic

  // preserveReasoningVerbatim default already defined above

  /**
   * Meeting processor defaults
   */
  meetingProcessorOptions: {
    summary: true,
    actionItems: true,
    decisions: true,
    risks: false,
    questions: false,
    transcriptCleanup: true,
  },
  meetingProcessorOutputDirectory: "SystemSculpt/Extractions",
  meetingProcessorOutputNameTemplate: "{{basename}}-processed.md",

  /**
   * YouTube Canvas defaults
   */
  youtubeNotesFolder: "SystemSculpt/YouTube",
  youtubeCanvasToggles: {
    summary: true,
    keyPoints: false,
    studyNotes: false,
  },

  /**
   * Readwise integration defaults
   */
  readwiseEnabled: false,
  readwiseApiToken: "",
  readwiseDestinationFolder: "SystemSculpt/Readwise",
  readwiseOrganization: "by-category",
  readwiseTweetOrganization: "standalone",
  readwiseSyncMode: "interval",
  readwiseSyncIntervalMinutes: 60,
  readwiseLastSyncTimestamp: 0,
  readwiseLastSyncCursor: "",
  readwiseImportOptions: DEFAULT_READWISE_IMPORT_OPTIONS,

  /**
   * Runtime-discovered model incompatibilities
   */
  runtimeToolIncompatibleModels: {},
  runtimeImageIncompatibleModels: {},
};

export interface ApiStatusResponse {
  status: "ok" | "error" | "maintenance";
  message?: string;
  version?: string;
}


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

export interface SystemPromptInfo {
  type: string;
  path?: string;
}

export interface InputHandlerOptions {
  app: App;
  container: HTMLElement;
  aiService: SystemSculptService;
  getMessages: () => ChatMessage[];
  getSelectedModelId: () => string;
  getContextFiles: () => Set<string>;
  getSystemPrompt: () => SystemPromptInfo;
  chatContainer: HTMLElement;
  scrollManager: ScrollManagerService;
  messageRenderer: MessageRenderer;
  onMessageSubmit: (message: ChatMessage) => Promise<void>;
  onAssistantResponse: (message: ChatMessage) => Promise<void>;
  onContextFileAdd: (wikilink: string) => Promise<void>;
  onError: (error: string) => void;
  onAddContextFile: () => void;
  onEditSystemPrompt: () => void;
  plugin: SystemSculptPlugin;
  toolCallManager?: any; // Optional for backward compatibility
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
  documentContext?: {
    documentIds: string[];
  };
  systemPromptType?: string;
  systemPromptPath?: string;
  annotations?: Annotation[];
  webSearchEnabled?: boolean;
  // Additional fields for tool messages
  tool_call_id?: string;
  name?: string;
  // Tool calls from assistant messages
  tool_calls?: ToolCall[];
  // Reasoning trace from assistant messages
  reasoning?: string;
  // Provider-specific structured reasoning blocks (OpenRouter/OpenAI Responses-style)
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
  webSearchEnabled?: boolean;
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
