import type { SystemSculptSettings } from '../../types';
import { hasHostCapability } from '../../platform/hostCapabilities';
import { desktopHost } from '../../platform/desktopOnly';
import { isAbsoluteFilesystemPath, resolveAbsoluteVaultPath } from '../../utils/vaultPathUtils';
import type { App } from 'obsidian';
import { isLocalAgentId, type LocalAgentId, type TextExecutionBackend } from './LocalAgents';
import { resolveCodexApprovalMode, type CodexApprovalMode } from './CodexApprovalPolicy';

/** The selected on-machine agent, or null where none can run (mobile falls back to SystemSculpt API). */
export function localTextAgent(settings: Pick<SystemSculptSettings, 'textExecutionBackend'> | undefined): LocalAgentId | null {
  const backend = settings?.textExecutionBackend;
  return isLocalAgentId(backend) && hasHostCapability('local-cli') ? backend : null;
}
export function defaultTextBackend(settings: Pick<SystemSculptSettings, 'textExecutionBackend'>): TextExecutionBackend {
  return localTextAgent(settings) ?? 'systemsculpt';
}
export function codexVaultDirectory(app: App): string {
  return codexWorkingDirectory(app, '.');
}
/** Chat launches from the real current vault root, matching native absolute tool paths. */
export async function localAgentChatDirectory(app: App): Promise<string> {
  const root = codexVaultDirectory(app);
  // Resolve only host-owned root metadata, never a native-requested path or file contents.
  return (await desktopHost.fs()).realpath(root);
}
/** Detection can still find PATH installs when a host has no local vault path. */
export function localAgentDetectionDirectory(app: App): string | undefined {
  if (!hasHostCapability('local-cli')) return undefined;
  try { return codexVaultDirectory(app); } catch { return undefined; }
}
/** Persist vault-relative paths; resolve only on the machine executing the task. */
export function codexWorkingDirectory(app: App, configuredPath: string): string {
  if (!hasHostCapability('local-cli')) throw new Error('On-machine agents require Obsidian Desktop. Choose SystemSculpt API in Chat settings on this device.');
  const configured = configuredPath.trim() || '.';
  if (isAbsoluteFilesystemPath(configured)) return configured;
  const path = resolveAbsoluteVaultPath(app.vault.adapter, configured);
  if (!path) throw new Error('The vault’s local directory could not be resolved.');
  return path;
}

export type CodexExecutionOptions = { model?: string; effort?: string; serviceTier?: string };
export function resolveCodexOptions(options: CodexExecutionOptions): Required<CodexExecutionOptions> {
  // Empty selections inherit the installed Codex's own configuration.
  const model = options.model?.trim() || '';
  const effort = options.effort?.trim() || '';
  const serviceTier = options.serviceTier?.trim() || 'default';
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) throw new Error('Invalid Codex model.');
  if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('Invalid Codex thinking level.');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(serviceTier)) throw new Error('Invalid Codex speed mode.');
  return { model, effort, serviceTier };
}
export function codexOptionsFromSettings(settings: SystemSculptSettings & { codexApprovalMode?: string }): Required<CodexExecutionOptions> & { approvalMode: CodexApprovalMode } {
  return { ...resolveCodexOptions({ model: settings.codexModel, effort: settings.codexThinkingLevel, serviceTier: settings.codexServiceTier }),
    approvalMode: resolveCodexApprovalMode(settings.codexApprovalMode) };
}
