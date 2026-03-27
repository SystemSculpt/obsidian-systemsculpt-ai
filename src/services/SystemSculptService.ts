import { TFile, requestUrl } from "obsidian";
import {
  ChatMessage,
  SystemSculptModel,
  SystemSculptSettings,
  ApiStatusResponse,
} from "../types";
import {
  SystemSculptError,
  ERROR_CODES,
} from "../utils/errors";
import SystemSculptPlugin from "../main";
import { getImageCompatibilityInfo } from "../utils/modelUtils";
import { mapAssistantToolCallsForApi, normalizeOpenAITools, type OpenAITool } from "../utils/tooling";
import { deterministicId } from "../utils/id";
import { Notice } from "obsidian";
import { PlatformContext } from "./PlatformContext";
import { PlatformRequestClient } from "./PlatformRequestClient";
import { SystemSculptEnvironment } from "./api/SystemSculptEnvironment";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { AGENT_PRESET } from "../constants/prompts";

// Import the new service classes
import { StreamingService } from "./StreamingService";
import { StreamingErrorHandler } from "./StreamingErrorHandler";
import type { StreamEvent } from "../streaming/types";
import { LicenseService } from "./LicenseService";
import { ModelManagementService } from "./ModelManagementService";
import { ContextFileService } from "./ContextFileService";
import { DocumentUploadService } from "./DocumentUploadService";
import { AudioUploadService } from "./AudioUploadService";
import { executeLocalPiStream } from "./LocalPiStreamExecutor";
import { errorLogger } from "../utils/errorLogger";
import type { PreparedChatRequest, StreamDebugCallbacks } from "./StreamExecutionTypes";
import { MCPService } from "../mcp/MCPService";
import type { ToolCall, ToolCallRequest, ToolCallResult } from "../types/toolCalls";

export type { StreamDebugCallbacks } from "./StreamExecutionTypes";

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

function serializeResponseHeaders(headers: unknown): Record<string, string> {
  const serialized: Record<string, string> = {};
  if (!headers) {
    return serialized;
  }

  const maybeHeaders = headers as {
    forEach?: (callback: (value: unknown, key: unknown) => void) => void;
    entries?: () => Iterable<[unknown, unknown]>;
  };

  if (typeof maybeHeaders.forEach === "function") {
    maybeHeaders.forEach((value, key) => {
      serialized[String(key)] = String(value);
    });
    return serialized;
  }

  if (typeof maybeHeaders.entries === "function") {
    try {
      for (const [key, value] of maybeHeaders.entries()) {
        serialized[String(key)] = String(value);
      }
      return serialized;
    } catch {
      // Fall through to object-style normalization below.
    }
  }

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        serialized[String(entry[0])] = String(entry[1]);
      }
    }
    return serialized;
  }

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      serialized[String(key)] = value.map((item) => String(item)).join(", ");
    } else if (value !== undefined) {
      serialized[String(key)] = String(value);
    }
  }

  return serialized;
}

/**
 * Main service facade that delegates to specialized services
 */
export class SystemSculptService {
  private settings: SystemSculptSettings;
  private static instance: SystemSculptService | null = null;
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
  private platformRequestClient: PlatformRequestClient;
  private mcpService: MCPService;

  public get extractionsDirectory(): string {
    return this.settings.extractionsDirectory ?? "";
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
    systemPromptOverride?: string;
    emitNotices?: boolean;
    allowTools?: boolean;
  }): Promise<PreparedChatRequest> {
    this.refreshSettings();

	    const {
	      messages,
	      model,
	      contextFiles,
	      systemPromptOverride,
	      emitNotices = false,
	    } = options;

    const modelInfo = await this.modelManagementService.getModelInfo(model);
    const modelSource = modelInfo.modelSource;
    const actualModelId = modelInfo.actualModelId;
    const providerId = actualModelId.split("/")[0] || "unknown";
    const providerModelId = actualModelId.split("/").slice(1).join("/") || actualModelId;
    const resolvedModel =
      modelInfo.model ||
      ({
        id: model,
        name: providerModelId,
        description: "",
        provider: providerId,
        sourceMode: modelSource,
        sourceProviderId: providerId,
        identifier: {
          providerId,
          modelId: providerModelId,
          displayName: providerModelId,
        },
        piExecutionModelId: actualModelId,
        piAuthMode: "local",
        piRemoteAvailable: false,
        piLocalAvailable: true,
        context_length: 0,
        capabilities: [],
        architecture: {
          modality: "text->text",
          tokenizer: "",
          instruct_type: null,
        },
        pricing: {
          prompt: "0",
          completion: "0",
          image: "0",
          request: "0",
        },
      } as SystemSculptModel);
    const contextFileSet = contextFiles || new Set<string>();
    const imageContextCount = this.countImageContextFiles(contextFileSet);

    // Decide whether tools/images are actually usable for this model.
    const modelToCheck: SystemSculptModel | undefined = resolvedModel;

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

    const finalSystemPrompt =
      typeof systemPromptOverride === "string" && systemPromptOverride.trim().length > 0
        ? systemPromptOverride.trim()
        : modelSource === "systemsculpt"
          ? AGENT_PRESET.systemPrompt
        : undefined;

    let tools: OpenAITool[] = [];
    if (
      options.allowTools !== false &&
      modelSource === "systemsculpt"
      && Array.isArray(resolvedModel.supported_parameters)
      && resolvedModel.supported_parameters.includes("tools")
    ) {
      try {
        tools = normalizeOpenAITools(await this.mcpService.getAvailableTools());
      } catch (error) {
        errorLogger.warn("Failed to resolve available MCP tools for hosted SystemSculpt chat", {
          source: "SystemSculptService",
          method: "prepareChatRequest",
          metadata: {
            model,
            actualModelId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        tools = [];
      }
    }

    const preparedMessages = await this.contextFileService.prepareMessagesWithContext(
      messages,
      contextFileSet,
      imagesEnabledForRequest,
      finalSystemPrompt
    );

    return {
      modelSource,
      resolvedModel,
      actualModelId,
      preparedMessages,
      finalSystemPrompt: finalSystemPrompt || "",
      tools,
    };
  }

  private buildHostedChatRequestBody(options: {
    prepared: PreparedChatRequest;
    forcedToolName?: string;
    maxTokens?: number;
    reasoningEffort?: string;
    webSearchEnabled?: boolean;
  }): Record<string, any> {
    const body: Record<string, any> = {
      model: options.prepared.actualModelId,
      messages: this.toSystemSculptApiMessages(options.prepared.preparedMessages),
      stream: true,
    };

    if (
      typeof options.maxTokens === "number"
      && Number.isFinite(options.maxTokens)
      && options.maxTokens > 0
    ) {
      body.max_completion_tokens = Math.max(1, Math.floor(options.maxTokens));
    }

    const forcedToolName = String(options.forcedToolName || "").trim();
    if (forcedToolName) {
      body.tool_choice = {
        type: "function",
        function: {
          name: forcedToolName,
        },
      };
    }

    const normalizedReasoningEffort = this.normalizeReasoningEffort(options.reasoningEffort);
    if (normalizedReasoningEffort) {
      body.reasoning_effort = normalizedReasoningEffort;
    }

    if (Array.isArray(options.prepared.tools) && options.prepared.tools.length > 0) {
      body.tools = options.prepared.tools;
    }

    if (options.webSearchEnabled) {
      body.plugins = [{ id: "web" }];
    }

    return body;
  }

  private buildLocalPiRequestPreview(options: {
    prepared: PreparedChatRequest;
    sessionFile?: string;
    reasoningEffort?: string;
  }): Record<string, any> {
    const body: Record<string, any> = {
      transport: "pi-sdk",
      model: options.prepared.actualModelId,
      messageCount: options.prepared.preparedMessages.length,
      messages: this.toSystemSculptApiMessages(options.prepared.preparedMessages),
      sourceMode: options.prepared.modelSource,
    };

    const systemPrompt = String(options.prepared.finalSystemPrompt || "").trim();
    if (systemPrompt) {
      body.system_prompt = systemPrompt;
    }

    const normalizedReasoningEffort = this.normalizeReasoningEffort(options.reasoningEffort);
    if (normalizedReasoningEffort) {
      body.reasoning_effort = normalizedReasoningEffort;
    }

    const sessionFile = String(options.sessionFile || "").trim();
    if (sessionFile) {
      body.session_file = sessionFile;
    }

    return body;
  }

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = plugin.settings;
    
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
    this.platformRequestClient = new PlatformRequestClient();
    this.mcpService = new MCPService(plugin, plugin.app);
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

  private normalizeReasoningEffort(value: unknown): string | undefined {
    const normalized = String(value || "").trim().toLowerCase();
    if (
      normalized === "off" ||
      normalized === "minimal" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh"
    ) {
      return normalized;
    }
    return undefined;
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
    systemPromptOverride,
    signal,
    forcedToolName,
    maxTokens,
    reasoningEffort,
    allowTools,
    includeReasoning,
    debug,
    sessionFile,
    sessionId,
    onPiSessionReady,
    webSearchEnabled,
  }: {
    messages: ChatMessage[];
    model: string;
    onError?: (error: string) => void;
    contextFiles?: Set<string>;
    systemPromptOverride?: string;
    signal?: AbortSignal;
    forcedToolName?: string;
    maxTokens?: number;
    reasoningEffort?: string;
    allowTools?: boolean;
    includeReasoning?: boolean;
    debug?: StreamDebugCallbacks;
    sessionFile?: string;
    sessionId?: string;
    onPiSessionReady?: (session: { sessionFile?: string; sessionId: string }) => void;
    webSearchEnabled?: boolean;
  }): AsyncGenerator<StreamEvent, void, unknown> {
    this.refreshSettings();

    try {
      errorLogger.debug("Starting streamMessage", {
        source: "SystemSculptService",
        method: "streamMessage",
        metadata: { model },
      });

      const prepared = await this.prepareChatRequest({
        messages,
        model,
        contextFiles,
        systemPromptOverride,
        emitNotices: true,
        allowTools,
      });

      const {
        resolvedModel,
      } = prepared;

      if (prepared.modelSource === "pi_local") {
        const preview = this.buildLocalPiRequestPreview({
          prepared,
          sessionFile,
          reasoningEffort,
        });

        try {
          debug?.onRequest?.({
            provider: String(resolvedModel.sourceProviderId || resolvedModel.provider || "unknown"),
            endpoint: "local-pi-sdk",
            headers: {},
            body: preview,
            transport: "pi-sdk",
            canStream: true,
            isCustomProvider: false,
          });
        } catch {}

        for await (const event of executeLocalPiStream({
          plugin: this.plugin,
          prepared,
          sessionFile,
          onSessionReady: onPiSessionReady,
          signal,
          reasoningEffort,
          debug,
        })) {
          yield event;
        }

        try {
          debug?.onStreamEnd?.({
            completed: !signal?.aborted,
            aborted: !!signal?.aborted,
          });
        } catch {}
        return;
      }

      const endpoint = `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CHAT.COMPLETIONS}`;
      const requestBody = this.buildHostedChatRequestBody({
        prepared,
        forcedToolName,
        maxTokens,
        reasoningEffort,
        webSearchEnabled,
      });
      const transport = PlatformContext.get().preferredTransport({ endpoint });

      debug?.onRequest?.({
        provider: String(resolvedModel.provider || "systemsculpt"),
        endpoint,
        headers: SystemSculptEnvironment.buildHeaders((this.settings.licenseKey || "").trim()),
        body: requestBody,
        transport,
        canStream: true,
        isCustomProvider: false,
      });

      const response = await this.platformRequestClient.request({
        url: endpoint,
        method: "POST",
        body: requestBody,
        stream: true,
        signal,
        licenseKey: (this.settings.licenseKey || "").trim(),
      });

      debug?.onResponse?.({
        provider: String(resolvedModel.provider || "systemsculpt"),
        endpoint,
        status: response.status,
        headers: serializeResponseHeaders(response.headers),
        isCustomProvider: false,
      });

      if (!response.ok) {
        await StreamingErrorHandler.handleStreamError(response, false, {
          provider: String(resolvedModel.provider || "systemsculpt"),
          endpoint,
          model: prepared.actualModelId,
        });
      }

      let diagnostics: any;
      for await (
        const event of this.streamingService.streamResponse(response, {
          model: prepared.actualModelId,
          isCustomProvider: false,
          signal,
          onRawEvent: debug?.onRawEvent,
          onDiagnostics: (value) => {
            diagnostics = value;
          },
        })
      ) {
        try {
          debug?.onStreamEvent?.({ event });
        } catch {}
        yield event;
      }

      try {
        debug?.onStreamEnd?.({
          completed: !signal?.aborted,
          aborted: !!signal?.aborted,
          diagnostics,
        });
      } catch {}
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      try {
        errorLogger.error("Stream error in streamMessage", error, {
          source: "SystemSculptService",
          method: "streamMessage",
          metadata: { model },
        });
      } catch {}
      try {
        debug?.onError?.({
          error: error instanceof Error ? error.message : String(error),
          details: error,
        });
      } catch {}
      if (onError) {
        let errorMessage = error instanceof Error ? error.message : "An unknown error occurred";

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
  }: {
    messages: ChatMessage[];
    model: string;
    contextFiles?: Set<string>;
  }): Promise<{ requestBody: Record<string, any>; preparedMessages: ChatMessage[]; actualModelId: string }> {
    const prepared = await this.prepareChatRequest({
      messages,
      model,
      contextFiles,
      emitNotices: false,
    });
    const requestBody = prepared.modelSource === "pi_local"
      ? this.buildLocalPiRequestPreview({ prepared })
      : this.buildHostedChatRequestBody({ prepared });

    return {
      requestBody,
      preparedMessages: prepared.preparedMessages,
      actualModelId: prepared.actualModelId,
    };
  }

  public async executeHostedToolCall(options: {
    toolCall: ToolCall | ToolCallRequest;
    chatView?: any;
    timeoutMs?: number;
  }): Promise<ToolCallResult> {
    const request = ((options.toolCall as ToolCall)?.request || options.toolCall || {}) as ToolCallRequest;
    const functionName = String(request?.function?.name || "").trim();
    if (!functionName) {
      return {
        success: false,
        error: {
          code: "INVALID_TOOL_CALL",
          message: "Tool call is missing a function name.",
        },
      };
    }

    const rawArguments = request?.function?.arguments;
    let parsedArgs: any = {};
    if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(rawArguments);
      } catch (error) {
        return {
          success: false,
          error: {
            code: "INVALID_TOOL_ARGUMENTS",
            message: `Tool call arguments for ${functionName} were not valid JSON.`,
            details: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    try {
      const data = await this.mcpService.executeTool(functionName, parsedArgs, options.chatView, {
        timeoutMs: options.timeoutMs,
      });
      return {
        success: true,
        data,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : `Tool execution failed for ${functionName}.`,
          details: error,
        },
      };
    }
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
      return { status: "error", message: "Failed to connect to SystemSculpt API. Please check your network connection."};
    }
  }
}
