import { requestUrl, Platform } from 'obsidian';
import { errorLogger } from './errorLogger';
import { MOBILE_STREAM_CONFIG } from '../constants/webSearch';

export function sanitizeFetchHeadersForUrl(
  url: string,
  headers: Record<string, string>
): Record<string, string> {
  const sanitized: Record<string, string> = { ...headers };

  const deleteHeader = (name: string) => {
    const target = name.toLowerCase();
    for (const key of Object.keys(sanitized)) {
      if (key.toLowerCase() === target) {
        delete sanitized[key];
      }
    }
  };

  try {
    const host = new URL(url).host.toLowerCase();
    if (host.endsWith('openrouter.ai')) {
      // These custom headers can trigger problematic CORS preflights in some environments,
      // and are not required for OpenRouter requests to succeed.
      deleteHeader('HTTP-Referer');
      deleteHeader('X-Title');
      deleteHeader('Cache-Control');
    }
  } catch {}

  return sanitized;
}

export async function postJsonStreaming(
  url: string,
  headers: Record<string, string>,
  body: any,
  isMobile: boolean,
  signal?: AbortSignal
): Promise<Response> {
  const json = JSON.stringify(body);
  const isAbortError = (error: unknown): boolean => {
    if (!error) return false;
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    if (error instanceof Error && error.name === 'AbortError') return true;
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('abort');
  };
  try {
    errorLogger.debug('postJsonStreaming request', {
      source: 'streaming',
      method: 'postJsonStreaming',
      metadata: { url, isMobile }
    });
  } catch {}
  try {
    console.debug('[SystemSculpt][Streaming] postJsonStreaming called', {
      url,
      isMobile,
      hasFetch: typeof fetch === 'function'
    });
  } catch {}

  // Desktop: try fetch for true streaming when CORS allows
  if (!isMobile && typeof fetch === 'function' && !url.includes('anthropic.com')) {
    try {
      const fetchHeaders = sanitizeFetchHeadersForUrl(url, headers);
      const resp = await fetch(url, { method: 'POST', headers: fetchHeaders, body: json, signal } as RequestInit);
      try {
        console.debug('[SystemSculpt][Streaming] fetch used for streaming', {
          url,
          status: resp.status,
          contentType: resp.headers.get('content-type') || ''
        });
      } catch {}
      try {
        errorLogger.debug('postJsonStreaming fetch response', {
          source: 'streaming',
          method: 'postJsonStreaming',
          metadata: { status: resp.status, contentType: resp.headers.get('content-type') || '' }
        });
      } catch {}
      return resp;
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) {
        throw e;
      }
      try {
        console.debug('[SystemSculpt][Streaming] fetch attempt failed, falling back', {
          url,
          error: (e as Error)?.message ?? String(e)
        });
      } catch {}
      // fallthrough to requestUrl
    }
  }

  // Mobile or fallback: requestUrl (non-streaming), then wrap as SSE-like stream
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  try {
    console.debug('[SystemSculpt][Streaming] requestUrl request body', {
      url,
      model: body?.model,
      stream: body?.stream,
      hasTools: !!(body?.tools?.length),
      messageCount: body?.messages?.length
    });
  } catch {}
  const result = await requestUrl({ url, method: 'POST', headers, body: json, throw: false });
  try {
    console.debug('[SystemSculpt][Streaming] requestUrl fallback used', {
      url,
      status: result.status
    });
  } catch {}
  try {
    errorLogger.debug('postJsonStreaming requestUrl response', {
      source: 'streaming',
      method: 'postJsonStreaming',
      metadata: { status: result.status, hasText: !!result.text, hasJson: !!result.json }
    });
  } catch {}
  if (!result.status || result.status >= 400) {
    let errorData: any = {};
    try {
      errorData = result.json || {};
    } catch (e) {
      errorData = { error: result.text || 'Request failed' };
    }
    try {
      const errorMessage = errorData?.error?.message || errorData?.error || errorData?.message || 'Unknown error';
      console.error('[SystemSculpt][Streaming] API error response', {
        url,
        status: result.status,
        errorMessage,
        errorCode: errorData?.error?.code,
        fullError: errorData
      });
    } catch {}
    return new Response(JSON.stringify(errorData), {
      status: result.status || 500,
      statusText: 'Error',
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Check if we have text response first (SSE format from Anthropic)
  // Don't access result.json if we have SSE text, as it will try to parse and fail
  let responseData: unknown;
  if (result.text && typeof result.text === 'string' && result.text.includes('event:')) {
    // This is SSE format, use text directly
    responseData = result.text;
  } else {
    // Try to get JSON, fallback to text if not available
    try {
      responseData = result.json;
    } catch (e) {
      responseData = result.text;
    }
  }
  
  // Detect SSE strings. Some providers (OpenRouter) emit only `data:` lines without explicit `event:` fields.
  const isSSEString = typeof responseData === 'string' && (
    /(^|\n)event:\s*/.test(responseData as string) ||
    /(^|\n)data:\s*/.test(responseData as string)
  );
  const isAnthropicHost = url.includes('anthropic.com');

  // Case 1: Already SSE text (e.g., Anthropic proxied or buffered SSE)
  if (isSSEString) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseData as string));
        if (!(responseData as string).includes('[DONE]')) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'text/event-stream',
        'X-Provider-Format': isAnthropicHost ? 'anthropic-sse' : 'openai-sse'
      }
    });
  }

  // Case 2: JSON response (non-streaming). Let adapter transform it properly.
  if (responseData !== null && typeof responseData === 'object') {
    return new Response(JSON.stringify(responseData), {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json',
        'X-Provider-Format': isAnthropicHost ? 'anthropic-json' : 'openai-json'
      }
    });
  }

  // Case 3: Plain text fallback. Wrap as OpenAI-style SSE one-shot.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const sse = `data: ${JSON.stringify(String(responseData || ''))}\n\n`;
      controller.enqueue(encoder.encode(sse));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Provider-Format': 'openai-sse'
    }
  });
}

export function createSSEStreamFromChatCompletionJSON(
  responseData: any,
  options?: { chunkSize?: number; chunkDelayMs?: number }
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunkSize = options?.chunkSize ?? MOBILE_STREAM_CONFIG.CHUNK_SIZE;
  const delayMs = options?.chunkDelayMs ?? MOBILE_STREAM_CONFIG.CHUNK_DELAY_MS;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueueSSE = (data: any) => {
        const sseData = typeof data === 'string' ? data : `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(enc.encode(sseData));
      };

      let content = '';
      let reasoning: string | null = null;
      let reasoningDetails: any[] | null = null;
      let toolCalls: any[] | null = null;
      let annotations: any[] | null = null;

      let functionCall: any = null;
      if (responseData?.choices && responseData.choices[0]) {
        const choice = responseData.choices[0];
        content = choice.message?.content || '';
        reasoning = choice.message?.reasoning || null;
        reasoningDetails = choice.message?.reasoning_details || null;
        toolCalls = choice.message?.tool_calls || null;
        functionCall = choice.message?.function_call || null;
        annotations = choice.message?.annotations || null;
      } else if (responseData && typeof responseData === 'object' && 'text' in responseData) {
        content = typeof responseData.text === 'string' ? responseData.text : '';
        reasoning = typeof responseData.reasoning === 'string' ? responseData.reasoning : null;
        reasoningDetails = Array.isArray((responseData as any).reasoning_details) ? (responseData as any).reasoning_details : null;
        annotations = Array.isArray(responseData.annotations) ? responseData.annotations : null;
        toolCalls = Array.isArray(responseData.tool_calls) ? responseData.tool_calls : null;
        functionCall = (responseData as any).function_call || null;
      } else if (typeof responseData === 'string') {
        content = responseData;
      }

      if (reasoning) {
        for (let i = 0; i < reasoning.length; i += chunkSize) {
          const reasoningChunkText = reasoning.slice(i, i + chunkSize);
          const reasoningChunk = {
            choices: [
              {
                delta: {
                  reasoning: reasoningChunkText,
                },
                finish_reason: null,
              },
            ],
            model: responseData.model,
            id: responseData.id,
          };
          enqueueSSE(reasoningChunk);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      if (reasoningDetails && reasoningDetails.length > 0) {
        const reasoningDetailsChunk = {
          choices: [
            {
              delta: {
                reasoning_details: reasoningDetails,
              },
              finish_reason: null,
            },
          ],
          model: responseData.model,
          id: responseData.id,
        };
        enqueueSSE(reasoningDetailsChunk);
        await new Promise((r) => setTimeout(r, delayMs));
      }

      for (let i = 0; i < content.length; i += chunkSize) {
        const contentChunk = content.slice(i, i + chunkSize);
        const chunk = {
          choices: [
            {
              delta: {
                content: contentChunk,
              },
              finish_reason: null,
            },
          ],
          model: responseData.model,
          id: responseData.id,
        };
        enqueueSSE(chunk);
        await new Promise((r) => setTimeout(r, delayMs));
      }

      if (annotations && annotations.length > 0) {
        const annotationsChunk = {
          choices: [
            {
              delta: {
                annotations: annotations,
              },
              finish_reason: null,
            },
          ],
          model: responseData.model,
          id: responseData.id,
        };
        enqueueSSE(annotationsChunk);
        await new Promise((r) => setTimeout(r, delayMs));
      }

      if (toolCalls && toolCalls.length > 0) {
        const indexedToolCalls = toolCalls.map((call, index) => {
          if (!call || typeof call !== 'object') return call;
          if (typeof (call as any).index === 'number') return call;
          return { ...call, index };
        });
        const toolCallChunk = {
          choices: [
            {
              delta: {
                tool_calls: indexedToolCalls,
              },
              finish_reason: 'tool_calls',
            },
          ],
          model: responseData.model,
          id: responseData.id,
        };
        enqueueSSE(toolCallChunk);
      }

      if (functionCall && typeof functionCall === 'object') {
        const functionCallChunk = {
          choices: [
            {
              delta: {
                function_call: functionCall,
              },
              finish_reason: 'function_call',
            },
          ],
          model: responseData.model,
          id: responseData.id,
        };
        enqueueSSE(functionCallChunk);
      }

      const finishReason = responseData.choices?.[0]?.finish_reason || 'stop';
      const finalChunk = {
        choices: [
          {
            delta: {},
            finish_reason: finishReason,
          },
        ],
        model: responseData.model || 'unknown',
        id: responseData.id || 'mobile-response',
      };
      enqueueSSE(finalChunk);

      enqueueSSE('data: [DONE]\n\n');
      controller.close();
    },
  });
}
