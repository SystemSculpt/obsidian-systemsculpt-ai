import { App, TFile, requestUrl } from "obsidian";
import {
  ChatMessage,
  SystemSculptModel,
  SystemSculptSettings,
  ApiStatusResponse,
} from "../types";
import {
  SystemSculptError,
  ERROR_CODES,
  isContextOverflowErrorMessage,
} from "../utils/errors";
// License checks removed for Agent Mode access
import { MCPService } from "../views/chatview/MCPService";
import SystemSculptPlugin from "../main";
import { DebugLogger } from "../utils/debugLogger";
import { getImageCompatibilityInfo, getToolCompatibilityInfo } from "../utils/modelUtils";
import { mapAssistantToolCallsForApi, normalizeJsonSchema, normalizeOpenAITools } from "../utils/tooling";
import { deterministicId } from "../utils/id";
import { Notice } from "obsidian";
import { PlatformContext } from "./PlatformContext";
import { SystemSculptEnvironment } from "./api/SystemSculptEnvironment";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";

// Import the new service classes
import { StreamingService } from "./StreamingService";
import { StreamingErrorHandler } from "./StreamingErrorHandler";
import type { StreamEvent, StreamPipelineDiagnostics } from "../streaming/types";
import { LicenseService } from "./LicenseService";
import { ModelManagementService } from "./ModelManagementService";
import { ContextFileService } from "./ContextFileService";
import { DocumentUploadService } from "./DocumentUploadService";
import { AudioUploadService } from "./AudioUploadService";
import { errorLogger } from "../utils/errorLogger";
import { AgentSessionClient, type AgentSessionRequest } from "./agent-v2/AgentSessionClient";
import { normalizePiTools } from "./agent-v2/PiToolAdapter";
import type { CustomProvider } from "../types/llm";
import { postJsonStreaming } from "../utils/streaming";
import { RuntimeIncompatibilityService } from "./RuntimeIncompatibilityService";

export interface StreamDebugCallbacks {
  onRequest?: (data: {
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, any>;
    transport?: string;
    canStream?: boolean;
    isCustomProvider?: boolean;
  }) => void;
  onResponse?: (data: {
    provider: string;
    endpoint: string;
    status: number;
    headers: Record<string, string>;
    isCustomProvider?: boolean;
  }) => void;
  onRawEvent?: (data: { line: string; payload: string }) => void;
  onStreamEvent?: (data: { event: StreamEvent }) => void;
  onStreamEnd?: (data: {
    completed: boolean;
    aborted: boolean;
    diagnostics?: StreamPipelineDiagnostics;
  }) => void;
  onError?: (data: { error: string; details?: any }) => void;
}

export type CreditsBalanceSnapshot = {
  includedRemaining: number;
  addOnRemaining: number;
  totalRemaining: number;
  includedPerMonth: number;
  cycleEndsAt: string;
  cycleStartedAt: string;
  cycleAnchorAt: string;
  turnInFlightUntil: string | null;
  purchaseUrl: string | null;
  billingCycle?: "monthly" | "annual" | "unknown";
  annualUpgradeOffer?: {
    amountSavedCents: number;
    percentSaved: number;
    annualPriceCents: number;
    monthlyEquivalentAnnualCents: number;
    checkoutUrl: string;
  } | null;
};

export type CreditsUsageSnapshot = {
  id: string;
  createdAt: string;
  transactionType: "agent_turn";
  endpoint: string | null;
  usageKind:
    | "audio_transcription"
    | "embeddings"
    | "document_processing"
    | "youtube_transcript"
    | "agent_turn"
    | "request";
  provider: string | null;
  model: string | null;
  durationSeconds: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  pageCount: number;
  creditsCharged: number;
  includedDelta: number;
  addOnDelta: number;
  totalDelta: number;
  includedBefore: number;
  includedAfter: number;
  addOnBefore: number;
  addOnAfter: number;
  totalBefore: number;
  totalAfter: number;
  rawUsd?: number;
  fileSizeBytes: number | null;
  fileFormat: string | null;
  billingFormulaVersion?: string | null;
  billingCreditsPerUsd?: number | null;
  billingMarkupMultiplier?: number | null;
  billingCreditsExact?: number | null;
};

export type CreditsUsageHistoryPage = {
  items: CreditsUsageSnapshot[];
  nextBefore: string | null;
};

interface PreparedChatRequest {
  isCustom: boolean;
  customProvider?: CustomProvider;
  actualModelId: string;
  serverModelId: string;
  preparedMessages: ChatMessage[];
  requestTools: any[];
  effectiveAgentMode: boolean;
  resolvedWebSearchOptions?: { search_context_size?: "low" | "medium" | "high" };
  finalSystemPrompt: string;
}

/**
 * Main service facade that delegates to specialized services
 */
export class SystemSculptService {
  private settings: SystemSculptSettings;
  private static instance: SystemSculptService | null = null;
  private mcpService: MCPService;
  public baseUrl: string;
  private plugin: SystemSculptPlugin;
  private warnedImageIncompatibilityModels = new Set<string>();

  // Specialized service instances
  private streamingService: StreamingService;
  private licenseService: LicenseService;
  private modelManagementService: ModelManagementService;
  private contextFileService: ContextFileService;
  private documentUploadService: DocumentUploadService;
  private audioUploadService: AudioUploadService;
  private agentSessionClient: AgentSessionClient;

  public get extractionsDirectory(): string {
    return this.settings.extractionsDirectory ?? "";
  }

  private buildRequestTools(tools: any[]): any[] {
    const validTools = normalizeOpenAITools(tools);
    if (validTools.length === 0) return [];
    return validTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: normalizeJsonSchema(tool.function.parameters || {}),
      },
    }));
  }

  private shouldFallbackWithoutTools(error: unknown): boolean {
    if (!error) return false;

    if (error instanceof SystemSculptError) {
      if (error.metadata?.shouldResubmitWithoutTools) {
        return true;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const lc = (message || "").toLowerCase();
    if (!lc) return false;

    return (
      lc.includes("does not support tools") ||
      lc.includes("tools not supported") ||
      lc.includes("tool calling not supported") ||
      lc.includes("tool calling is not supported") ||
      lc.includes("tool_calls not supported") ||
      lc.includes("function calling not supported") ||
      lc.includes("function_calling not supported") ||
      lc.includes("function_call not supported") ||
      lc.includes("additional properties are not allowed: 'tools'") ||
      lc.includes("unknown field: tools") ||
      lc.includes("unsupported parameter: tools") ||
      (lc.includes("extra fields not permitted") && lc.includes("tools"))
    );
  }

  private isContextOverflowError(error: unknown): boolean {
    if (!error) return false;

    if (error instanceof SystemSculptError) {
      const upstreamMessage =
        typeof error.metadata?.upstreamMessage === "string"
          ? String(error.metadata.upstreamMessage)
          : "";
      if (isContextOverflowErrorMessage(upstreamMessage || error.message)) {
        return true;
      }

      const raw = error.metadata?.rawError as any;
      const rawMessage = typeof raw?.message === "string" ? raw.message : "";
      const rawType = typeof raw?.type === "string" ? raw.type : "";
      const rawCode = typeof raw?.code === "string" ? raw.code : "";
      if (isContextOverflowErrorMessage(rawMessage || rawType || rawCode)) {
        return true;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return isContextOverflowErrorMessage(message);
  }

  private shouldRetryRateLimitedStreamTurn(error: unknown): { retryAfterSeconds?: number } | null {
    const parseSeconds = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return parsed;
        }
      }
      return undefined;
    };

    const isRateLimitLikeMessage = (message: string): boolean => {
      const lc = String(message || "").toLowerCase();
      if (!lc) return false;
      return (
        lc.includes("rate-limited upstream") ||
        lc.includes("rate limited upstream") ||
        lc.includes("temporarily rate-limited") ||
        lc.includes("temporarily rate limited") ||
        lc.includes("throttled") ||
        lc.includes("too many requests") ||
        lc.includes("retry after") ||
        lc.includes("retry shortly") ||
        lc.includes("rate limit") ||
        lc.includes("rate_limit")
      );
    };

    const isHardQuotaLikeMessage = (message: string): boolean => {
      const lc = String(message || "").toLowerCase();
      if (!lc) return false;
      return (
        lc.includes("insufficient_quota") ||
        lc.includes("insufficient quota") ||
        lc.includes("quota exhausted") ||
        lc.includes("usage quota exceeded") ||
        lc.includes("insufficient credits") ||
        lc.includes("out of credits") ||
        lc.includes("credits exhausted") ||
        lc.includes("add credits") ||
        lc.includes("purchase credits") ||
        lc.includes("billing") ||
        lc.includes("payment")
      );
    };

    if (error instanceof SystemSculptError) {
      const metadata = (error.metadata || {}) as Record<string, any>;
      const rawError = (metadata.rawError || {}) as Record<string, any>;
      const upstreamMessage =
        typeof metadata.upstreamMessage === "string"
          ? metadata.upstreamMessage
          : "";
      const rawMessage =
        typeof rawError.message === "string"
          ? rawError.message
          : typeof rawError.errorMessage === "string"
            ? rawError.errorMessage
            : "";
      const rawCode = typeof rawError.code === "string" ? rawError.code : "";
      const rawType = typeof rawError.type === "string" ? rawError.type : "";
      const nestedRawError =
        rawError.error && typeof rawError.error === "object"
          ? (rawError.error as Record<string, any>)
          : {};
      const nestedRawCode = typeof nestedRawError.code === "string" ? nestedRawError.code : "";
      const nestedRawType = typeof nestedRawError.type === "string" ? nestedRawError.type : "";
      const metadataErrorCode = typeof metadata.errorCode === "string" ? metadata.errorCode : "";
      const metadataType = typeof metadata.type === "string" ? metadata.type : "";
      const fullMessage = [
        error.message,
        upstreamMessage,
        rawMessage,
        rawCode,
        rawType,
        nestedRawCode,
        nestedRawType,
        metadataErrorCode,
        metadataType,
      ]
        .join(" ")
        .trim();
      const statusCode = Number(metadata.statusCode ?? error.statusCode ?? 0);
      const explicitRetry = metadata.shouldRetry === true || metadata.isRateLimited === true;
      const retryAfterSeconds =
        parseSeconds(metadata.retryAfterSeconds) ??
        parseSeconds(metadata.retryAfter) ??
        parseSeconds(metadata.retry_after_seconds) ??
        parseSeconds(metadata.retry_after) ??
        parseSeconds(rawError.retryAfterSeconds) ??
        parseSeconds(rawError.retry_after_seconds) ??
        parseSeconds(rawError.retry_after);
      const hasRetryAfter = typeof retryAfterSeconds === "number";
      const rateLimitLike = isRateLimitLikeMessage(fullMessage);
      const hardQuotaLike = isHardQuotaLikeMessage(fullMessage);
      const statusSuggestsRateLimit = statusCode === 429 && rateLimitLike;
      const isTransientRateLimit =
        !hardQuotaLike &&
        (explicitRetry || hasRetryAfter || rateLimitLike || statusSuggestsRateLimit);

      if (isTransientRateLimit) {
        return typeof retryAfterSeconds === "number"
          ? { retryAfterSeconds }
          : {};
      }
    }

    const message = error instanceof Error ? error.message : String(error || "");
    if (isHardQuotaLikeMessage(message)) {
      return null;
    }
    if (isRateLimitLikeMessage(message)) {
      return {};
    }

    return null;
  }

  private getRateLimitedRetryDelayMs(retryAfterSeconds: number | undefined, retryAttempt: number): number {
    if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.max(0, Math.min(15000, Math.round(retryAfterSeconds * 1000)));
    }

    const cappedAttempt = Math.max(1, Math.min(5, retryAttempt));
    const baseMs = 750;
    return Math.min(15000, baseMs * (2 ** (cappedAttempt - 1)));
  }

  private async waitForRetryWindow(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) return;
    if (signal?.aborted) return;

    await new Promise<void>((resolve) => {
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const finish = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };

      const onAbort = () => finish();
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      timeoutId = setTimeout(() => finish(), delayMs);
    });
  }

  private toSystemSculptApiMessages(messages: ChatMessage[]): any[] {
    const toolNameByOriginalCallId = new Map<string, string>();
    for (const message of messages || []) {
      if (message.role !== "assistant") continue;
      const toolCalls = (message as any).tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall.id !== "string") continue;
        const fnName = toolCall.function?.name;
        if (typeof fnName !== "string" || fnName.trim().length === 0) continue;
        toolNameByOriginalCallId.set(toolCall.id, fnName);
      }
    }

    const toolCallIdMap = new Map<string, string>();
    const mapToolCallId = (originalId: string): string => {
      if (/^call_[A-Za-z0-9_-]{8,128}$/.test(originalId)) return originalId;
      const existing = toolCallIdMap.get(originalId);
      if (existing) return existing;
      const normalized = deterministicId(originalId, "call");
      toolCallIdMap.set(originalId, normalized);
      return normalized;
    };

    const normalizeContent = (content: any): any => {
      if (content == null) return "";
      if (!Array.isArray(content)) return content;

      const parts: any[] = [];
      for (const part of content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          parts.push({ type: "text", text: part.text });
          continue;
        }
        if (part && part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
          parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
        }
      }

      if (parts.length === 0) return "";

      const hasImage = parts.some((p) => p.type === "image_url");
      if (!hasImage) {
        return parts
          .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
          .filter((s) => s.length > 0)
          .join("\n");
      }

      return parts;
    };

    return (messages || []).map((msg) => {
      const mapped: any = {
        role: msg.role,
      };

      const originalToolCallId = msg.tool_call_id;
      if (typeof originalToolCallId === "string" && originalToolCallId.length > 0) {
        mapped.tool_call_id = mapToolCallId(originalToolCallId);
      }
      if (msg.name) {
        mapped.name = msg.name;
      }
      if (msg.documentContext) {
        mapped.documentContext = msg.documentContext;
      }

      let toolCallsForApi: any[] | undefined;
      if (Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
        toolCallsForApi = mapAssistantToolCallsForApi((msg as any).tool_calls).map((tc) => ({
          ...tc,
          id: typeof tc?.id === "string" ? mapToolCallId(tc.id) : tc?.id,
        }));
        mapped.tool_calls = toolCallsForApi;
      }

      const reasoningDetails = (msg as any).reasoning_details;
      if (Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
        mapped.reasoning_details = reasoningDetails;
      }

      if (msg.content !== undefined) {
        if (
          msg.role === "assistant" &&
          toolCallsForApi &&
          toolCallsForApi.length > 0 &&
          typeof msg.content === "string" &&
          msg.content.trim().length === 0
        ) {
          mapped.content = null;
        } else {
          mapped.content = normalizeContent(msg.content);
        }
      }

      if (msg.role === "tool") {
        if (mapped.content == null) mapped.content = "";
        if ((!mapped.name || String(mapped.name).trim().length === 0) && typeof originalToolCallId === "string") {
          const toolName = toolNameByOriginalCallId.get(originalToolCallId);
          if (toolName) mapped.name = toolName;
        }
      }

      return mapped;
    });
  }

  private async prepareChatRequest(options: {
    messages: ChatMessage[];
    model: string;
    contextFiles?: Set<string>;
    systemPromptType?: string;
    systemPromptPath?: string;
    systemPromptOverride?: string;
    agentMode?: boolean;
    toolCallManager?: any;
    emitNotices?: boolean;
  }): Promise<PreparedChatRequest> {
    this.refreshSettings();

	    const {
	      messages,
	      model,
	      contextFiles,
	      systemPromptType,
	      systemPromptPath,
	      systemPromptOverride,
	      agentMode,
	      toolCallManager,
	      emitNotices = false,
	    } = options;

    const modelInfo = await this.modelManagementService.getModelInfo(model);
    const { actualModelId } = modelInfo;
    const serverModelId = this.normalizeServerModelId(actualModelId);
    const contextFileSet = contextFiles || new Set<string>();
    const imageContextCount = this.countImageContextFiles(contextFileSet);

    // Compute available tools (when requested) so prompt + request body stay consistent.
    let mcpTools: any[] = [];
    if (agentMode) {
      if (toolCallManager && typeof (toolCallManager as any).getOpenAITools === "function") {
        mcpTools = await (toolCallManager as any).getOpenAITools();
      } else {
        mcpTools = await this.mcpService.getAvailableTools();
      }
    }

    // Decide whether tools/images are actually usable for this model.
    let modelToCheck: SystemSculptModel | undefined;
    if ((agentMode && mcpTools.length > 0) || imageContextCount > 0) {
      try {
        const allModels = await this.plugin.modelService.getModels();
        modelToCheck = allModels.find((m) => m.id === model || m.id === actualModelId);
      } catch {}
    }

    let compatibleTools: any[] = [];
    let toolsEnabledForRequest = false;

    if (agentMode && mcpTools.length > 0) {
      if (modelToCheck) {
        const compatibility = getToolCompatibilityInfo(modelToCheck);

        if (!compatibility.isCompatible && compatibility.confidence === "high") {
          // Show notice every time tools are stripped (not just once)
          if (emitNotices) {
            new Notice(
              `Model does not support tools. Switch to Claude, GPT-4, etc. for agent features.`,
              4000
            );
          }
          toolsEnabledForRequest = false;
        } else {
          compatibleTools = mcpTools;
          toolsEnabledForRequest = true;
        }
      } else {
        // If we can't find the model, be optimistic.
        compatibleTools = mcpTools;
        toolsEnabledForRequest = true;
      }
    }

    let imagesEnabledForRequest = true;
    if (imageContextCount > 0 && modelToCheck) {
      const imageCompatibility = getImageCompatibilityInfo(modelToCheck);
      if (!imageCompatibility.isCompatible && imageCompatibility.confidence === "high") {
        imagesEnabledForRequest = false;

        const warnKey = modelToCheck.id || actualModelId || model;
        if (emitNotices && !this.warnedImageIncompatibilityModels.has(warnKey)) {
          this.warnedImageIncompatibilityModels.add(warnKey);
          const imageLabel = imageContextCount === 1 ? "image attachment" : "image attachments";
          new Notice(
            `Selected model does not support image input. Sending message without ${imageContextCount} ${imageLabel}. Switch to a vision-capable model to include images.`,
            7000
          );
        }
      }
    }

    const requestTools = toolsEnabledForRequest ? this.buildRequestTools(compatibleTools) : [];
    const hasRequestTools = requestTools.length > 0;
    const effectiveAgentMode = !!agentMode && hasRequestTools;

    // Compose final system prompt including agent prefix and tooling hint when applicable.
    let finalSystemPrompt = systemPromptOverride;
    if (!finalSystemPrompt) {
      const { PromptBuilder } = await import("./PromptBuilder");
      finalSystemPrompt = await PromptBuilder.buildSystemPrompt(
        this.plugin.app,
        () => this.plugin.settings,
        { type: (systemPromptType as any) || "general-use", path: systemPromptPath, agentMode: effectiveAgentMode, hasTools: hasRequestTools }
      );
    }

	    const preparedMessages = await this.contextFileService.prepareMessagesWithContext(
	      messages,
	      contextFileSet,
	      systemPromptType,
	      systemPromptPath,
	      effectiveAgentMode,
	      imagesEnabledForRequest,
	      toolCallManager,
	      finalSystemPrompt
	    );

	    return {
	      isCustom: modelInfo.isCustom,
	      customProvider: modelInfo.isCustom ? (modelInfo.provider as CustomProvider) : undefined,
	      actualModelId,
	      serverModelId,
	      preparedMessages,
	      requestTools,
	      effectiveAgentMode,
	      finalSystemPrompt,
	    };
	  }

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = plugin.settings;
    
    this.mcpService = new MCPService(plugin, plugin.app);
    
    // Ensure baseUrl is never empty - use development mode aware default if needed
    this.baseUrl = this.getValidServerUrl();

    // Initialize specialized services
    this.streamingService = new StreamingService();
    this.licenseService = new LicenseService(plugin, this.baseUrl);
    this.modelManagementService = new ModelManagementService(plugin, this.baseUrl);
    this.contextFileService = new ContextFileService(plugin.app);
    this.documentUploadService = new DocumentUploadService(
      plugin.app,
      this.baseUrl,
      this.settings.licenseKey,
      this.plugin.manifest?.version ?? "0.0.0"
    );
    this.audioUploadService = new AudioUploadService(plugin.app, this.baseUrl, this.settings.licenseKey);
    this.agentSessionClient = new AgentSessionClient({
      baseUrl: this.baseUrl,
      licenseKey: this.settings.licenseKey,
      request: (input) => this.requestAgentV2(input),
    });
  }

  /**
   * Get the singleton instance - use this instead of creating new instances
   */
  public static getInstance(plugin: SystemSculptPlugin): SystemSculptService {
    if (!SystemSculptService.instance) {
      SystemSculptService.instance = new SystemSculptService(plugin);
    } else {
      // Update settings if instance exists
      SystemSculptService.instance.updateSettings(plugin.settings);
    }
    return SystemSculptService.instance;
  }

  /**
   * Clear singleton instance for cleanup
   */
  public static clearInstance(): void {
    SystemSculptService.instance = null;
  }

  /**
   * Update settings on existing instance
   */
  public updateSettings(settings: SystemSculptSettings): void {
    this.settings = settings;
    this.refreshSettings();
  }

  private getValidServerUrl(): string {
    // Import development mode constants and helpers
    const { DEVELOPMENT_MODE } = require('../constants/api');
    if (DEVELOPMENT_MODE === 'DEVELOPMENT' && (!this.settings.serverUrl || this.settings.serverUrl.trim() === '')) {
      return 'http://localhost:3001/api/v1';
    }

    return SystemSculptEnvironment.resolveBaseUrl(this.settings);
  }

  private countImageContextFiles(contextFiles: Set<string>): number {
    if (!contextFiles || contextFiles.size === 0) {
      return 0;
    }

    let count = 0;

    for (const entry of contextFiles) {
      if (!entry || typeof entry !== "string") continue;
      if (entry.startsWith("doc:")) continue;

      const linkText = entry.replace(/^\[\[(.*?)\]\]$/, "$1");
      const cleanPath = linkText.replace(/\$begin:math:display\$\[(.*?)\$end:math:display\$]/g, "$1");
      const ext = (cleanPath.split(".").pop() || "").toLowerCase();
      if (ext && ["jpg", "jpeg", "png", "webp"].includes(ext)) {
        count++;
        continue;
      }

      const resolved =
        this.plugin.app.metadataCache.getFirstLinkpathDest(cleanPath, "") ??
        this.plugin.app.vault.getAbstractFileByPath(cleanPath);
      if (
        resolved instanceof TFile &&
        ["jpg", "jpeg", "png", "webp"].includes((resolved.extension || "").toLowerCase())
      ) {
        count++;
      }
    }

    return count;
  }

  private refreshSettings(): void {
    this.settings = this.plugin.settings;
    this.baseUrl = this.getValidServerUrl();
    
    // Update specialized services with new configuration
    this.licenseService.updateBaseUrl(this.baseUrl);
    this.modelManagementService.updateBaseUrl(this.baseUrl);
    this.documentUploadService.updateConfig(
      this.baseUrl,
      this.settings.licenseKey,
      this.plugin.manifest?.version ?? "0.0.0"
    );
    this.audioUploadService.updateConfig(this.baseUrl, this.settings.licenseKey);
    this.agentSessionClient.updateConfig({
      baseUrl: this.baseUrl,
      licenseKey: this.settings.licenseKey,
    });
  }

  /**
   * Normalize a server-facing model id to a canonical provider prefix when missing.
   * - Preserve Groq vendor-qualified IDs (e.g., 'groq/openai/gpt-4o') as-is.
   * - Preserve explicit 'openrouter/...' and 'groq/...' prefixes.
   * - If only a vendor is provided (e.g., 'openai/gpt-4o'), default to OpenRouter.
   */
  private normalizeServerModelId(id: string): string {
    if (!id) return id;
    const lower = id.toLowerCase();
    if (lower.startsWith('openrouter/') || lower.startsWith('groq/')) return id;
    const vendorPrefixes = ['openai/', 'anthropic/', 'google/', 'perplexity/', 'mistral/', 'meta/', 'cohere/', 'xai/', 'deepseek/'];
    if (vendorPrefixes.some(p => lower.startsWith(p))) {
      return `openrouter/${id}`;
    }
    return id;
  }

  private getAgentV2BaseUrl(): string {
    const trimmed = this.baseUrl.replace(/\/+$/, '');
    return trimmed.replace(/\/api\/v1$/i, '');
  }

  private async requestAgentV2(input: AgentSessionRequest): Promise<Response> {
    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: input.url });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: input.stream ? "text/event-stream" : "application/json",
      "x-license-key": this.settings.licenseKey,
      ...(input.headers || {}),
    };
    const body = typeof input.body === "undefined" ? undefined : JSON.stringify(input.body);

    if (transport === "fetch" && typeof fetch === "function") {
      try {
        return await fetch(input.url, {
          method: input.method,
          headers,
          body,
          cache: "no-store",
        } as RequestInit);
      } catch {}
    }

    const result = await requestUrl({
      url: input.url,
      method: input.method,
      headers,
      body,
      throw: false,
    });

    const status = result.status || 500;
    const textBody = typeof result.text === "string"
      ? result.text
      : JSON.stringify(result.json || {});

    if (input.stream && status < 400) {
      return new Response(textBody, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return new Response(textBody, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  public requestAgentSession(input: AgentSessionRequest): Promise<Response> {
    return this.requestAgentV2(input);
  }

  // DELEGATE TO LICENSE SERVICE
  async validateLicense(forceCheck = false): Promise<boolean> {
    this.refreshSettings(); // Ensure settings are current before validation
    return this.licenseService.validateLicense(forceCheck);
  }

  // DELEGATE TO MODEL MANAGEMENT SERVICE
  async getModels(): Promise<SystemSculptModel[]> {
    this.refreshSettings();
    return this.modelManagementService.getModels();
  }

  async preloadModels(): Promise<void> {
    return this.modelManagementService.preloadModels();
  }

  // DELEGATE TO DOCUMENT UPLOAD SERVICE
  public async uploadDocument(
    file: TFile
  ): Promise<{ documentId: string; status: string; cached?: boolean }> {
    return this.documentUploadService.uploadDocument(file);
  }

  // DELEGATE TO AUDIO UPLOAD SERVICE
  public async uploadAudio(
    file: TFile
  ): Promise<{ documentId: string; status: string; cached?: boolean }> {
    return this.audioUploadService.uploadAudio(file);
  }

  public async getCreditsBalance(): Promise<CreditsBalanceSnapshot> {
    this.refreshSettings();

    const licenseKey = (this.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "License key required to fetch credits balance.",
        ERROR_CODES.INVALID_LICENSE,
        401
      );
    }

    const url = `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CREDITS.BALANCE}`;
    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: url });

    const headers: Record<string, string> = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey),
      Accept: "application/json",
    };

    let response: Response;
    if (transport === "fetch" && typeof fetch === "function") {
      response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
      } as RequestInit);
    } else {
      const result = await requestUrl({
        url,
        method: "GET",
        headers,
        throw: false,
      });

      const status = result.status || 500;
      const textBody =
        typeof result.text === "string"
          ? result.text
          : JSON.stringify(result.json || {});

      response = new Response(textBody, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!response.ok) {
      await StreamingErrorHandler.handleStreamError(response, false, {
        provider: "systemsculpt",
        endpoint: url,
        model: "credits",
      });
    }

    const payload = (await response.json()) as any;
    const asNumber = (value: unknown): number => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return 0;
    };
    const asString = (value: unknown): string => (typeof value === "string" ? value : "");
    const resolveBillingCycle = (value: unknown): "monthly" | "annual" | "unknown" => {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized === "monthly" || normalized === "annual") {
        return normalized;
      }
      return "unknown";
    };
    const resolveCheckoutUrl = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
      }
      if (!trimmed.startsWith("/")) {
        return null;
      }
      try {
        return new URL(trimmed, SYSTEMSCULPT_WEBSITE.BASE_URL).toString();
      } catch {
        return null;
      }
    };
    const resolveAnnualUpgradeOffer = (value: unknown): CreditsBalanceSnapshot["annualUpgradeOffer"] => {
      if (!value || typeof value !== "object") {
        return null;
      }

      const payloadValue = value as Record<string, unknown>;
      const amountSavedCents = Math.floor(asNumber(payloadValue.amount_saved_cents));
      const percentSaved = Math.floor(asNumber(payloadValue.percent_saved));
      const annualPriceCents = Math.floor(asNumber(payloadValue.annual_price_cents));
      const monthlyEquivalentAnnualCents = Math.floor(asNumber(payloadValue.monthly_equivalent_annual_cents));
      const checkoutUrl = resolveCheckoutUrl(payloadValue.checkout_path);

      if (
        amountSavedCents <= 0 ||
        percentSaved <= 0 ||
        annualPriceCents <= 0 ||
        monthlyEquivalentAnnualCents <= annualPriceCents ||
        !checkoutUrl
      ) {
        return null;
      }

      return {
        amountSavedCents,
        percentSaved,
        annualPriceCents,
        monthlyEquivalentAnnualCents,
        checkoutUrl,
      };
    };

    const billingCycle = resolveBillingCycle(payload?.billing_cycle);
    const annualUpgradeOffer = resolveAnnualUpgradeOffer(payload?.annual_upgrade_offer);

    return {
      includedRemaining: asNumber(payload?.included_remaining),
      addOnRemaining: asNumber(payload?.add_on_remaining),
      totalRemaining: asNumber(payload?.total_remaining),
      includedPerMonth: asNumber(payload?.included_per_month),
      cycleEndsAt: asString(payload?.cycle_ends_at),
      cycleStartedAt: asString(payload?.cycle_started_at),
      cycleAnchorAt: asString(payload?.cycle_anchor_at),
      turnInFlightUntil: asString(payload?.turn_in_flight_until) || null,
      purchaseUrl:
        typeof payload?.purchase_url === "string" && payload.purchase_url.trim().length > 0
          ? payload.purchase_url.trim()
          : null,
      billingCycle,
      annualUpgradeOffer,
    };
  }

  public async getCreditsUsage(params?: {
    limit?: number;
    before?: string;
    endpoints?: string[];
  }): Promise<CreditsUsageHistoryPage> {
    this.refreshSettings();

    const licenseKey = (this.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "License key required to fetch credits usage.",
        ERROR_CODES.INVALID_LICENSE,
        401
      );
    }

    const requestUrlValue = new URL(
      `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CREDITS.USAGE}`
    );
    if (typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      requestUrlValue.searchParams.set("limit", String(Math.floor(params.limit)));
    }
    if (typeof params?.before === "string" && params.before.trim().length > 0) {
      requestUrlValue.searchParams.set("before", params.before.trim());
    }
    if (Array.isArray(params?.endpoints)) {
      for (const endpoint of params.endpoints) {
        if (typeof endpoint !== "string") continue;
        const trimmed = endpoint.trim();
        if (!trimmed) continue;
        requestUrlValue.searchParams.append("endpoint", trimmed);
      }
    }

    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: requestUrlValue.toString() });

    const headers: Record<string, string> = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey),
      Accept: "application/json",
    };

    let response: Response;
    if (transport === "fetch" && typeof fetch === "function") {
      response = await fetch(requestUrlValue.toString(), {
        method: "GET",
        headers,
        cache: "no-store",
      } as RequestInit);
    } else {
      const result = await requestUrl({
        url: requestUrlValue.toString(),
        method: "GET",
        headers,
        throw: false,
      });

      const status = result.status || 500;
      const textBody =
        typeof result.text === "string"
          ? result.text
          : JSON.stringify(result.json || {});

      response = new Response(textBody, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!response.ok) {
      await StreamingErrorHandler.handleStreamError(response, false, {
        provider: "systemsculpt",
        endpoint: requestUrlValue.toString(),
        model: "credits-usage",
      });
    }

    const payload = (await response.json()) as any;
    const asNumber = (value: unknown): number => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return 0;
    };
    const asString = (value: unknown): string => (typeof value === "string" ? value : "");
    const asNullableString = (value: unknown): string | null => {
      const str = asString(value).trim();
      return str.length > 0 ? str : null;
    };
    const asUsageKind = (value: unknown): CreditsUsageSnapshot["usageKind"] => {
      const raw = asString(value);
      if (
        raw === "audio_transcription" ||
        raw === "embeddings" ||
        raw === "document_processing" ||
        raw === "youtube_transcript" ||
        raw === "agent_turn" ||
        raw === "request"
      ) {
        return raw;
      }
      return "request";
    };

    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const items: CreditsUsageSnapshot[] = rawItems.map((item: any) => ({
      id: asString(item?.id),
      createdAt: asString(item?.created_at),
      transactionType: "agent_turn",
      endpoint: asNullableString(item?.endpoint),
      usageKind: asUsageKind(item?.usage_kind),
      provider: asNullableString(item?.provider),
      model: asNullableString(item?.model),
      durationSeconds: asNumber(item?.duration_seconds),
      totalTokens: asNumber(item?.total_tokens),
      inputTokens: asNumber(item?.input_tokens),
      outputTokens: asNumber(item?.output_tokens),
      cacheReadTokens: asNumber(item?.cache_read_tokens),
      cacheWriteTokens: asNumber(item?.cache_write_tokens),
      pageCount: asNumber(item?.page_count),
      creditsCharged: asNumber(item?.credits_charged),
      includedDelta: asNumber(item?.included_delta),
      addOnDelta: asNumber(item?.add_on_delta),
      totalDelta: asNumber(item?.total_delta),
      includedBefore: asNumber(item?.included_before),
      includedAfter: asNumber(item?.included_after),
      addOnBefore: asNumber(item?.add_on_before),
      addOnAfter: asNumber(item?.add_on_after),
      totalBefore: asNumber(item?.total_before),
      totalAfter: asNumber(item?.total_after),
      rawUsd: asNumber(item?.raw_usd),
      fileSizeBytes:
        item?.file_size_bytes === null || item?.file_size_bytes === undefined
          ? null
          : asNumber(item?.file_size_bytes),
      fileFormat: asNullableString(item?.file_format),
      billingFormulaVersion: asNullableString(item?.billing_formula_version),
      billingCreditsPerUsd:
        item?.billing_credits_per_usd === null || item?.billing_credits_per_usd === undefined
          ? null
          : asNumber(item?.billing_credits_per_usd),
      billingMarkupMultiplier:
        item?.billing_markup_multiplier === null || item?.billing_markup_multiplier === undefined
          ? null
          : asNumber(item?.billing_markup_multiplier),
      billingCreditsExact:
        item?.billing_credits_exact === null || item?.billing_credits_exact === undefined
          ? null
          : asNumber(item?.billing_credits_exact),
    }));

    return {
      items,
      nextBefore: asNullableString(payload?.next_before),
    };
  }

	  async *streamMessage({
	    messages,
	    model,
	    onError,
	    contextFiles,
	    systemPromptType,
	    systemPromptPath,
	    systemPromptOverride,
	    agentMode,
	    signal,
	    toolCallManager,
	    forcedToolName,
	    maxTokens,
	    includeReasoning,
	    debug,
	    sessionId,
  }: {
    messages: ChatMessage[];
    model: string;
    onError?: (error: string) => void;
    contextFiles?: Set<string>;
    systemPromptType?: string;
    systemPromptPath?: string;
	    systemPromptOverride?: string;
	    agentMode?: boolean;
	    signal?: AbortSignal;
	    toolCallManager?: any;
	    forcedToolName?: string;
	    maxTokens?: number;
	    includeReasoning?: boolean;
	    debug?: StreamDebugCallbacks;
    sessionId?: string;
  }): AsyncGenerator<StreamEvent, void, unknown> {
    // DEVELOPMENT MODE LOGGING: Log development mode status and server configuration
    const { DEVELOPMENT_MODE } = await import('../constants/api');
    const chatSessionId = sessionId || this.streamingService.generateRequestId();
    
    this.refreshSettings();
    const platform = PlatformContext.get();
    
    // No license gating here; provider APIs will enforce access if needed
    
    try {
      // Trace stream start when debug mode is enabled
      errorLogger.debug('Starting streamMessage', {
        source: 'SystemSculptService',
        method: 'streamMessage',
        metadata: { model, agentMode: !!agentMode }
      });

	      const prepared = await this.prepareChatRequest({
	        messages,
	        model,
	        contextFiles,
	        systemPromptType,
	        systemPromptPath,
	        systemPromptOverride,
	        agentMode,
	        toolCallManager,
	        emitNotices: true,
	      });

      const {
        isCustom,
        customProvider,
        actualModelId,
        serverModelId,
	        preparedMessages,
	        requestTools,
	        effectiveAgentMode,
	        finalSystemPrompt,
	      } = prepared;

      if (isCustom && customProvider) {
        const adapter = this.plugin.customProviderService.getProviderAdapter(customProvider);
        const endpoint = adapter.getChatEndpoint();

        const headers = {
          "Content-Type": "application/json",
          ...adapter.getHeaders(),
        };

        const baseContextFiles = contextFiles ? new Set(contextFiles) : new Set<string>();
        const baseMessages = Array.isArray(messages) ? [...messages] : [];

        const trimToRecentMessages = (all: ChatMessage[], maxCount: number): ChatMessage[] => {
          if (!Array.isArray(all)) return [];
          if (maxCount <= 0) return [];
          if (all.length <= maxCount) return all;
          return all.slice(-maxCount);
        };

        const trimToMinimalMessages = (all: ChatMessage[]): ChatMessage[] => {
          if (!Array.isArray(all) || all.length === 0) return [];
          // Prefer the last user message; if missing, keep the last message.
          const lastUser = [...all].reverse().find((msg) => msg?.role === "user");
          return lastUser ? [lastUser] : [all[all.length - 1]];
        };

        const buildAttemptRequestBody = async (opts: {
          attemptMessages: ChatMessage[];
          attemptContextFiles: Set<string>;
          attemptAgentMode: boolean;
        }): Promise<{ requestBody: any; prepared: PreparedChatRequest }> => {
	          const attemptPrepared = await this.prepareChatRequest({
	            messages: opts.attemptMessages,
	            model,
	            contextFiles: opts.attemptContextFiles,
	            systemPromptType,
	            systemPromptPath,
	            systemPromptOverride,
	            agentMode: opts.attemptAgentMode,
	            toolCallManager,
	            emitNotices: false,
	          });

          const attemptRequestBody = adapter.buildRequestBody(
            attemptPrepared.preparedMessages,
            attemptPrepared.actualModelId,
	            attemptPrepared.requestTools,
	            true,
	            {
	              maxTokens,
	              includeReasoning,
	            }
	          );

          return { requestBody: attemptRequestBody, prepared: attemptPrepared };
        };

        // Initial attempt uses the already-prepared request (so notices and prompt assembly match).
        let attemptAgentMode = !!agentMode;
        let attemptContextFiles = baseContextFiles;
        let attemptMessages = baseMessages;

        let activePrepared: PreparedChatRequest = prepared;
        let activeRequestBody: any = adapter.buildRequestBody(
          preparedMessages,
          actualModelId,
	          requestTools,
	          true,
	          {
	            maxTokens,
	            includeReasoning,
	          }
	        );

        let emittedAssistantOutput = false;
        let attempt = 0;

        let droppedContextFiles = false;
        let trimmedHistory = false;
        let trimmedMinimal = false;
        let disabledToolsForToolRejection = false;
        let disabledToolsForContextLimit = false;

        const MAX_ATTEMPTS = 5;
        while (attempt < MAX_ATTEMPTS) {
          try {
            try {
              debug?.onRequest?.({
                provider: customProvider.name || "custom-provider",
                endpoint,
                headers,
                body: activeRequestBody,
                transport: platform.preferredTransport({ endpoint }),
                canStream: platform.supportsStreaming({ endpoint }),
                isCustomProvider: true,
              });
            } catch {}

            const response = await postJsonStreaming(endpoint, headers, activeRequestBody, platform.isMobile(), signal);

            try {
              const responseHeaders: Record<string, string> = {};
              response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
              });
              debug?.onResponse?.({
                provider: customProvider.name || "custom-provider",
                endpoint,
                status: response.status,
                headers: responseHeaders,
                isCustomProvider: true,
              });
            } catch {}

            if (!response.ok) {
              await StreamingErrorHandler.handleStreamError(response, true, {
                provider: customProvider.name,
                endpoint,
                model: actualModelId,
              });
            }

            const transformed = await adapter.transformStreamResponse(response, platform.isMobile());
            const streamResponse = new Response(transformed.stream, {
              status: response.status,
              headers: transformed.headers,
            });

            let streamDiagnostics: StreamPipelineDiagnostics | null = null;
            const streamIterator = this.streamingService.streamResponse(streamResponse, {
              model: activePrepared.actualModelId,
              isCustomProvider: true,
              signal,
              onRawEvent: (data) => {
                try {
                  debug?.onRawEvent?.(data);
                } catch {}
              },
              onDiagnostics: (diagnostics) => {
                streamDiagnostics = diagnostics;
              },
            });

            let streamCompleted = false;
            let streamAborted = false;
            try {
              for await (const event of streamIterator) {
                if (event.type === "content" || event.type === "reasoning" || event.type === "tool-call") {
                  emittedAssistantOutput = true;
                }
                try {
                  debug?.onStreamEvent?.({ event });
                } catch {}
                yield event;
              }
              streamCompleted = true;
            } finally {
              streamAborted = !!signal?.aborted;
              try {
                debug?.onStreamEnd?.({
                  completed: streamCompleted,
                  aborted: streamAborted,
                  diagnostics: streamDiagnostics ?? undefined,
                });
              } catch {}
            }

            return;
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              return;
            }
            if (signal?.aborted) {
              return;
            }

            const canRetry = !emittedAssistantOutput && attempt < MAX_ATTEMPTS - 1;
            const needsToolFallback = canRetry && !disabledToolsForToolRejection && this.shouldFallbackWithoutTools(error);

            if (needsToolFallback) {
              attempt += 1;
              disabledToolsForToolRejection = true;
              attemptAgentMode = false;

              try {
                const incompat = RuntimeIncompatibilityService.getInstance(this.plugin);
                await incompat.markToolIncompatible(model);
              } catch {}
              try {
                new Notice("Model rejected tools; continuing without Agent Mode tools.", 5000);
              } catch {}

              try {
                yield { type: "meta", key: "inline-footnote", value: "Retrying without Agent Mode tools…" } as any;
              } catch {}

              const rebuilt = await buildAttemptRequestBody({
                attemptMessages,
                attemptContextFiles,
                attemptAgentMode,
              });
              activePrepared = rebuilt.prepared;
              activeRequestBody = rebuilt.requestBody;
              continue;
            }

            const isContextOverflow = canRetry && this.isContextOverflowError(error);
            if (isContextOverflow) {
              // Prefer keeping Agent Mode when possible; shed context first.
              if (!droppedContextFiles && attemptContextFiles.size > 0) {
                attempt += 1;
                droppedContextFiles = true;
                attemptContextFiles = new Set<string>();
                try {
                  yield { type: "meta", key: "inline-footnote", value: "Prompt too long. Retrying without attached context files…" } as any;
                } catch {}

                const rebuilt = await buildAttemptRequestBody({
                  attemptMessages,
                  attemptContextFiles,
                  attemptAgentMode,
                });
                activePrepared = rebuilt.prepared;
                activeRequestBody = rebuilt.requestBody;
                continue;
              }

              if (!trimmedHistory && attemptMessages.length > 8) {
                attempt += 1;
                trimmedHistory = true;
                attemptMessages = trimToRecentMessages(baseMessages, 12);
                try {
                  yield { type: "meta", key: "inline-footnote", value: "Prompt too long. Retrying with shortened chat history…" } as any;
                } catch {}

                const rebuilt = await buildAttemptRequestBody({
                  attemptMessages,
                  attemptContextFiles,
                  attemptAgentMode,
                });
                activePrepared = rebuilt.prepared;
                activeRequestBody = rebuilt.requestBody;
                continue;
              }

              if (!disabledToolsForContextLimit && attemptAgentMode) {
                attempt += 1;
                disabledToolsForContextLimit = true;
                attemptAgentMode = false;
                try {
                  yield { type: "meta", key: "inline-footnote", value: "Prompt too long. Retrying without Agent Mode tools…" } as any;
                } catch {}

                const rebuilt = await buildAttemptRequestBody({
                  attemptMessages,
                  attemptContextFiles,
                  attemptAgentMode,
                });
                activePrepared = rebuilt.prepared;
                activeRequestBody = rebuilt.requestBody;
                continue;
              }

              if (!trimmedMinimal) {
                attempt += 1;
                trimmedMinimal = true;
                attemptMessages = trimToMinimalMessages(baseMessages);
                try {
                  yield { type: "meta", key: "inline-footnote", value: "Prompt too long. Retrying with minimal context…" } as any;
                } catch {}

                const rebuilt = await buildAttemptRequestBody({
                  attemptMessages,
                  attemptContextFiles,
                  attemptAgentMode,
                });
                activePrepared = rebuilt.prepared;
                activeRequestBody = rebuilt.requestBody;
                continue;
              }
            }

            throw error;
          }
        }

        return;
      }

      // Debug: log the final system prompt being sent (first system message)
      try {
        const debugMode = this.plugin.settings?.debugMode || false;
        if (debugMode) {
          const sysMsg = preparedMessages.find(m => m.role === 'system');
          const content = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
          const preview = content.slice(0, 600);
          errorLogger.debug('Prepared system prompt for request', {
            source: 'SystemSculptService',
            method: 'streamMessage',
            metadata: {
              hasSystemMessage: !!sysMsg,
              systemLength: content.length,
              agentMode: effectiveAgentMode,
              systemPromptType: systemPromptType || 'undefined',
              systemPromptPath: systemPromptPath || undefined,
              preview,
              systemPrompt: content
            }
          });
        }
      } catch {}

      const apiMessages = this.toSystemSculptApiMessages(preparedMessages);
      const endpoint = `${this.getAgentV2BaseUrl()}${SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSIONS}`;
      const piTools = normalizePiTools(requestTools);
      const requestBody = {
        modelId: serverModelId,
        messages: apiMessages,
        tools: piTools,
        stream: true,
      };

      try {
        debug?.onRequest?.({
          provider: "systemsculpt-v2",
          endpoint,
          headers: {
            "Content-Type": "application/json",
            "x-license-key": this.settings.licenseKey,
          },
          body: requestBody,
          transport: platform.preferredTransport({ endpoint }),
          canStream: true,
          isCustomProvider: false,
        });
      } catch {}

      const logger = DebugLogger.getInstance();
      const responseLogEndpoint = `${this.getAgentV2BaseUrl()}${SYSTEMSCULPT_API_ENDPOINTS.AGENT.BASE}`;
      let emittedAssistantOutput = false;
      let attempt = 0;
      const MAX_PI_STREAM_ATTEMPTS = 3;

      while (attempt < MAX_PI_STREAM_ATTEMPTS) {
        if (signal?.aborted) {
          return;
        }
        try {
          const response = await this.agentSessionClient.startOrContinueTurn({
            chatId: chatSessionId,
            modelId: serverModelId,
            messages: apiMessages,
            tools: piTools,
            pluginVersion: (this.plugin as any)?.manifest?.version,
          });

          // Log API response status
          logger?.logAPIResponse(responseLogEndpoint, response.status);

          try {
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              responseHeaders[key] = value;
            });
            debug?.onResponse?.({
              provider: "systemsculpt",
              endpoint: responseLogEndpoint,
              status: response.status,
              headers: responseHeaders,
              isCustomProvider: false,
            });
          } catch {}

          if (!response.ok) {
            logger?.logAPIResponse(responseLogEndpoint, response.status, null, { message: `HTTP ${response.status}` });
            await StreamingErrorHandler.handleStreamError(response, false, {
              provider: "systemsculpt-v2",
              endpoint: responseLogEndpoint,
              model: serverModelId || actualModelId
            });
          }
          if (!response.body) {
            throw new SystemSculptError(
              "Missing response body from streaming API",
              ERROR_CODES.STREAM_ERROR,
              response.status
            );
          }
          // Log response meta for diagnostics
          try {
            errorLogger.debug('Streaming response received', {
              source: 'SystemSculptService',
              method: 'streamMessage',
              metadata: {
                status: response.status,
                contentType: response.headers.get('content-type') || 'unknown',
                hasBody: !!response.body,
                attempt: attempt + 1,
              }
            });
          } catch {}

          let streamDiagnostics: StreamPipelineDiagnostics | null = null;
          const streamIterator = this.streamingService.streamResponse(response, {
            model: serverModelId || actualModelId,
            isCustomProvider: false,
            signal,
            onRawEvent: (data) => {
              try {
                debug?.onRawEvent?.(data);
              } catch {}
            },
            onDiagnostics: (diagnostics) => {
              streamDiagnostics = diagnostics;
            },
          });

          let streamCompleted = false;
          let streamAborted = false;
          try {
            for await (const event of streamIterator) {
              if (event.type === "content" || event.type === "reasoning" || event.type === "tool-call") {
                emittedAssistantOutput = true;
              }
              try {
                debug?.onStreamEvent?.({ event });
              } catch {}
              yield event;
            }
            streamCompleted = true;
          } finally {
            streamAborted = !!signal?.aborted;
            try {
              debug?.onStreamEnd?.({
                completed: streamCompleted,
                aborted: streamAborted,
                diagnostics: streamDiagnostics ?? undefined,
              });
            } catch {}
          }

          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          if (signal?.aborted) {
            return;
          }

          const retryHints = this.shouldRetryRateLimitedStreamTurn(error);
          const canRetry =
            !emittedAssistantOutput &&
            retryHints !== null &&
            attempt < MAX_PI_STREAM_ATTEMPTS - 1;
          if (!canRetry) {
            throw error;
          }

          attempt += 1;
          const retryDelayMs = this.getRateLimitedRetryDelayMs(retryHints?.retryAfterSeconds, attempt);
          try {
            errorLogger.debug("Retrying PI turn after transient upstream rate limit", {
              source: "SystemSculptService",
              method: "streamMessage",
              metadata: {
                model: serverModelId || actualModelId,
                attempt,
                maxAttempts: MAX_PI_STREAM_ATTEMPTS,
                delayMs: retryDelayMs,
              },
            });
          } catch {}
          await this.waitForRetryWindow(retryDelayMs, signal);
          if (signal?.aborted) {
            return;
          }
          // Yield one event-loop tick so aborts queued immediately after backoff
          // are observed before issuing another upstream turn request.
          await this.waitForRetryWindow(0, signal);
          if (signal?.aborted) {
            return;
          }
          try {
            yield {
              type: "meta",
              key: "inline-footnote",
              value: `Provider is temporarily rate-limited. Retrying automatically (${attempt + 1}/${MAX_PI_STREAM_ATTEMPTS})…`,
            } as any;
          } catch {}
          continue;
        }
      }

      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // Handle abort gracefully
        return;
      }
      // Emit detailed error for diagnostics
      try {
        errorLogger.error('Stream error in streamMessage', error, {
          source: 'SystemSculptService',
          method: 'streamMessage',
          metadata: { model }
        });
      } catch {}
      try {
        debug?.onError?.({
          error: error instanceof Error ? error.message : String(error),
          details: error,
        });
      } catch {}
      if (onError) {
        let errorMessage =
          error instanceof Error
            ? error.message
            : "An unknown error occurred";

        if (
          error instanceof SystemSculptError &&
          error.code === ERROR_CODES.STREAM_ERROR &&
          error.statusCode === 400
        ) {
          errorMessage +=
            "\nPlease try again in a few moments. If the issue persists, try selecting a different model.";
        }
        onError(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Build a faithful preview of the next chat request body without sending it
   */
  public async buildRequestPreview({
    messages,
    model,
    contextFiles,
    systemPromptType,
    systemPromptPath,
    agentMode,
    toolCallManager,
    sessionId,
  }: {
    messages: ChatMessage[];
    model: string;
    contextFiles?: Set<string>;
    systemPromptType?: string;
    systemPromptPath?: string;
    agentMode?: boolean;
    toolCallManager?: any;
    sessionId?: string;
  }): Promise<{ requestBody: Record<string, any>; preparedMessages: ChatMessage[]; actualModelId: string }> {
    const prepared = await this.prepareChatRequest({
      messages,
      model,
      contextFiles,
      systemPromptType,
      systemPromptPath,
      agentMode,
      toolCallManager,
      emitNotices: false,
    });

    const requestBody: Record<string, any> = {
      model: prepared.serverModelId,
      messages: this.toSystemSculptApiMessages(prepared.preparedMessages),
      stream: true,
      include_reasoning: true,
      provider: { allow_fallbacks: false },
    };

    if (sessionId) {
      requestBody.session_id = deterministicId(sessionId, "sess");
    }

    if (prepared.requestTools.length > 0) {
      requestBody.tools = prepared.requestTools;
      requestBody.tool_choice = "auto";
      requestBody.parallel_tool_calls = false;
    }

    return {
      requestBody,
      preparedMessages: prepared.preparedMessages,
      actualModelId: prepared.serverModelId,
    };
  }

  public async getApiStatus(): Promise<ApiStatusResponse | null> {
    this.refreshSettings();
    const endpoint = `${this.baseUrl}/status`;
    try {
      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({
        url: endpoint,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.settings.licenseKey && { 'x-license-key': this.settings.licenseKey }) as any
        }
      });
      if (!response.status || response.status >= 400) {
        return { status: "error", message: `API request failed with status ${response.status}` };
      }
      const data = response.json || (response.text ? JSON.parse(response.text) : {});
      return data as ApiStatusResponse;
    } catch (error) {
      return { status: "error", message: "Failed to connect to SystemSculpt API. Please check your network connection and server URL."};
    }
  }
}
