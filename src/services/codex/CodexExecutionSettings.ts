import type { SystemSculptSettings } from '../../types';
import { hasHostCapability } from '../../platform/hostCapabilities';
import { isAbsoluteFilesystemPath, resolveAbsoluteVaultPath } from '../../utils/vaultPathUtils';
import type { App } from 'obsidian';

export function usesLocalCodex(settings: Pick<SystemSculptSettings, 'textExecutionBackend'> | undefined): boolean {
  return settings?.textExecutionBackend === 'codex' && hasHostCapability('local-cli');
}
export function defaultTextBackend(settings: Pick<SystemSculptSettings, 'textExecutionBackend'>): 'codex' | 'systemsculpt' {
  return usesLocalCodex(settings) ? 'codex' : 'systemsculpt';
}
export function codexVaultDirectory(app: App): string {
  return codexWorkingDirectory(app, '.');
}
/** Persist vault-relative paths; resolve only on the machine executing the task. */
export function codexWorkingDirectory(app: App, configuredPath: string): string {
  if (!hasHostCapability('local-cli')) throw new Error('On-machine Codex requires Obsidian Desktop. Choose SystemSculpt API in Chat settings on this device.');
  const configured = configuredPath.trim() || '.';
  if (isAbsoluteFilesystemPath(configured)) return configured;
  const path = resolveAbsoluteVaultPath(app.vault.adapter, configured);
  if (!path) throw new Error('The vault’s local directory could not be resolved.');
  return path;
}

export type CodexExecutionOptions = { model?: string; effort?: string; serviceTier?: string };
export function resolveCodexOptions(options: CodexExecutionOptions): Required<CodexExecutionOptions> {
  const model = options.model?.trim() || 'gpt-6-astra';
  const effort = options.effort?.trim() || 'high';
  const serviceTier = options.serviceTier?.trim() || 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) throw new Error('Invalid Codex model.');
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('Invalid Codex thinking level.');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(serviceTier)) throw new Error('Invalid Codex speed mode.');
  return { model, effort, serviceTier };
}
export function codexOptionsFromSettings(settings: SystemSculptSettings): Required<CodexExecutionOptions> {
  return resolveCodexOptions({ model: settings.codexModel, effort: settings.codexThinkingLevel, serviceTier: settings.codexServiceTier });
}
