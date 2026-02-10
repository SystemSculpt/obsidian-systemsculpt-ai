import { ChatMessage } from "../../../types";
import { 
  BaseProviderAdapter, 
  ProviderModel, 
  ProviderCapabilities,
  StreamTransformResult 
} from "./BaseProviderAdapter";
import { 
  ANTHROPIC_MODELS, 
  ANTHROPIC_API_VERSION,
  ANTHROPIC_STREAM_EVENTS,
  correctAnthropicEndpoint,
  resolveAnthropicModelId 
} from "../../../constants/anthropic";
import type SystemSculptPlugin from "../../../main";
import { errorLogger } from "../../../utils/errorLogger";
import { normalizeOpenAITools, normalizeJsonSchema } from "../../../utils/tooling";

/**
 * Adapter for Anthropic's Claude API
 * 
 * Handles the differences between Anthropic and OpenAI API formats:
 * - System prompts as separate field (not in messages array)
 * - Tool use format differences (tool_use blocks vs function calls)
 * - Different error response format
 * - Required API version header
 * - Automatic endpoint correction for malformed api.anthropic.com endpoints
 * 
 * IMPORTANT: Streaming Limitations in Obsidian
 * --------------------------------------------
 * Due to Anthropic's CORS policy and Obsidian's HTTP method limitations:
 * - Anthropic blocks browser fetch() requests (CORS)
 * - Obsidian's requestUrl() doesn't support streaming
 * - Therefore, responses appear all at once, not incrementally
 * 
 * This is NOT a bug in our implementation. It's a fundamental limitation
 * that affects ALL Obsidian plugins using Anthropic's API.
 * 
 * For true streaming, you would need:
 * 1. A proxy server that adds CORS headers, or
 * 2. Use a different provider (OpenAI, OpenRouter, etc.)
 */
export class AnthropicAdapter extends BaseProviderAdapter {
  private plugin?: SystemSculptPlugin;

  constructor(provider: any, plugin?: SystemSculptPlugin) {
    super(provider);
    this.plugin = plugin;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsModelsEndpoint: false, // Anthropic doesn't have a models endpoint
      supportsStreaming: true,
      supportsTools: true,
      requiresApiVersion: ANTHROPIC_API_VERSION,
    };
  }

  async getModels(): Promise<ProviderModel[]> {
    // Anthropic doesn't have a models endpoint, return hardcoded list
    return ANTHROPIC_MODELS.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      capabilities: model.capabilities,
      supportsStreaming: model.supportsStreaming,
      supportsTools: model.supportsTools,
      aliases: model.aliases,
    }));
  }

  async validateApiKey(): Promise<void> {
    const headers = this.getHeaders();
    
    try {
      await this.makeRequest(this.getChatEndpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-3-haiku-20240307", // Use the smallest model
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
      });
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.provider.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
  }

  transformMessages(messages: ChatMessage[]): { 
    messages: any[]; 
    systemPrompt?: string;
  } {
    let systemPrompt = "";
    const anthropicMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt = typeof msg.content === 'string' ? msg.content : "";
      } else if (msg.role === "tool") {
        // Convert tool messages to Anthropic's tool_result format
        // Ensure tool messages always have non-empty content
        let toolContent: string;
        
        // Handle different content types
        if (typeof msg.content === 'string') {
          toolContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Convert MultiPartContent array to string
          toolContent = JSON.stringify(msg.content);
        } else {
          toolContent = '';
        }
        
        if (!toolContent || toolContent.trim() === '') {
          // Provide a meaningful default for empty tool responses
          toolContent = JSON.stringify({ 
            result: "Tool executed successfully but returned no content",
            status: "completed" 
          });
        }
        
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: toolContent,
              ...(function () {
                try {
                  const parsed = JSON.parse(toolContent);
                  if (parsed && typeof parsed === 'object' && (parsed.error || parsed.is_error)) {
                    return { is_error: true } as any;
                  }
                } catch {}
                return {} as any;
              })(),
            }
          ]
        });
      } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        // Convert assistant tool calls to Anthropic format
        const toolUseBlocks = msg.tool_calls.map((toolCall: any) => {
          const toolName = toolCall.function?.name || toolCall.name || "tool";
          const rawArgs = toolCall.function?.arguments;
          let input: any = {};

          if (rawArgs == null) {
            input = {};
          } else if (typeof rawArgs === "string") {
            input = JSON.parse(rawArgs);
          } else if (typeof rawArgs === "object") {
            input = rawArgs;
          } else {
            throw new Error(`AnthropicAdapter: invalid arguments type for tool call ${toolName}`);
          }

          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new Error(`AnthropicAdapter: tool call ${toolName} args must be a JSON object`);
          }
          return {
            type: "tool_use",
            id: toolCall.id,
            name: toolName,
            input,
          };
        });
        
        const content: any[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        content.push(...toolUseBlocks);
        
        anthropicMessages.push({
          role: "assistant",
          content,
        });
      } else {
        // Regular user/assistant messages including vision inputs
        // Map our internal MultiPartContent[] (text, image_url) to Anthropic content blocks
        const mappedContentBlocks: any[] = [];

        if (Array.isArray(msg.content)) {
          for (const part of msg.content as any[]) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              if (part.text.length > 0) {
                mappedContentBlocks.push({ type: 'text', text: part.text });
              }
            } else if (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
              const url: string = part.image_url.url;
              // Support both base64 data URLs and remote URLs
              if (url.startsWith('data:')) {
                // data:[<mediatype>][;base64],<data>
                // Extract media type and base64 payload
                const match = url.match(/^data:([^;]+);base64,(.*)$/);
                if (match) {
                  const mediaType = match[1];
                  const data = match[2];
                  if (data && mediaType) {
                    mappedContentBlocks.push({
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: mediaType,
                        data
                      }
                    });
                  }
                }
              } else {
                // Regular URL
                mappedContentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'url',
                    url
                  }
                });
              }
            }
          }
        } else if (typeof msg.content === 'string') {
          if (msg.content.length > 0) {
            mappedContentBlocks.push({ type: 'text', text: msg.content });
          }
        }

        // If nothing mapped, send empty string to maintain API contract
        const finalContent = mappedContentBlocks.length > 0 ? mappedContentBlocks : "";

        anthropicMessages.push({
          role: msg.role,
          content: finalContent,
        });
      }
    }

    return { messages: anthropicMessages, systemPrompt };
  }

  buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    mcpTools?: any[],
    streaming: boolean = true,
    _extras?: {
      maxTokens?: number;
      includeReasoning?: boolean;
    }
  ): Record<string, any> {
    const { messages: anthropicMessages, systemPrompt } = this.transformMessages(messages);
    try {
      if (systemPrompt) {
        const preview = systemPrompt.slice(0, 600);
        errorLogger.debug('Anthropic adapter: system prompt preview', {
          source: 'AnthropicAdapter',
          method: 'buildRequestBody',
          metadata: { modelId, preview, length: systemPrompt.length }
        });
      }
    } catch {}
    
    // Resolve any model aliases to canonical IDs
    const resolvedModelId = resolveAnthropicModelId(modelId);
    
    const requestBody: Record<string, any> = {
      model: resolvedModelId,
      messages: anthropicMessages,
      stream: streaming,
      max_tokens: Math.max(1, Math.floor(Number.isFinite(_extras?.maxTokens) ? (_extras?.maxTokens as number) : 4096)), // Anthropic requires this field
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    if (mcpTools && mcpTools.length > 0) {
      const tools = this.buildAnthropicToolList(mcpTools);
      if (tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = { type: "auto" } as any;
      }
    }

    return requestBody;
  }

  private buildAnthropicToolList(mcpTools: any[]): Array<{ name: string; description?: string; input_schema: Record<string, any> }> {
    const validTools = normalizeOpenAITools(mcpTools);
    if (validTools.length === 0) return [];
    const seenNames = new Set<string>();
    const tools: Array<{ name: string; description?: string; input_schema: Record<string, any> }> = [];
    for (const tool of validTools) {
      const name: string = tool.function.name;
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      const parameters = tool.function.parameters && typeof tool.function.parameters === 'object' ? tool.function.parameters : {};
      const inputSchema: Record<string, any> = normalizeJsonSchema(parameters);
      tools.push({
        name,
        description: tool.function.description || "",
        input_schema: inputSchema,
      });
    }
    return tools;
  }

  getChatEndpoint(): string {
    // Apply automatic endpoint correction for Anthropic endpoints
    const { correctedEndpoint, wasCorrected, originalEndpoint } = correctAnthropicEndpoint(this.provider.endpoint);
    
    if (wasCorrected) {
      
      // Show user-friendly notification about the correction
      this.showEndpointCorrectionNotice(originalEndpoint, correctedEndpoint);
      
      // Permanently update the user's settings with the corrected endpoint
      this.updateProviderEndpointInSettings(correctedEndpoint);
    }
    
    // Handle endpoint properly - remove trailing /v1 if present
    const baseEndpoint = correctedEndpoint
      .trim()
      .replace(/\/$/, "")
      .replace(/\/v1\/?$/, "");
    
    return `${baseEndpoint}/v1/messages`;
  }

  /**
   * Permanently update the provider's endpoint in user settings
   */
  private async updateProviderEndpointInSettings(correctedEndpoint: string): Promise<void> {
    if (!this.plugin) {
      return;
    }

    try {
      const settings = this.plugin.getSettingsManager().getSettings();
      const providerIndex = settings.customProviders.findIndex(p => p.id === this.provider.id);
      
      if (providerIndex !== -1) {
        // Update the specific provider's endpoint
        const updatedProviders = [...settings.customProviders];
        updatedProviders[providerIndex] = {
          ...updatedProviders[providerIndex],
          endpoint: correctedEndpoint
        };
        
        await this.plugin.getSettingsManager().updateSettings({
          customProviders: updatedProviders
        });
        
      } else {
      }
    } catch (error) {
      errorLogger.debug('Failed to update provider endpoint in settings', {
        source: 'AnthropicAdapter',
        method: 'updateProviderEndpointInSettings',
        metadata: { providerId: this.provider.id, correctedEndpoint }
      });
    }
  }

  /**
   * Show a user-friendly notification when an endpoint is auto-corrected
   */
  private async showEndpointCorrectionNotice(originalEndpoint: string, correctedEndpoint: string): Promise<void> {
    try {
      const { showNoticeWhenReady } = await import("../../../core/ui/notifications");
      const message = `✅ Auto-corrected Anthropic endpoint and updated your settings:\n\n"${originalEndpoint}" → "${correctedEndpoint}"\n\nYour connection should now work properly!`;
      
      // Use dynamic import to ensure the app is available
      if (this.plugin?.app) {
        showNoticeWhenReady(
          this.plugin.app,
          message,
          { type: "info", duration: 8000 }
        );
      } else {
        errorLogger.debug('Plugin app not available for notification', {
          source: 'AnthropicAdapter',
          method: 'showEndpointCorrectionNotice'
        });
      }
    } catch (error) {
      // Fallback to console log if notification system is not available
      errorLogger.debug('Failed to show endpoint correction notice', {
        source: 'AnthropicAdapter',
        method: 'showEndpointCorrectionNotice',
        metadata: { originalEndpoint, correctedEndpoint }
      });
    }
  }

  /**
   * Transform Anthropic's response to OpenAI format
   * 
   * Note: Due to Obsidian's HTTP method limitations, streaming is not available.
   * We always get a complete JSON response when using requestUrl.
   * 
   * @param response - The response from Anthropic API
   * @param isMobile - Whether running on mobile (ignored for Anthropic)
   */
  async transformStreamResponse(
    response: Response,
    isMobile: boolean
  ): Promise<StreamTransformResult> {
    // Detect whether we received SSE, OpenAI-style SSE, or plain JSON
    const contentType = response.headers.get('content-type') || '';
    const providerFormat = response.headers.get('x-provider-format') || '';

    // If upstream already provided OpenAI-compatible SSE, just pass it through
    if (providerFormat === 'openai-sse' && response.body) {
      return {
        stream: response.body,
        headers: { 'Content-Type': 'text/event-stream', 'X-Provider-Format': 'openai-sse' },
      };
    }

    // Anthropic SSE formats (event:/data:) require transformation
    const isAnthropicSSE = contentType.includes('text/event-stream') ||
                           providerFormat === 'anthropic-sse' ||
                           contentType.includes('text/plain');
    if (isAnthropicSSE && response.body) {
      return {
        stream: this.createTransformedStream(response.body),
        headers: { 'Content-Type': 'text/event-stream', 'X-Provider-Format': 'anthropic-sse-transformed' },
      };
    }

    // If we have JSON (from requestUrl), transform it into OpenAI-style SSE
    if (contentType.includes('application/json') || providerFormat === 'anthropic-json') {
      return await this.transformNonStreamingResponse(response);
    }

    // Fallbacks
    try {
      return await this.transformNonStreamingResponse(response);
    } catch (_) {
      if (response.body) {
        return { stream: this.createTransformedStream(response.body), headers: { 'Content-Type': 'text/event-stream' } };
      }
      const empty = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return { stream: empty, headers: { 'Content-Type': 'text/event-stream' } };
    }
  }

  /**
   * Transform non-streaming JSON response to SSE format for consistent handling
   */
  private async transformNonStreamingResponse(response: Response): Promise<StreamTransformResult> {
    const responseData = await response.json();
    
    // Convert JSON response to SSE format for consistent handling downstream
    const stream = new ReadableStream({
      start(controller) {
        const messageId = responseData.id || `chatcmpl-${Date.now()}`;
        const model = responseData.model || "anthropic-model";
        const created = Math.floor(Date.now() / 1000);
        
        if (responseData.content && responseData.content.length > 0) {
          // Process each content block
          for (const block of responseData.content) {
            if (block.type === "text") {
              // Send text content
              const textChunk = {
                id: messageId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { content: block.text },
                  finish_reason: null,
                }],
              };
              
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(textChunk)}\n\n`)
              );
            } else if (block.type === "tool_use") {
              // Send tool use as function call
              const toolChunk = {
                id: messageId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: block.id,
                      type: "function",
                      function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input || {}),
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(toolChunk)}\n\n`)
              );
            }
          }
          
          // Determine finish reason
          let finishReason = "stop";
          if (responseData.stop_reason === "tool_use") {
            finishReason = "tool_calls";
          } else if (responseData.stop_reason === "max_tokens") {
            finishReason = "length";
          }
          
          // Send final chunk
          const doneChunk = {
            id: messageId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: finishReason,
            }],
          };
          
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(doneChunk)}\n\n`)
          );
        }
        
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      stream: stream,
      headers: {
        "Content-Type": "text/event-stream",
      },
    };
  }

  /**
   * This method is kept for potential future use when Obsidian supports streaming.
   * Currently not used as requestUrl doesn't support streaming.
   */
  private createTransformedStream(originalBody: ReadableStream): ReadableStream {
    return new ReadableStream({
      async start(controller) {
        const reader = originalBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let messageId = "";
        let modelName = "";
        let currentToolCallId = "";
        let currentToolName = "";
        let accumulatedToolInput = "";
        let isInToolUse = false;
        let isInThinking = false;
        let accumulatedThinkingText = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.trim() === '') continue;
              
              // Handle Anthropic SSE format: event: <type>\ndata: <json>
              // Also handle OpenAI format: data: <json>
              if (line.startsWith('event: ')) {
                // Event type line - we'll process with the next data line
                continue;
              } else if (line.startsWith('data: ')) {
                const data = line.substring(6).trim();
                if (!data || data === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(data);
                  
                  // Check if this is already OpenAI format (from a previous transformation)
                  if (parsed.choices && parsed.choices[0]?.delta) {
                    // Already in OpenAI format, pass through as-is
                    controller.enqueue(
                      new TextEncoder().encode(`${line}\n\n`)
                    );
                    continue;
                  }
                  
                  switch (parsed.type) {
                    case ANTHROPIC_STREAM_EVENTS.MESSAGE_START:
                      messageId = parsed.message?.id || `chatcmpl-${Date.now()}`;
                      modelName = parsed.message?.model || "anthropic-model";
                      break;
                      
                    case ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_START:
                      // Check if this is a tool use block
                      if (parsed.content_block?.type === 'tool_use') {
                        isInToolUse = true;
                        currentToolCallId = parsed.content_block.id;
                        currentToolName = parsed.content_block.name;
                        accumulatedToolInput = "";
                        
                        // Send tool call start in OpenAI format
                        const toolStartChunk = {
                          id: messageId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: modelName,
                          choices: [{
                            index: 0,
                            delta: {
                              tool_calls: [{
                                index: 0,
                                id: currentToolCallId,
                                type: "function",
                                function: {
                                  name: currentToolName,
                                  arguments: "",
                                },
                              }],
                            },
                            finish_reason: null,
                          }],
                        };
                        
                        controller.enqueue(
                          new TextEncoder().encode(`data: ${JSON.stringify(toolStartChunk)}\n\n`)
                        );
                      } else if (parsed.content_block?.type === 'thinking') {
                        // Handle thinking blocks if needed (extended thinking)
                        isInThinking = true;
                        accumulatedThinkingText = "";
                      }
                      break;
                      
                    case ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_DELTA:
                      if (isInToolUse && parsed.delta?.type === 'input_json_delta') {
                        // Accumulate tool input
                        accumulatedToolInput += parsed.delta.partial_json || "";
                        
                        // Send tool arguments delta
                        const toolDeltaChunk = {
                          id: messageId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: modelName,
                          choices: [{
                            index: 0,
                            delta: {
                              tool_calls: [{
                                index: 0,
                                function: {
                                  arguments: parsed.delta.partial_json || "",
                                },
                              }],
                            },
                            finish_reason: null,
                          }],
                        };
                        
                        controller.enqueue(
                          new TextEncoder().encode(`data: ${JSON.stringify(toolDeltaChunk)}\n\n`)
                        );
                      } else if (isInThinking && parsed.delta?.type === 'thinking_delta') {
                        // Forward thinking deltas as reasoning deltas to align with content streaming
                        const reasoningDelta = parsed.delta.text || "";
                        if (reasoningDelta && reasoningDelta.length > 0) {
                          const reasoningChunk = {
                            id: messageId,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: modelName,
                            choices: [{
                              index: 0,
                              delta: {
                                reasoning: reasoningDelta,
                              },
                              finish_reason: null,
                            }],
                          };
                          controller.enqueue(
                            new TextEncoder().encode(`data: ${JSON.stringify(reasoningChunk)}\n\n`)
                          );
                        }
                      } else if (parsed.delta?.type === 'text_delta') {
                        // Regular text content
                        const chunk = {
                          id: messageId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: modelName,
                          choices: [{
                            index: 0,
                            delta: {
                              content: parsed.delta.text || "",
                            },
                            finish_reason: null,
                          }],
                        };
                        
                        controller.enqueue(
                          new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                        );
                      }
                      break;
                      
                    case ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_STOP:
                      if (isInToolUse) {
                        isInToolUse = false;
                        currentToolCallId = "";
                        currentToolName = "";
                        accumulatedToolInput = "";
                      } else if (isInThinking) {
                        isInThinking = false;
                        // Optionally handle accumulated thinking text
                        accumulatedThinkingText = "";
                      }
                      break;
                      
                    case ANTHROPIC_STREAM_EVENTS.MESSAGE_DELTA:
                      // Handle usage updates if needed
                      break;
                      
                    case ANTHROPIC_STREAM_EVENTS.MESSAGE_STOP:
                      // Determine finish reason
                      let finishReason = "stop";
                      if (parsed.message?.stop_reason === "tool_use") {
                        finishReason = "tool_calls";
                      } else if (parsed.message?.stop_reason === "max_tokens") {
                        finishReason = "length";
                      }
                      
                      // Send final chunk
                      const finalChunk = {
                        id: messageId,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: modelName,
                        choices: [{
                          index: 0,
                          delta: {},
                          finish_reason: finishReason,
                        }],
                      };
                      
                      controller.enqueue(
                        new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
                      );
                      break;
                      
                    case 'error':
                      // Handle error events
                      const errorChunk = {
                        error: {
                          message: parsed.error?.message || "Stream error",
                          type: parsed.error?.type || "stream_error",
                        },
                      };
                      controller.enqueue(
                        new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`)
                      );
                      break;
                      
                    case 'ping':
                      // Heartbeat event - ignore
                      break;
                      
                    default:
                  }
                } catch (error) {
                  // Log parsing errors for debugging
                  errorLogger.debug(`Failed to parse Anthropic SSE data: ${data}`, {
                    source: 'AnthropicAdapter',
                    method: 'createTransformedStream',
                    metadata: { line, error: error instanceof Error ? error.message : String(error) }
                  });
                }
              } else if (line.trim() !== '') {
                // Handle non-SSE lines (shouldn't happen but log for debugging)
                errorLogger.debug(`Unexpected line format in SSE stream: ${line}`, {
                  source: 'AnthropicAdapter',
                  method: 'createTransformedStream'
                });
              }
            }
          }

          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        } catch (error) {
          errorLogger.error('Error in Anthropic stream transformation', error, {
            source: 'AnthropicAdapter',
            method: 'createTransformedStream',
            metadata: { messageId, modelName }
          });
          controller.error(error);
        } finally {
          controller.close();
        }
      },
    });
  }

  handleError(error: any): Error {
    let errorMessage: string;
    let errorContext = {
      source: 'AnthropicAdapter',
      method: 'handleError',
      metadata: {
        status: error.status,
        endpoint: this.provider.endpoint,
        errorData: error.data,
      }
    };

    // Handle response errors
    if (error.status) {
      switch (error.status) {
        case 401:
          errorMessage = "⚠️ Invalid Anthropic API key. Please check your API key in Settings > Custom Endpoints.";
          errorLogger.error(`Authentication failed: ${error.status}`, error, errorContext);
          return new Error(errorMessage);
          
        case 400:
          if (error.data?.error?.message?.includes("credit")) {
            errorMessage = "💳 Insufficient credits. Please add credits to your Anthropic account.";
          } else {
            errorMessage = `Invalid request: ${error.data?.error?.message || 'Please check your input and try again.'}`;
          }
          errorLogger.error(`Bad request: ${errorMessage}`, error, errorContext);
          return new Error(errorMessage);
          
        case 429:
          errorMessage = "⏱️ Rate limit exceeded. Please wait a moment and try again.";
          errorLogger.warn(errorMessage, errorContext);
          return new Error(errorMessage);
          
        case 404:
          errorMessage = "❌ Model not found. Please check that the model ID is correct.";
          errorLogger.error(`Model not found: ${error.data?.error?.message || 'Unknown model'}`, error, errorContext);
          return new Error(errorMessage);
          
        case 500:
        case 502:
        case 503:
          errorMessage = "🔧 Anthropic API is temporarily unavailable. Please try again later.";
          errorLogger.error(`Server error ${error.status}: ${error.data?.error?.message || 'Service unavailable'}`, error, errorContext);
          return new Error(errorMessage);
          
        default:
          errorMessage = error.data?.error?.message || `Anthropic API error: ${error.status}`;
          errorLogger.error(`Unexpected API error: ${errorMessage}`, error, errorContext);
          return new Error(errorMessage);
      }
    }
    
    // Handle network errors
    if (error.message?.includes('Failed to fetch')) {
      errorMessage = "🌐 Network error: Unable to connect to Anthropic. Please check your internet connection.";
      errorLogger.error('Network connection failed', error, errorContext);
      return new Error(errorMessage);
    }
    
    // Default error
    errorMessage = error.data?.error?.message || error.message || `Anthropic API error: ${error.status || 'unknown'}`;
    errorLogger.error(`Unhandled error: ${errorMessage}`, error, errorContext);
    return new Error(errorMessage);
  }

  private validateTools(mcpTools: any[]): any[] {
    return mcpTools.filter(tool => {
      if (!tool || typeof tool !== 'object') return false;
      if (!tool.function || typeof tool.function !== 'object') return false;
      if (!tool.function.name || typeof tool.function.name !== 'string') return false;
      return true;
    });
  }
}
