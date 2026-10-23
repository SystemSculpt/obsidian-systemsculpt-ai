import type { SystemSculptSettings } from '../../types';
import { hasHostCapability } from '../../platform/hostCapabilities';
import { detectLocalAgents } from './LocalAgentDetection';
import { isLocalAgentId, type TextExecutionBackend } from './LocalAgents';

type BackendSettings = Pick<SystemSculptSettings, 'textExecutionBackend' | 'textExecutionBackendExplicit' | 'licenseKey' | 'licenseValid' | 'subscriptionStatus'>;

/** Detection is a default, never a replacement for a person's choice or paid hosted chat. */
export async function resolveDefaultChatBackend(
  settings: BackendSettings,
  readBalance: () => Promise<{ includedCreditsEntitled?: boolean }>,
  workingDirectory?: string,
): Promise<TextExecutionBackend> {
  if (!hasHostCapability('local-cli')) return 'systemsculpt';
  const selected = settings.textExecutionBackend;
  if (settings.textExecutionBackendExplicit || isLocalAgentId(selected)) {
    return isLocalAgentId(selected) ? selected : 'systemsculpt';
  }
  if (settings.licenseKey?.trim()) {
    if (settings.licenseValid || settings.subscriptionStatus === 'active' || settings.subscriptionStatus === 'lifetime') return 'systemsculpt';
    try {
      if ((await readBalance()).includedCreditsEntitled === true) return 'systemsculpt';
    } catch {
      // An offline account check is not evidence that a paid plan has ended.
      return 'systemsculpt';
    }
  }
  return (await detectLocalAgents({ workingDirectory })).preferred;
}
