import { SystemSculptError, ERROR_CODES, ErrorCode, getErrorMessage } from "../utils/errors";

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

      if (data.error) {
        if (isCustomProvider) {
          const status = response.status;
          let model: string | undefined = data.model;
          const upstreamMessage =
            typeof data.error?.message === 'string' ? data.error.message.trim() : '';

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

          if (status === 404 || (upstreamMessage.includes('model') && upstreamMessage.includes('does not exist'))) {
            errorCode = ERROR_CODES.MODEL_UNAVAILABLE;
            errorMessage = upstreamMessage || `Model ${model} is unavailable with this provider.`;
            shouldResubmit = true;
          } else if (status === 429) {
            errorCode = ERROR_CODES.QUOTA_EXCEEDED;
            errorMessage = data.error.message || 'Rate limit or quota exceeded. Please try again later.';
          } else if (status === 401) {
            errorCode = ERROR_CODES.INVALID_LICENSE;
            errorMessage = data.error.message || 'Invalid API key or authentication error.';
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
          if (
            lcCustom.includes('does not support image') ||
            lcCustom.includes('image input not supported') ||
            lcCustom.includes('vision not supported') ||
            lcCustom.includes("unknown field: image_url") ||
            lcCustom.includes("additional properties are not allowed: 'image_url'") ||
            lcCustom.includes('unsupported type: image_url') ||
            // OpenRouter-specific patterns
            lcCustom.includes('model does not support vision') ||
            lcCustom.includes('multimodal input not supported') ||
            lcCustom.includes('image_url is not supported') ||
            lcCustom.includes('content type image_url not supported')
          ) {
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
            if (
              lcUpstream.includes('does not support image') ||
              lcUpstream.includes('image input not supported') ||
              lcUpstream.includes('vision not supported') ||
              lcUpstream.includes("unknown field: image_url") ||
              lcUpstream.includes("additional properties are not allowed: 'image_url'") ||
              lcUpstream.includes('unsupported type: image_url') ||
              // OpenRouter-specific patterns
              lcUpstream.includes('model does not support vision') ||
              lcUpstream.includes('multimodal input not supported') ||
              lcUpstream.includes('image_url is not supported') ||
              lcUpstream.includes('content type image_url not supported')
            ) {
              (metadata as any).shouldResubmitWithoutImages = true;
              (metadata as any).imageSupport = false;
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
