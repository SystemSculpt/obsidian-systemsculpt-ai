import { SystemSculptError, ERROR_CODES, ErrorCode, getErrorMessage, isAuthFailureMessage } from "../utils/errors";

const IMAGE_UNSUPPORTED_PATTERNS = [
  "does not support image",
  "image input not supported",
  "vision not supported",
  "unknown field: image_url",
  "additional properties are not allowed: 'image_url'",
  "unsupported type: image_url",
  "model does not support vision",
  "multimodal input not supported",
  "image_url is not supported",
  "content type image_url not supported",
];

const CONTENT_STRING_MISMATCH_PATTERNS = [
  "must be a string",
  "must be string",
  "should be a string",
  "should be string",
  "expected string",
  "expected a string",
  "is not of type string",
  "is not a string",
];

const MESSAGE_CONTENT_PATTERNS = [
  /messages\[\d+\]\.content/,
  /messages\.\d+\.content/,
  /message content/,
];

const isImageUnsupportedMessage = (message: string): boolean => {
  const lc = (message || "").toLowerCase();
  if (!lc) return false;

  if (IMAGE_UNSUPPORTED_PATTERNS.some((pattern) => lc.includes(pattern))) {
    return true;
  }

  const hasContentMismatch = CONTENT_STRING_MISMATCH_PATTERNS.some((pattern) => lc.includes(pattern));
  if (!hasContentMismatch) {
    return false;
  }

  if (MESSAGE_CONTENT_PATTERNS.some((pattern) => pattern.test(lc))) {
    return true;
  }

  return lc.includes("messages") && lc.includes("content");
};

/**
 * Helper class for handling streaming errors
 */
export class StreamingErrorHandler {
  /**
   * Handle streaming errors
   */
  public static async handleStreamError(
    response: Response,
    isCustomProvider = false,
    context?: {
      provider?: string;
      endpoint?: string;
      model?: string;
    }
  ): Promise<never> {
    try {
      let data: any;
      try {
        const text = await response.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: { message: (typeof text === 'string' && text.trim().length > 0) ? text : 'Unknown error' } };
        }
        try {
          const errorMsg = data?.error?.message || data?.message || data?.error;
          const metadata = data?.error?.metadata || data?.metadata;
          console.error('[SystemSculpt][StreamingErrorHandler] API error response', {
            status: response.status,
            isCustomProvider,
            errorMessage: errorMsg,
            errorCode: data?.error?.code,
            errorType: data?.error?.type,
            metadata: metadata
          });
          console.error('[SystemSculpt][StreamingErrorHandler] Full error JSON:', JSON.stringify(data, null, 2));
        } catch {}
      } catch (err) {
        throw new SystemSculptError(
          "Error processing response from API",
          ERROR_CODES.STREAM_ERROR,
          response.status
        );
      }

      let errorCode: ErrorCode = ERROR_CODES.STREAM_ERROR;
      let errorMessage = "Unknown error";
      let metadata: any = {};
      let shouldResubmit = false;
      const requestId = data?.request_id || data?.requestId || data?.error?.request_id;
      const errorType = data?.error?.type;
      const errorHttpCode = data?.error?.http_code;

      if (isCustomProvider) {
        if (typeof data?.error === "string") {
          data.error = { message: data.error };
        }

        if (!data?.error) {
          const fallbackMessage =
            typeof data?.message === "string"
              ? data.message
              : typeof data?.detail === "string"
                ? data.detail
                : Array.isArray(data?.errors)
                  ? data.errors
                      .map((entry: any) => entry?.message || entry?.detail || entry)
                      .filter((entry: any) => typeof entry === "string" && entry.trim().length > 0)
                      .join("; ")
                  : "";
          if (fallbackMessage && fallbackMessage.trim().length > 0) {
            data.error = { message: fallbackMessage };
          }
        }
      }

      if (data.error) {
        if (isCustomProvider) {
          const status = response.status;
          let model: string | undefined = data.model;
          const upstreamMessage =
            typeof data.error?.message === 'string' ? data.error.message.trim() : '';
          const authFailure = isAuthFailureMessage(upstreamMessage);
          const authStatus = status === 401 || status === 403;

          if (!model && typeof data.error?.message === 'string') {
            const match = data.error.message.match(/model\s+`?([\w\-\.\/]+)`?/i);
            if (match && match[1]) {
              model = match[1];
            }
          }

          if (!model && typeof data.error?.model === 'string' && data.error.model.trim().length > 0) {
            model = data.error.model.trim();
          }

          if (!model && typeof data.error?.data?.model === 'string' && data.error.data.model.trim().length > 0) {
            model = data.error.data.model.trim();
          }

          if (!model) {
            model = 'unknown';
          }

          if (authFailure || authStatus) {
            errorCode = ERROR_CODES.INVALID_LICENSE;
            errorMessage = upstreamMessage || 'Invalid API key or authentication error.';
          } else if (status === 404 || (upstreamMessage.includes('model') && upstreamMessage.includes('does not exist'))) {
            errorCode = ERROR_CODES.MODEL_UNAVAILABLE;
            errorMessage = upstreamMessage || `Model ${model} is unavailable with this provider.`;
            shouldResubmit = true;
          } else if (status === 429) {
            errorCode = ERROR_CODES.QUOTA_EXCEEDED;
            errorMessage = data.error.message || 'Rate limit or quota exceeded. Please try again later.';
          } else {
            errorCode = (data.error.code || ERROR_CODES.STREAM_ERROR) as ErrorCode;
            errorMessage = data.error.message || 'An error occurred with the provider.';
            if (errorMessage.includes('unavailable') || errorMessage.includes('not found') || upstreamMessage.includes('not found')) {
              shouldResubmit = true;
            }
          }

          metadata = {
            provider: data.provider || context?.provider || 'unknown',
            model,
            statusCode: status,
            rawError: data.error,
            upstreamMessage,
            ...(requestId ? { requestId } : {}),
            ...(errorType ? { errorType } : {}),
            ...(errorHttpCode ? { errorHttpCode } : {}),
            ...(context?.endpoint ? { endpoint: context.endpoint } : {})
          };
          if (shouldResubmit) {
            metadata.shouldResubmit = true;
          }
          const lcCustom = ((data.error?.message || errorMessage) || '').toLowerCase();
          if (
            lcCustom.includes('does not support tools') ||
            lcCustom.includes('tools not supported') ||
            lcCustom.includes('tool calling not supported') ||
            lcCustom.includes('tool calling is not supported') ||
            lcCustom.includes('tool_calls not supported') ||
            lcCustom.includes('function calling not supported') ||
            lcCustom.includes('function_calling not supported') ||
            lcCustom.includes('function_call not supported') ||
            lcCustom.includes("additional properties are not allowed: 'tools'") ||
            lcCustom.includes('unknown field: tools') ||
            lcCustom.includes('input_schema does not support oneof') ||
            lcCustom.includes('input_schema does not support anyof') ||
            lcCustom.includes('input_schema does not support allof') ||
            // OpenRouter-specific patterns
            lcCustom.includes('no endpoints found') ||
            lcCustom.includes('endpoints found that support tool') ||
            lcCustom.includes('does not support function calling') ||
            lcCustom.includes('model does not support tool use') ||
            lcCustom.includes('unsupported parameter: tools') ||
            (lcCustom.includes('extra fields not permitted') && lcCustom.includes('tools'))
          ) {
            metadata.shouldResubmitWithoutTools = true;
            metadata.toolSupport = false;
          }
          // Detect image input rejection for non-vision models
          if (isImageUnsupportedMessage(lcCustom)) {
            metadata.shouldResubmitWithoutImages = true;
            metadata.imageSupport = false;
          }
          if (lcCustom.includes('invalid chat setting')) {
            metadata.invalidChatSettings = true;
          }
          if (context?.model && (!metadata.model || metadata.model === 'unknown')) {
            metadata.model = context.model;
          }
        } else {
          // Handle SystemSculpt API errors (including OpenRouter upstream errors)
          const status = response.status;

          // Normalize both object and string shapes from server { error: { code, message } } or { error: "INTERNAL_ERROR", message: "..." }
          const isStringError = typeof data.error === 'string';
          const upstreamCode = isStringError ? String(data.error) : String(data.error?.code || '');
          const upstreamMessage = isStringError ? (data.message || '') : (data.error?.message || '');
          const normalizedUpstreamCode = upstreamCode.trim().toLowerCase();

          const asNumber = (value: unknown): number => {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string') {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) return parsed;
            }
            return 0;
          };

          if (normalizedUpstreamCode === 'insufficient_credits') {
            errorCode = ERROR_CODES.INSUFFICIENT_CREDITS;
            errorMessage = upstreamMessage || getErrorMessage(errorCode);
            metadata = {
              model: data.model,
              statusCode: status,
              rawError: data.error,
              creditsRemaining: asNumber((data.error as any)?.credits_remaining),
              cycleEndsAt: String((data.error as any)?.cycle_ends_at || ''),
              purchaseUrl: typeof (data.error as any)?.purchase_url === 'string' ? (data.error as any).purchase_url : null,
              ...(requestId ? { requestId } : {}),
              ...(context?.endpoint ? { endpoint: context.endpoint } : {}),
            };
          } else if (normalizedUpstreamCode === 'turn_in_flight') {
            errorCode = ERROR_CODES.TURN_IN_FLIGHT;
            errorMessage = upstreamMessage || getErrorMessage(errorCode);
            metadata = {
              model: data.model,
              statusCode: status,
              rawError: data.error,
              lockUntil: String((data.error as any)?.lock_until || ''),
              ...(requestId ? { requestId } : {}),
              ...(context?.endpoint ? { endpoint: context.endpoint } : {}),
            };
          } else {
            errorCode = (isStringError ? ERROR_CODES.STREAM_ERROR : (data.error.code || ERROR_CODES.STREAM_ERROR)) as ErrorCode;
            errorMessage = upstreamMessage || getErrorMessage(errorCode);

            // Check for 429 rate limiting errors specifically
            if (status === 429 || errorMessage.includes('rate-limited') || errorMessage.includes('429')) {
              errorCode = ERROR_CODES.QUOTA_EXCEEDED;
              // Enhance error message with retry guidance
              errorMessage = errorMessage.includes('rate-limited upstream') 
                ? errorMessage + ' OpenRouter is automatically trying alternative providers.'
                : 'Rate limit exceeded. Please try again in a moment.';
              metadata = {
                model: data.model,
                statusCode: status,
                rawError: data.error,
                isRateLimited: true,
                shouldRetry: true,
                retryAfterSeconds: 5 // Suggest 5 second retry delay
              };
            } else {
              metadata = {
                model: data.model,
                statusCode: status,
                rawError: data.error,
                ...(isStringError && { upstreamCode }),
                ...(requestId ? { requestId } : {}),
                ...(errorType ? { errorType } : {}),
                ...(errorHttpCode ? { errorHttpCode } : {}),
                ...(context?.endpoint ? { endpoint: context.endpoint } : {})
              };
              if (context?.model && !metadata.model) {
                metadata.model = context.model;
              }

              if (status === 404 ||
                  errorCode === ERROR_CODES.MODEL_UNAVAILABLE ||
                  errorMessage.includes('unavailable') ||
                  errorMessage.includes('not found')) {
                metadata.shouldResubmit = true;
              }
              const lcUpstream = (errorMessage || '').toLowerCase();
              if (
                lcUpstream.includes('does not support tools') ||
                lcUpstream.includes('tools not supported') ||
                lcUpstream.includes('tool calling not supported') ||
                lcUpstream.includes('tool calling is not supported') ||
                lcUpstream.includes('tool_calls not supported') ||
                lcUpstream.includes('function calling not supported') ||
                lcUpstream.includes('function_calling not supported') ||
                lcUpstream.includes('function_call not supported') ||
                lcUpstream.includes("additional properties are not allowed: 'tools'") ||
                lcUpstream.includes('unknown field: tools') ||
                // OpenRouter-specific patterns
                lcUpstream.includes('no endpoints found') ||
                lcUpstream.includes('endpoints found that support tool') ||
                lcUpstream.includes('does not support function calling') ||
                lcUpstream.includes('model does not support tool use') ||
                lcUpstream.includes('unsupported parameter: tools') ||
                (lcUpstream.includes('extra fields not permitted') && lcUpstream.includes('tools'))
              ) {
                (metadata as any).shouldResubmitWithoutTools = true;
                (metadata as any).toolSupport = false;
              }

              // Detect upstream rejection of image input for non-vision models
              if (isImageUnsupportedMessage(lcUpstream)) {
                (metadata as any).shouldResubmitWithoutImages = true;
                (metadata as any).imageSupport = false;
              }
            }
          }
        }
      }
      
      throw new SystemSculptError(
        errorMessage,
        errorCode,
        response.status,
        metadata
      );
    } catch (error) {
      if (error instanceof SystemSculptError) {
        throw error;
      }

      throw new SystemSculptError(
        `Stream error (HTTP ${response.status})`,
        ERROR_CODES.STREAM_ERROR,
        response.status
      );
    }
  }
}
