import { resolveCodexOptions, type CodexExecutionOptions } from '../services/codex/CodexExecutionSettings';
import type { StudioNodeInstance } from './types';
import { isRecord } from './utils';

export type StudioCommandExecution = { model: string; effort: string };
export function readStudioCommandExecution(value: unknown): StudioCommandExecution {
  if (value !== undefined && (!isRecord(value) || typeof value.model !== 'string' || typeof value.effort !== 'string')) throw new Error('Choose a model and reasoning level.');
  // Preserve Command Center's launch defaults for cards without a saved selection.
  const options = resolveCodexOptions(isRecord(value) ? { model: String(value.model), effort: String(value.effort) } : { model: 'gpt-6-astra', effort: 'high' });
  return { model: options.model, effort: options.effort };
}
/** Command Center owns launch settings; child runs retain the parent's launch snapshot. */
export function studioAgentExecution(nodes: StudioNodeInstance[], nodeId: string, fallback: CodexExecutionOptions, parent?: CodexExecutionOptions): CodexExecutionOptions {
  const centers = nodes.filter(node => node.kind === 'studio.command_center');
  if (parent && centers.length) return { model: parent.model, effort: parent.effort, serviceTier: 'default' };
  const center = centers.find(node => isRecord(node.config.actions) && Array.isArray(node.config.actions.items) && node.config.actions.items.some(action => isRecord(action) && action.kind === 'run' && action.target === nodeId));
  return center ? { ...readStudioCommandExecution(center.config.execution), serviceTier: 'default' } : fallback;
}
