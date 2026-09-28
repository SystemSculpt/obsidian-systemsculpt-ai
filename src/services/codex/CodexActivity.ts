import { isRecord } from '../../studio/utils';
import type { CodexJson } from './CodexAppServer';

export type CodexActivity = { id: string; kind: 'command' | 'file' | 'tool' | 'plan' | 'message'; title: string; detail: string; status: string; at: string };
/** Public messages, plans and tool activity only. Reasoning internals are never projected. */
export function codexActivity(method: string, params: CodexJson): CodexActivity | null {
  const at = new Date().toISOString();
  if (method === 'turn/plan/updated' && Array.isArray(params.plan)) return {
    id: 'plan', kind: 'plan', title: 'Plan', status: 'inProgress', at,
    detail: params.plan.filter(isRecord).slice(0, 30).map(step => `${String(step.status)} · ${String(step.step)}`).join('\n').slice(0, 8000),
  };
  if (!['item/started', 'item/completed'].includes(method) || !isRecord(params.item)) return null;
  const item = params.item, status = String(item.status || (method === 'item/completed' ? 'completed' : 'inProgress'));
  const common = { id: String(item.id || `${String(item.type)}:${at}`), status, at };
  if (item.type === 'commandExecution') return { ...common, kind: 'command', title: String(item.command || 'Command').slice(0, 300), detail: String(item.aggregatedOutput || '').slice(-8000) };
  if (item.type === 'fileChange') return { ...common, kind: 'file', title: 'File changes', detail: (Array.isArray(item.changes) ? item.changes.filter(isRecord).slice(0, 30).map(change => String(change.path)) : []).join('\n').slice(0, 8000) };
  if (item.type === 'agentMessage') return { ...common, kind: 'message', title: 'Codex', detail: String(item.text || '').slice(-8000) };
  if (item.type === 'plan') return { ...common, kind: 'plan', title: 'Plan', detail: String(item.text || '').slice(0, 8000) };
  if (['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'].includes(String(item.type))) return { ...common, kind: 'tool', title: String(item.tool || item.type).slice(0, 300), detail: String(item.query || item.server || '').slice(0, 2000) };
  return null;
}
