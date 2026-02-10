import { App, TFile, requestUrl } from "obsidian";
import {
  ChatMessage,
  SystemSculptModel,
  SystemSculptSettings,
  CustomProvider,
  ApiStatusResponse,
} from "../types";
import {
  SystemSculptError,
  ERROR_CODES,
} from "../utils/errors";
// License checks removed for Agent Mode access
import { CustomProviderService } from "./CustomProviderService";
import { MCPService } from "../views/chatview/MCPService";
import SystemSculptPlugin from "../main";
import { DebugLogger } from "../utils/debugLogger";
import { getImageCompatibilityInfo, getToolCompatibilityInfo } from "../utils/modelUtils";
import { mapAssistantToolCallsForApi, normalizeJsonSchema, normalizeOpenAITools } from "../utils/tooling";
import { deterministicId } from "../utils/id";
import { Notice } from "obsidian";
import { PlatformContext } from "./PlatformContext";
import { SystemSculptEnvironment } from "./api/SystemSculptEnvironment";
import { MOBILE_STREAM_CONFIG, WEB_SEARCH_CONFIG } from "../constants/webSearch";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";

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

interface PreparedChatRequest {
  isCustom: boolean;
  provider?: CustomProvider;
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
  private customProviderService: CustomProviderService;
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
    plugins?: Array<{ id: string; max_results?: number; search_prompt?: string }>;
    web_search_options?: { search_context_size?: "low" | "medium" | "high" };
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
      plugins,
      web_search_options,
      emitNotices = false,
    } = options;

    const { isCustom, provider, actualModelId } = await this.modelManagementService.getModelInfo(model);
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

    const hasWebPlugin = Array.isArray(plugins) && plugins.some((plugin) => plugin && plugin.id === WEB_SEARCH_CONFIG.PLUGIN_ID);
    const resolvedWebSearchOptions = web_search_options ?? (hasWebPlugin ? { search_context_size: WEB_SEARCH_CONFIG.DEFAULT_CONTEXT_SIZE } : undefined);

    return {
      isCustom,
      provider,
      actualModelId,
      serverModelId,
      preparedMessages,
      requestTools,
      effectiveAgentMode,
      resolvedWebSearchOptions,
      finalSystemPrompt,
    };
  }

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = plugin.settings;
    
    // Defensive check to ensure CustomProviderService is properly initialized
    if (!plugin.customProviderService) {
      throw new Error("SystemSculptService requires CustomProviderService to be initialized first. This is likely a plugin initialization order issue.");
    }
    this.customProviderService = plugin.customProviderService;
    this.mcpService = new MCPService(plugin, plugin.app);
    
    // Ensure baseUrl is never empty - use development mode aware default if needed
    this.baseUrl = this.getValidServerUrl();

    // Initialize specialized services
    this.streamingService = new StreamingService();
    this.licenseService = new LicenseService(plugin, this.baseUrl);
    this.modelManagementService = new ModelManagementService(plugin, this.baseUrl);
    this.contextFileService = new ContextFileService(plugin.app);
    this.documentUploadService = new DocumentUploadService(plugin.app, this.baseUrl, this.settings.licenseKey);
    this.audioUploadService = new AudioUploadService(plugin.app, this.baseUrl);
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
      if (ext && ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
        count++;
        continue;
      }

      const resolved =
        this.plugin.app.metadataCache.getFirstLinkpathDest(cleanPath, "") ??
        this.plugin.app.vault.getAbstractFileByPath(cleanPath);
      if (
        resolved instanceof TFile &&
        ["jpg", "jpeg", "png", "gif", "webp"].includes((resolved.extension || "").toLowerCase())
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
    this.documentUploadService.updateConfig(this.baseUrl, this.settings.licenseKey);
    this.audioUploadService.updateBaseUrl(this.baseUrl);
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

  /**
   * Handle custom provider completion requests using the adapter pattern
   */
  private async handleCustomProviderCompletion(
    provider: CustomProvider,
    messages: ChatMessage[],
    modelId: string,
    mcpTools: any[] = [],
    signal?: AbortSignal,
    plugins?: Array<{ id: string; max_results?: number; search_prompt?: string }>,
    web_search_options?: { search_context_size?: "low" | "medium" | "high" },
    forcedToolName?: string,
    maxTokens?: number,
    includeReasoning?: boolean,
    debug?: StreamDebugCallbacks
  ): Promise<Response> {
    try {
      const adapter = this.customProviderService.getProviderAdapter(provider);
      const platform = PlatformContext.get();
      const isMobile = platform.isMobile();
      const fullEndpoint = adapter.getChatEndpoint();
      const transportOptions = { endpoint: fullEndpoint };
      const canStream = platform.supportsStreaming(transportOptions);
      const preferredTransport = platform.preferredTransport(transportOptions);
      try {
        console.debug('[SystemSculpt][Transport] handleCustomProviderCompletion transport', {
          provider: provider.name || provider.id,
          endpoint: fullEndpoint,
          canStream,
          preferredTransport,
          isMobile,
        });
      } catch {}

      // Start with provider headers, then ensure JSON content-type for POST bodies
      const headers = { ...adapter.getHeaders() } as Record<string, string>;
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      if (canStream) {
        headers['Accept'] = headers['Accept'] || 'text/event-stream';
        headers['Cache-Control'] = headers['Cache-Control'] || 'no-cache';
      }

      // Build request body using adapter (extras handled inside adapter)
      const requestBody = adapter.buildRequestBody(
        messages,
        modelId,
        mcpTools,
        canStream,
        { plugins, web_search_options, maxTokens, includeReasoning }
      );

      try {
        debug?.onRequest?.({
          provider: provider.name || provider.id || "custom",
          endpoint: fullEndpoint,
          headers,
          body: requestBody,
          transport: preferredTransport,
          canStream,
          isCustomProvider: true,
        });
      } catch {}

      if (forcedToolName && Array.isArray((requestBody as any).tools) && (requestBody as any).tools.length > 0) {
        const firstTool = (requestBody as any).tools[0];
        const isAnthropicToolList = firstTool && typeof firstTool === "object" && typeof firstTool.name === "string";
        (requestBody as any).tool_choice = isAnthropicToolList
          ? { type: "tool", name: forcedToolName }
          : { type: "function", function: { name: forcedToolName } };
      }

      if (forcedToolName && Array.isArray((requestBody as any).functions) && (requestBody as any).functions.length > 0) {
        (requestBody as any).function_call = { name: forcedToolName };
      }

      // Log the request
      const logger = DebugLogger.getInstance();
      logger?.logAPIRequest(fullEndpoint, 'POST', requestBody);
      
      // Prefer native fetch when the platform supports streaming; otherwise fall back
      // to the resilient transport wrapper (requestUrl + virtual SSE) for mobile and
      // environments where direct streaming fails.
      const hasTools = Array.isArray((requestBody as any).tools) && (requestBody as any).tools.length > 0;
      const hasFunctions = Array.isArray((requestBody as any).functions) && (requestBody as any).functions.length > 0;
      try {
        const toolMode = hasTools ? "tools" : hasFunctions ? "functions" : "none";
        const messageList: any[] = Array.isArray((requestBody as any).messages) ? (requestBody as any).messages : [];
        const messagesWithReasoningDetails = messageList.filter((m) => Array.isArray(m?.reasoning_details)).length;
        const reasoningDetailsItemCount = messageList.reduce((acc, m) => {
          if (!Array.isArray(m?.reasoning_details)) return acc;
          return acc + m.reasoning_details.length;
        }, 0);
        const assistantToolCallsMissingReasoningDetails = messageList.filter((m) => {
          const hasToolCalls = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
          if (!hasToolCalls) return false;
          return !Array.isArray(m?.reasoning_details);
        }).length;
        console.debug('[SystemSculpt][CustomProvider] request details', {
          endpoint: fullEndpoint,
          model: modelId,
          stream: requestBody.stream,
          hasTools,
          hasFunctions,
          toolMode,
          messageCount: (requestBody.messages as any[])?.length,
          messagesWithReasoningDetails,
          reasoningDetailsItemCount,
          assistantToolCallsMissingReasoningDetails,
          transport: preferredTransport
      });
      } catch {}
      let response: Response | null = null;
      const isOpenRouter = fullEndpoint.includes("openrouter.ai");

      const sendRequest = async (body: Record<string, any>): Promise<Response> => {
        if (preferredTransport === "fetch" && typeof fetch === "function") {
          try {
            const { sanitizeFetchHeadersForUrl } = await import("../utils/streaming");
            const fetchHeaders = sanitizeFetchHeadersForUrl(fullEndpoint, headers);
            const fetchOptions: RequestInit = {
              method: "POST",
              headers: fetchHeaders,
              body: JSON.stringify(body),
              signal,
              mode: "cors" as RequestMode,
              credentials: "omit" as RequestCredentials,
              cache: "no-store",
            };
            return await fetch(fullEndpoint, fetchOptions);
          } catch (e) {
            const isAbortError =
              (e instanceof DOMException && e.name === "AbortError") ||
              (e instanceof Error && e.name === "AbortError") ||
              (typeof (e as any)?.message === "string" &&
                String((e as any).message).toLowerCase().includes("abort"));
            if (signal?.aborted || isAbortError) {
              throw e;
            }
            try {
              console.debug("[SystemSculpt][Transport] fetch failed, falling back to requestUrl", {
                endpoint: fullEndpoint,
                error: (e as Error)?.message ?? String(e),
              });
            } catch {}
            const { postJsonStreaming } = await import("../utils/streaming");
            return await postJsonStreaming(fullEndpoint, headers, body, isMobile, signal);
          }
        }

        try {
          console.debug("[SystemSculpt][Transport] using resilient postJsonStreaming fallback", {
            endpoint: fullEndpoint,
            preferredTransport,
            canStream,
            isMobile,
          });
        } catch {}
        const { postJsonStreaming } = await import("../utils/streaming");
        return await postJsonStreaming(fullEndpoint, headers, body, isMobile, signal);
      };

      let lastRequestBody: Record<string, any> = requestBody;
      let openRouterFallback:
        | {
            order: string[];
            endpoints: Array<{ tag: string; provider_name?: string }>;
          }
        | null = null;
      let openRouterAvoidTag: string | undefined;

      const ensureOpenRouterFallback = async (): Promise<
        | {
            order: string[];
            endpoints: Array<{ tag: string; provider_name?: string }>;
          }
        | null
      > => {
        if (openRouterFallback) return openRouterFallback;
        const apiKey = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
        if (!apiKey) return null;

        const apiBase =
          typeof provider.endpoint === "string" && provider.endpoint.trim().length > 0
            ? provider.endpoint.trim()
            : fullEndpoint;

        const { getOpenRouterProviderOrderForModel } = await import("../utils/openrouterRouting");
        openRouterFallback = await getOpenRouterProviderOrderForModel({
          apiBase,
          apiKey,
          modelId,
          hasTools,
          signal,
        });
        return openRouterFallback;
      };

      const maxAttempts = isOpenRouter ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let bodyForAttempt: Record<string, any> = requestBody;

        if (isOpenRouter && attempt > 0) {
          const fallback = await ensureOpenRouterFallback();
          if (!fallback || fallback.order.length <= 1) {
            break;
          }

          let order = fallback.order;
          if (openRouterAvoidTag) {
            order = order.filter((t) => t !== openRouterAvoidTag);
          }

          const shift = attempt - 1;
          if (order.length <= shift) {
            break;
          }

          bodyForAttempt = {
            ...requestBody,
            provider: {
              ...(typeof (requestBody as any).provider === "object" && (requestBody as any).provider
                ? (requestBody as any).provider
                : {}),
              order: order.slice(shift),
              allow_fallbacks: true,
            },
          };
        }

        lastRequestBody = bodyForAttempt;

        // Capture retries in debug logs (max 2 extra attempts)
        try {
          if (attempt > 0) {
            debug?.onRequest?.({
              provider: provider.name || provider.id || "custom",
              endpoint: fullEndpoint,
              headers,
              body: bodyForAttempt,
              transport: preferredTransport,
              canStream,
              isCustomProvider: true,
            });
          }
        } catch {}

        response = await sendRequest(bodyForAttempt);
        if (response.ok) break;

        if (!isOpenRouter || attempt + 1 >= maxAttempts) {
          break;
        }

        const status = response.status;
        const statusText = response.statusText;
        const responseHeaders = new Headers(response.headers);
        const text = await response.text().catch(() => "");

        let data: unknown = undefined;
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }

        const { isRetryableOpenRouterProviderError, findOpenRouterEndpointTagForProviderName } =
          await import("../utils/openrouterRouting");

        const retryable = isRetryableOpenRouterProviderError(status, data);
        if (!retryable) {
          response = new Response(text, { status, statusText, headers: responseHeaders });
          break;
        }

        const providerName =
          typeof (data as any)?.error?.metadata?.provider_name === "string"
            ? (data as any).error.metadata.provider_name
            : undefined;

        const fallback = await ensureOpenRouterFallback();
        if (fallback && providerName) {
          openRouterAvoidTag = findOpenRouterEndpointTagForProviderName(
            fallback.endpoints as any,
            providerName
          );
        }

        // Rebuild response for potential final error handling if subsequent retries also fail
        response = new Response(text, { status, statusText, headers: responseHeaders });
      }

      if (!response) {
        throw new SystemSculptError(
          "No response returned from the provider transport",
          ERROR_CODES.STREAM_ERROR,
          0
        );
      }

      if (!response.ok) {
        // OpenRouter + Gemini tool calling can fail if `reasoning_details` and tool call IDs
        // are not preserved exactly between the tool call turn and the follow-up. When this
        // happens, upstream often returns "Corrupted thought signature" / missing signature
        // errors. Log a sanitized request summary (no prompt contents) to aid debugging.
        try {
          const endpoint = String(fullEndpoint || "");
          const modelLower = String(modelId || "").toLowerCase();
          const isOpenRouter = endpoint.includes("openrouter.ai");
          const isGemini = modelLower.includes("gemini");
          if (isOpenRouter && isGemini) {
            const messageList: any[] = Array.isArray((lastRequestBody as any)?.messages)
              ? ((lastRequestBody as any).messages as any[])
              : [];
            const roleSequence = messageList.map((m) => String(m?.role || "unknown"));

            const assistantToolCallSummaries = messageList
              .map((m, idx) => ({ m, idx }))
              .filter(({ m }) => String(m?.role) === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
              .map(({ m, idx }) => {
                const toolCallIds = (m.tool_calls as any[])
                  .map((tc) => tc?.id)
                  .filter((id) => typeof id === "string" && id.trim().length > 0);
                const reasoningIds = (Array.isArray(m?.reasoning_details) ? (m.reasoning_details as any[]) : [])
                  .map((d) => d?.id)
                  .filter((id) => typeof id === "string" && id.trim().length > 0);
                const missingReasoning = toolCallIds.length > 0 && reasoningIds.length === 0;
                const mismatch = toolCallIds.some((id) => !reasoningIds.includes(id)) || reasoningIds.some((id) => !toolCallIds.includes(id));
                return {
                  index: idx,
                  toolCallIds,
                  reasoningIds,
                  missingReasoning,
                  mismatch,
                };
              });

            const toolMessageSummaries = messageList
              .map((m, idx) => ({ m, idx }))
              .filter(({ m }) => String(m?.role) === "tool")
              .map(({ m, idx }) => ({
                index: idx,
                tool_call_id: typeof m?.tool_call_id === "string" ? m.tool_call_id : undefined,
                contentLength: typeof m?.content === "string" ? m.content.length : 0,
              }));

            const summary = {
              endpoint,
              model: modelId,
              stream: (lastRequestBody as any)?.stream,
              include_reasoning: (lastRequestBody as any)?.include_reasoning,
              toolCount: Array.isArray((lastRequestBody as any)?.tools)
                ? (lastRequestBody as any).tools.length
                : 0,
              messageCount: messageList.length,
              roleSequence,
              assistantToolCallSummaries,
              toolMessageSummaries,
              contentLengths: messageList.map((m) => (typeof m?.content === "string" ? m.content.length : 0)),
            };
            console.error(
              "[SystemSculpt][OpenRouter][Gemini] request summary for error",
              JSON.stringify(summary, null, 2)
            );
          }
        } catch {}

        await StreamingErrorHandler.handleStreamError(response, true, {
          provider: provider.name || provider.id,
          endpoint: fullEndpoint,
          model: modelId
        });
      }

      try {
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        debug?.onResponse?.({
          provider: provider.name || provider.id || "custom",
          endpoint: fullEndpoint,
          status: response.status,
          headers: responseHeaders,
          isCustomProvider: true,
        });
      } catch {}

      // Transform the response stream if needed (e.g., for Anthropic)
      const { stream, headers: transformHeaders } = await adapter.transformStreamResponse(response, isMobile);
      
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: transformHeaders || response.headers
      });
    } catch (error) {
      throw error;
    }
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
    plugins,
    web_search_options,
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
    plugins?: Array<{ id: string; max_results?: number; search_prompt?: string }>;
    web_search_options?: { search_context_size?: "low" | "medium" | "high" };
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
        plugins,
        web_search_options,
        emitNotices: true,
      });

      const {
        isCustom,
        provider,
        actualModelId,
        serverModelId,
        preparedMessages,
        requestTools,
        effectiveAgentMode,
        resolvedWebSearchOptions,
        finalSystemPrompt,
      } = prepared;

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

      let messagesForRequest = preparedMessages;

      let response: Response | null = null;
      const apiMessages = this.toSystemSculptApiMessages(messagesForRequest);

      if (isCustom && provider) {
        response = await this.handleCustomProviderCompletion(
          provider,
          messagesForRequest,
          actualModelId,
          requestTools,
          signal,
          plugins,
          resolvedWebSearchOptions,
          forcedToolName,
          maxTokens,
          includeReasoning,
          debug
        );
      } else {
        const endpoint = `${this.getAgentV2BaseUrl()}${SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSIONS}`;
        const piTools = normalizePiTools(requestTools);
        const requestBody = {
          modelId: serverModelId,
          messages: apiMessages,
          tools: piTools,
          stream: true,
        }

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

        response = await this.agentSessionClient.startOrContinueTurn({
          chatId: chatSessionId,
          modelId: serverModelId,
          messages: apiMessages,
          tools: piTools,
          pluginVersion: (this.plugin as any)?.manifest?.version,
        });
      }

      if (!response) {
        throw new SystemSculptError(
          "No response returned from the streaming API transport",
          ERROR_CODES.STREAM_ERROR,
          0
        );
      }

      // Log API response status
      const logger = DebugLogger.getInstance();
      const endpoint = isCustom && provider 
        ? provider.endpoint 
        : `${this.getAgentV2BaseUrl()}${SYSTEMSCULPT_API_ENDPOINTS.AGENT.BASE}`;
      logger?.logAPIResponse(endpoint, response.status);

      if (!provider) {
        try {
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
          debug?.onResponse?.({
            provider: "systemsculpt",
            endpoint,
            status: response.status,
            headers: responseHeaders,
            isCustomProvider: false,
          });
        } catch {}
      }

      if (!response.ok) {
        logger?.logAPIResponse(endpoint, response.status, null, { message: `HTTP ${response.status}` });
        await StreamingErrorHandler.handleStreamError(response, !!provider, {
          provider: provider?.name || provider?.id,
          endpoint,
          model: actualModelId
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
            hasBody: !!response.body
          }
        });
      } catch {}

      let streamDiagnostics: StreamPipelineDiagnostics | null = null;
      const streamIterator = this.streamingService.streamResponse(response, {
        model: actualModelId,
        isCustomProvider: !!provider,
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
    plugins,
    web_search_options,
    sessionId,
  }: {
    messages: ChatMessage[];
    model: string;
    contextFiles?: Set<string>;
    systemPromptType?: string;
    systemPromptPath?: string;
    agentMode?: boolean;
    toolCallManager?: any;
    plugins?: Array<{ id: string; max_results?: number; search_prompt?: string }>;
    web_search_options?: { search_context_size?: "low" | "medium" | "high" };
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
      plugins,
      web_search_options,
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

    if (plugins && plugins.length > 0) {
      requestBody.plugins = plugins;
    }
    if (prepared.resolvedWebSearchOptions) {
      requestBody.web_search_options = prepared.resolvedWebSearchOptions;
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
