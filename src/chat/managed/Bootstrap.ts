import type { PlatformRequestClient } from '../../services/PlatformRequestClient';
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  parseThinAgentBootstrapRequest,
  parseThinAgentBootstrapResponse,
  type ThinAgentBootstrapRequest,
  type ThinAgentBootstrapResponse,
} from '../../services/managed/ThinAgentV1Contract';
import { readBoundedText, responseErrorPayload } from './ManagedHttpResponse';

const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;
type BootstrapOptions = Readonly<{
  baseUrl: string;
  pluginVersion: string;
  licenseKey: () => string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  requestClient: Pick<PlatformRequestClient, 'request'>;
}>;

/** One licensed, bounded, identity-bound exchange; ticket caching belongs to the transport. */
export async function requestAgentBootstrap(options: BootstrapOptions, presentation: 'chat' | 'context' = 'chat'): Promise<ThinAgentBootstrapResponse> {
  const request = parseThinAgentBootstrapRequest(options.bootstrapRequest());
  const response = await options.requestClient.request({
    url: new URL(THIN_AGENT_BOOTSTRAP_PATH, options.baseUrl).toString(),
    method: 'POST',
    headers: { 'x-plugin-version': options.pluginVersion },
    licenseKey: options.licenseKey(),
    body: request,
    allowTransportFallback: true,
    responseEncoding: 'arrayBuffer',
    maxResponseBytes: MAX_BOOTSTRAP_RESPONSE_BYTES,
  });
  if (!response.ok) {
    const payload = presentation === 'chat' ? await responseErrorPayload(response) : {};
    const message = presentation === 'chat' ? `SystemSculpt could not start this chat (${response.status}).`
      : response.status === 429 ? 'SystemSculpt is receiving too many requests. Try again shortly.'
      : `SystemSculpt could not start the response (${response.status}).`;
    const code = presentation === 'chat' ? payload.code
      : response.status === 429 ? 'response_start_rate_limited' : 'response_start_failed';
    throw Object.assign(new Error(message), {
      ...(code ? { code } : {}),
      ...(payload.incidentId ? { requestId: payload.incidentId } : {}),
      status: response.status,
      retryable: response.status === 401 || response.status === 429 || response.status >= 500,
    });
  }
  const value = JSON.parse(await readBoundedText(response, MAX_BOOTSTRAP_RESPONSE_BYTES)) as unknown;
  return parseThinAgentBootstrapResponse(value, { conversation_id: request.conversation_id });
}
